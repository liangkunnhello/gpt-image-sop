import type { ApiProfile } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'
import type { ExpectText, QcOutcome } from './batchCheck'

/** 质检默认模型；调用处可覆盖 */
export const DEFAULT_QC_MODEL = 'deepseek-v4.1-flash'

/** 质检检查项，对应配置弹窗里的三个勾选 */
export interface QcChecks {
  violation: boolean
  text: boolean
  overlap: boolean
  /** 用户自己加的检查项：启用中的才会进提示词 */
  rules?: QcRule[]
}

/**
 * 一条自定义检查项。
 *
 * 内置的三项（违规 / 文字 / 压叠）在提示词里是固定文案，用户只能开关；
 * 想加自己的判据（例如「画面不许出现按钮」「品牌 logo 不许变形」）就用这个：
 * 模型逐条判断，结论放在 custom_items 里，任何一条不通过整张图就判不合格。
 */
export interface QcRule {
  id: string
  /** 规则名，展示用，也会出现在模型回答与详情页里 */
  name: string
  /** 判定标准：什么样算不通过，模型照着这一句判 */
  detail: string
  enabled: boolean
}

export const DEFAULT_QC_CHECKS: QcChecks = { violation: true, text: true, overlap: true }

const SYSTEM_PROMPT = [
  '你是广告投放前的图片质检员，只做判断，不改图。',
  '判断三件事：一，画面是否含违规内容（色情暴露、暴力血腥、政治敏感、未成年人不良形象、医疗功效夸大或承诺治愈）；',
  '二，图上文字与「应出现的文案」是否一致，抓出错字、多字、少字、整条缺失；',
  '三，画面上是否存在压叠与遮挡：文字与文字重叠、文字被任何元素遮住（人物、产品、Logo、水印、角标、'
  + '装饰图形、色块都算）、文字被裁出画面边缘。',
  '注意：图上的 Logo、水印、角标、装饰条、色块通常是后期用模板叠上去的，它们浮在画面之上；'
  + '这类元素只要压到文字（哪怕只盖住一部分笔画、哪怕那些字还能读出来），一律算压叠，'
  + '不要因为它们看起来「自然」「像设计的一部分」就放过。',
  '只依据图上实际可见的内容作答，不推测、不补全。看不清写进 reason，不要当成「没有」。',
  '必须输出单个扁平 JSON 对象，字段一个不少，不要嵌套，不要 markdown 代码块，不要任何解释文字。',
].join('')

const SCHEMA = '{"violation_pass":true,"violation_items":[],"text_pass":true,"found":[],"missing":[],"wrong":[],"extra":[],"overlap_pass":true,"overlap_spots":[],"custom_items":[{"id":"规则id","pass":true,"note":""}],"verdict":"pass","confidence":0.9,"reason":"一句话"}'

/** 可用的自定义规则：名字和判定标准都填了才算 */
export function activeQcRules(rules: QcRule[] | undefined): QcRule[] {
  return (rules ?? []).filter((rule) => rule.enabled && rule.name.trim() && rule.detail.trim())
}

/** 导出供单测：验证自定义规则有没有真的写进提示词 */
export function buildQcPrompt(expect: ExpectText, strict: boolean, checks: QcChecks) {
  const hasText = Boolean(expect.mainTitle || expect.tags.length)
  const rules = activeQcRules(checks.rules)
  // 关掉的检查项不进提示词，模型只判要查的部分，未开启的项目对应的 *_pass 一律给 true
  const enabled = [
    checks.violation ? '违规内容' : '',
    checks.text ? '文字一致性' : '',
    checks.overlap ? '文字压叠' : '',
    ...rules.map((rule) => rule.name.trim()),
  ].filter(Boolean)
  const lines = ['检查这张图。']
  lines.push('', `本次只检查：${enabled.join('、') || '无（全部记为通过）'}。未列出的项目一律视为通过。`)
  if (!checks.text) {
    lines.push('不要逐字核对文案，text_pass 直接给 true，missing / wrong / extra 给空数组。')
  } else if (hasText) {
    lines.push('', '【应出现的文案】')
    if (expect.mainTitle) lines.push(`主标题：${expect.mainTitle}`)
    if (expect.tags.length) lines.push(`标签：${expect.tags.join(' / ')}`)
    if (expect.brand.length) lines.push(`品牌标识：${expect.brand.join(' / ')}`)
    if (expect.disclaimer.length) lines.push(`免责小字：${expect.disclaimer.join(' / ')}`)
    lines.push('', '主标题和标签必须逐字一致。免责小字字号很小，读不出时在 reason 里注明「小字不可辨」，不算错字。')
    // 被遮挡导致的读不清，属于压叠问题：记成「缺失/错字」会掩盖真正原因，还会把好图误判成文案错
    lines.push('若某个字是被其它元素盖住才看不清，不要记成 missing 或 wrong，按遮挡处理并在 reason 里写清楚。')
  } else {
    lines.push('本图不要求出现任何文字。若图上有文字，记入 extra。')
  }
  if (!checks.violation) lines.push('不做违规判断，violation_pass 给 true。')
  if (!checks.overlap) {
    lines.push('不做压叠判断，overlap_pass 给 true，overlap_spots 给空数组。')
  } else {
    lines.push(
      '',
      '【压叠与遮挡怎么判】',
      '1. 文字与文字重叠、同一句出现两层（描边重影、错位复制）算不合格。',
      '2. 文字被任何图形元素遮住都算不合格：Logo、水印、角标、按钮形色块、装饰条、贴纸、'
      + '色块蒙版、人物或产品轮廓都算，遮住多少都算 —— 只要压到笔画就不通过。',
      '   检查顺序照这个走，别只看画面中间：先看四个角和上下边缘（Logo、角标、水印、警示语最常叠在那儿），'
      + '逐个确认它们有没有压到文字；再看标题、卖点这些大字有没有被任何图形盖住；最后看文字之间有没有重叠。',
      '3. 标题、卖点这类主要文字被遮住任何一部分，即使整句仍然读得出来，也判 overlap_pass=false：'
      + '在投放素材里它就是「字被盖住了」，不能因为「还认得出」放行。',
      '4. 文字贴到画面边缘被裁掉一部分，同样算不合格。',
      '5. 不算压叠的情况只有一种：文字与其它元素没有遮挡关系（文字在纯色底上、挨得近但没被盖住、'
      + '有意的压字排版）。除此之外一律按遮挡算。',
      'overlap_spots 要写清「哪个字被什么盖住、盖在哪」，'
      + '例如「顶部大标题『为爱续航』左起第 2、3 字被左上角 Logo 盖住下半部」。',
    )
  }
  if (rules.length) {
    lines.push('', '【额外检查项】逐条判：通过 pass 给 true；不通过 pass 给 false，并在 note 里写清看到什么。id 必须原样带回，一条都不能漏。')
    rules.forEach((rule, index) => {
      lines.push(`${index + 1}. id=${rule.id}｜${rule.name.trim()}：${rule.detail.trim()}`)
    })
    lines.push('这些额外检查项任意一条不通过，verdict 就是 fail，并在 reason 里点名是哪条没通过。')
  }
  lines.push('', 'found 填图上实际读到的文字；missing 填应有但没找到的；wrong 填「应为X实为Y」；extra 填规范外多出来的；overlap_spots 填压字位置描述。')
  // reason 是用户唯一会看的「为什么不合格」。不约束就会套模板，几十张图理由一模一样
  lines.push(
    'reason 必须写这张图自己的具体问题，禁止套模板：',
    '- 不要写「画面文字与应出现文案不一致」这类结论式空话；',
    '- 要写清「哪一句 / 哪个字 / 哪个位置」，例如「主标题第 3 字『续』印成『读』」、',
    '「漏了卖点『带病投保也能赔』」「左上角 Logo 压住副标题前两字」；',
    '- 有多处问题时逐条写，用分号隔开；',
    '- 不合格但确实找不到具体问题时，写清你查过什么、哪一处拿不准。',
  )
  lines.push('verdict 取 pass / fail / unsure；拿不准一律 unsure，不要硬判 pass。')
  if (strict) lines.push('', '上一次输出不是合法 JSON。这次只输出一行 JSON，不要换行，不要代码块。')
  lines.push('', '输出结构：', SCHEMA)
  return lines.join('\n')
}

/** 浏览器端缩图：4K 原图直接送会很慢，压到长边 1400 后再传，判定结果不受影响 */
export function shrinkDataUrl(dataUrl: string, max = 1400, quality = 0.88) {
  return new Promise<string>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      if (scale >= 1 && dataUrl.length < 600_000) {
        resolve(dataUrl)
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function parseLoose(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  const sliced = cleaned.slice(start)
  try {
    return JSON.parse(sliced)
  } catch {}
  // 括号配平，截取第一个完整对象
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = 0; i < sliced.length; i += 1) {
    const c = sliced[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(sliced.slice(0, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 导出供单测：验证自定义检查项的解析与「任一条不通过就判不合格」 */
export function qcOutcomeFromRaw(raw: Record<string, unknown> | null, fallback: string): QcOutcome {
  if (!raw) {
    return {
      verdict: 'error', violationPass: false, textPass: false, overlapPass: false,
      spots: [], missing: [], wrong: [], extra: [], custom: [], reason: fallback, confidence: null,
    }
  }
  const custom = Array.isArray(raw.custom_items)
    ? raw.custom_items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : String(item.id ?? ''),
        pass: item.pass !== false,
        note: typeof item.note === 'string' ? item.note : '',
      }))
      .filter((item) => item.id)
    : []
  const modelVerdict = raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'unsure'
  const overlapPass = raw.overlap_pass !== false
  // 判否必须体现在结论上：文字被盖住、被规则点名不合格，都是废图。
  // 模型有时会写出 overlap_pass=false 却 overall 给 pass（"整体还行"），以判定项为准。
  const verdict = modelVerdict === 'pass' && (!overlapPass || custom.some((item) => !item.pass))
    ? 'fail'
    : modelVerdict
  return {
    verdict,
    violationPass: raw.violation_pass !== false,
    textPass: raw.text_pass !== false,
    overlapPass,
    spots: Array.isArray(raw.overlap_spots) ? raw.overlap_spots.map(String).filter(Boolean) : [],
    missing: Array.isArray(raw.missing) ? raw.missing.map(String) : [],
    wrong: Array.isArray(raw.wrong) ? raw.wrong.map(String) : [],
    extra: Array.isArray(raw.extra) ? raw.extra.map(String) : [],
    custom,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
  }
}

/** 在浏览器里直接调视觉模型做质检，不经过任何本地服务 */
export async function qcInBrowser(
  profile: ApiProfile,
  dataUrl: string,
  expect: ExpectText,
  options: { model?: string; checks?: QcChecks } = {},
): Promise<QcOutcome> {
  const model = options.model?.trim() || DEFAULT_QC_MODEL
  const checks = options.checks ?? DEFAULT_QC_CHECKS
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const url = buildApiUrl(profile.baseUrl, 'chat/completions', proxyConfig, useApiProxy)
  const image = await shrinkDataUrl(dataUrl)

  const send = async (strict: boolean, withFormat: boolean) => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildQcPrompt(expect, strict, checks) },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 1000,
      stream: false,
      thinking: { type: 'disabled' },
    }
    if (withFormat) body.response_format = { type: 'json_object' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(60, profile.timeout) * 1000)
    try {
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const message = await getApiErrorMessage(res)
        return { error: `HTTP ${res.status}：${message}` }
      }
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      return { content: String(json.choices?.[0]?.message?.content ?? '') }
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    let result = await send(false, true)
    // 部分模型不认 response_format，去掉再试一次
    if (result.error?.startsWith('HTTP 400')) result = await send(false, false)
    if (result.error) return qcOutcomeFromRaw(null, result.error)
    let parsed = parseLoose(result.content || '')
    if (!parsed) {
      const retry = await send(true, false)
      if (retry.error) return qcOutcomeFromRaw(null, retry.error)
      parsed = parseLoose(retry.content || '')
    }
    return qcOutcomeFromRaw(parsed, '模型没有返回可解析的 JSON')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return qcOutcomeFromRaw(null, message.includes('abort') ? '请求超时' : message)
  }
}
