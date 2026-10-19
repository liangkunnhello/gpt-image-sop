import type { ApiProfile } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'
import type { ExpectText, QcOutcome } from './batchCheck'

/** 质检默认模型；调用处可覆盖 */
export const DEFAULT_QC_MODEL = 'deepseek-v4.1-flash'

const SYSTEM_PROMPT = [
  '你是广告投放前的图片质检员，只做判断，不改图。',
  '判断三件事：一，画面是否含违规内容（色情暴露、暴力血腥、政治敏感、未成年人不良形象、医疗功效夸大或承诺治愈）；',
  '二，图上文字与「应出现的文案」是否一致，抓出错字、多字、少字、整条缺失；',
  '三，文字之间、文字与人物主体之间是否压叠到读不清。',
  '只依据图上实际可见的内容作答，不推测、不补全。看不清写进 reason，不要当成「没有」。',
  '必须输出单个扁平 JSON 对象，字段一个不少，不要嵌套，不要 markdown 代码块，不要任何解释文字。',
].join('')

const SCHEMA = '{"violation_pass":true,"violation_items":[],"text_pass":true,"found":[],"missing":[],"wrong":[],"extra":[],"overlap_pass":true,"overlap_spots":[],"verdict":"pass","confidence":0.9,"reason":"一句话"}'

function buildPrompt(expect: ExpectText, strict: boolean) {
  const hasText = Boolean(expect.mainTitle || expect.tags.length)
  const lines = ['检查这张图。']
  if (hasText) {
    lines.push('', '【应出现的文案】')
    if (expect.mainTitle) lines.push(`主标题：${expect.mainTitle}`)
    if (expect.tags.length) lines.push(`标签：${expect.tags.join(' / ')}`)
    if (expect.brand.length) lines.push(`品牌标识：${expect.brand.join(' / ')}`)
    if (expect.disclaimer.length) lines.push(`免责小字：${expect.disclaimer.join(' / ')}`)
    lines.push('', '主标题和标签必须逐字一致。免责小字字号很小，读不出时在 reason 里注明「小字不可辨」，不算错字。')
  } else {
    lines.push('本图不要求出现任何文字。若图上有文字，记入 extra。')
  }
  lines.push('', 'found 填图上实际读到的文字；missing 填应有但没找到的；wrong 填「应为X实为Y」；extra 填规范外多出来的；overlap_spots 填压字位置描述。')
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

function toOutcome(raw: Record<string, unknown> | null, fallback: string): QcOutcome {
  if (!raw) {
    return {
      verdict: 'error', violationPass: false, textPass: false, overlapPass: false,
      missing: [], wrong: [], extra: [], reason: fallback, confidence: null,
    }
  }
  const verdict = raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'unsure'
  return {
    verdict,
    violationPass: raw.violation_pass !== false,
    textPass: raw.text_pass !== false,
    overlapPass: raw.overlap_pass !== false,
    missing: Array.isArray(raw.missing) ? raw.missing.map(String) : [],
    wrong: Array.isArray(raw.wrong) ? raw.wrong.map(String) : [],
    extra: Array.isArray(raw.extra) ? raw.extra.map(String) : [],
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
  }
}

/** 在浏览器里直接调视觉模型做质检，不经过任何本地服务 */
export async function qcInBrowser(
  profile: ApiProfile,
  dataUrl: string,
  expect: ExpectText,
  model = DEFAULT_QC_MODEL,
): Promise<QcOutcome> {
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
            { type: 'text', text: buildPrompt(expect, strict) },
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
    if (result.error) return toOutcome(null, result.error)
    let parsed = parseLoose(result.content || '')
    if (!parsed) {
      const retry = await send(true, false)
      if (retry.error) return toOutcome(null, retry.error)
      parsed = parseLoose(retry.content || '')
    }
    return toOutcome(parsed, '模型没有返回可解析的 JSON')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return toOutcome(null, message.includes('abort') ? '请求超时' : message)
  }
}
