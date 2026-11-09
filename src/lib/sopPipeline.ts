import type { ApiProfile, ImageFidelity, InputImage, TaskParams } from '../types'
import { createSopPlaceholder, removeSopPlaceholder, submitSopTasks, updateTaskInStore, useStore } from '../store'
import { recordLineage } from './trackDb'
import { useSopStore } from './sopStore'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'
import { resolvePostTemplates } from './applyPostTemplate'
import { avoidZoneSummary, buildAvoidHint, pickAvoidTemplate } from './postReserve'
import { dedupePrompts } from './copyDedupe'
import { checkPromptCopy } from './copyCheck'
import { describeBlocks, keepIndexes, proofreadPrompts } from './promptProofread'
import { variationCandidates } from './promptVariation'
import { clampPromptCount, PROMPTS_PER_BATCH } from './promptLimits'
import { buildSopImageHint, planSopImages, withSopImageHint } from './sopImages'
import { ensureImageCached } from './imageCache'

/** 生成 SOP 与提示词所用的文本模型 */
export const SOP_TEXT_MODEL = 'deepseek-v4.1-flash'

/**
 * 提示词排版优化要针对的模型族。命中时额外注入「禁精确坐标 + 排版话术逐条变化」规则。
 *
 * 实测（同一份 SOP 各跑 30 条）：
 * - deepseek-v4.1-flash：30 条开场句完全一样，主标题措辞 30 条全是「特粗深棕黑体左对齐」，
 *   结尾 40 字有 8 条逐字相同；大量写「0%~17%×0%~30%」这类精确框，生图模型并不执行。
 * - gemini-3.8-flash：开场句 27 种写法，排版措辞 4 种，没有固定句式复读。
 *
 * 所以只对前者生效，别的模型保持原行为，避免把本来表现好的模型也约束坏。
 */
const LAYOUT_OPTIMIZED_MODELS = ['deepseek-v4.1', 'dsv4.1']

/** 这个模型是否需要排版专项优化（按模型名匹配，不看 profile 名字） */
export function needsLayoutOptimize(model: string | undefined): boolean {
  if (!model) return false
  const name = model.toLowerCase()
  return LAYOUT_OPTIMIZED_MODELS.some((item) => name.includes(item))
}

/** 反推 / 写提示词真正会用的模型：profile 指定的优先，没填才落到默认 */
export function resolveSopTextModel(profile: ApiProfile): string {
  return (profile.sopTextModel || '').trim() || SOP_TEXT_MODEL
}

/** 送模型前统一缩到长边 1024，参考图再多也不会撑爆请求体 */
const MODEL_MAX_SIDE = 1024
/** 超过这个张数时进一步降到 768，优先保证请求能发出去 */
const MANY_IMAGE_THRESHOLD = 16

/** 浏览器端缩图，返回 jpeg data URL */
export function shrinkToDataUrl(dataUrl: string, max: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.86))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/**
 * 一轮纯文本/多模态对话，返回助手消息正文。
 * 导出给「优化提示词」这类单轮改写用，复用同一套代理 / 降级 / thinking 关闭逻辑。
 */
export async function chat(
  profile: ApiProfile,
  messages: unknown[],
  timeoutSeconds = 240,
  /** 输出上限：写提示词时按条数放大，避免大数量被截断 */
  maxTokens = 4000,
  /** 采样温度：反推 SOP 要稳，写多条提示词时要放开，否则后半段会抄前面 */
  temperature = 0.4,
): Promise<string> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const url = buildApiUrl(profile.baseUrl, 'chat/completions', proxyConfig, useApiProxy)

  /** 发一轮请求；max_tokens 被上游判超限时返回 400，由调用方决定是否降级 */
  const send = async (limit: number) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
    try {
      return await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
        cache: 'no-store',
        body: JSON.stringify({
          // 优先用配置里指定的反推/写提示词模型
          model: profile.sopTextModel || SOP_TEXT_MODEL,
          messages,
          temperature,
          max_tokens: limit,
          stream: false,
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  let res = await send(maxTokens)
  /**
   * 有些渠道把输出上限写死得比我们要求的低，按原值再要会一直 400。
   *
   * 原来是「一次降到 4000」—— 但 4000 连 8 条 SOP 提示词都写不完（8×900=7200），
   * 降级后必然整批被截断，等于用 400 换了半批废图。改成逐级对半降：
   * 只在低于「够写完这一批」的值时才停，宁可少给几条也不给到写不完的量。
   */
  let limit = maxTokens
  while (res.status === 400 && limit > 4000) {
    limit = Math.max(4000, Math.floor(limit / 2))
    res = await send(limit)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}：${await getApiErrorMessage(res)}`)
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = String(json.choices?.[0]?.message?.content ?? '').trim()
  if (!content) throw new Error('模型返回了空内容')
  return content
}

/**
 * 写提示词时每条预留的输出预算。
 *
 * 原来写 500，注释还写着「一条约 150~250 字」—— 但实际上这批 SOP 写出来的
 * 每条是 **380~460 字中文**（实测 sop-mw05c4zr-2nol 的 26 条正常提示词），
 * 中文按 1 字≈1.5~2 token 算，一条就要 600~900 token。
 *
 * 预算给不到就出现「写到一半被熔断」：那批 30 条里有 4 条被截断
 * （idx 24 只写了 48 个字就断在「暖阳米黄色调」），断点全在「写第几张卡片文案」的位置。
 * 900 是实测需求的上界，再留一点余量给模型发挥。
 */
const TOKENS_PER_PROMPT = 900
/** 单次请求的输出上限天花板。16000 对 30 条已经不够（30×900=27000），放到 32000 */
const MAX_OUTPUT_TOKENS = 32000

/** 按要写的条数算出这次请求的输出上限，条数越多给得越多 */
export function tokensForPrompts(count: number): number {
  const need = Math.max(1, Math.round(count) || 1) * TOKENS_PER_PROMPT
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(4000, need))
}

/** 把列表尽量平均分成 groups 组，先分的组多分余数 */
export function splitEven<T>(items: T[], groups: number): T[][] {
  const size = Math.max(1, Math.min(groups, items.length || 1))
  const base = Math.floor(items.length / size)
  const extra = items.length % size
  const out: T[][] = []
  let cursor = 0
  for (let i = 0; i < size; i += 1) {
    const take = base + (i < extra ? 1 : 0)
    out.push(items.slice(cursor, cursor + take))
    cursor += take
  }
  return out
}

/** 反推 SOP 的公共规则；有图/无图两种来源共用，避免两份规则写岔 */
function sopRuleLines(ignoreCompliance: boolean, useImageSellingPoints: boolean, avoidCta = false, avoidZones = '') {
  return [
    ignoreCompliance
      ? '参考图上的品牌 logo、水印、免责声明、风险提示、「请见条款及投保须知」「本素材纯属广告创意」这类合规小字，一律不要写进 SOP，也不要要求在生成的图上出现。'
      : '',
    useImageSellingPoints
      ? ''
      : '不要从参考图上提取或复用卖点文案。SOP 的文字规范只描述文字的层级、字号与排布方式，具体文案以用户提供的卖点为准。',
    avoidCta
      ? '参考图里的按钮、悬浮球、进度条、返回箭头、开关、卡片跳转等「仿系统界面 / 可点击」的设计元素，一律不要写进 SOP；SOP 里要明确列为禁忌：不画按钮、不画手指点击示意、不加指向性的箭头或手势，也不写「立即领取」「点击查看」「滑动解锁」「下载App」这类引导点击的文案。'
      : '',
    avoidCta
      ? '也不要写「留出按钮位置」「按钮槽位」「CTA 区」「空按钮」这类要求：按钮位不是版面元素，画面上出现空白胶囊、空白长条、带描边的空白圆角块，就等于画了一只没有文字的按钮。卖点列表下面直接收尾，用留白或装饰图形结束，不要给按钮留坑。'
      : '',
    avoidZones
      ? `版式结构里必须给后期预留区留出干净背景，把这些位置让出来、不安排主体、标题文字、图标或装饰块：${avoidZones}。注意是让版式自然避开，不是画一个空白边框或空块去「占位」。`
      : '',
    '文字规范要按卖点条数定义槽位：有几条卖点就排几个文字位，不要设计固定数量的装饰性文字位；卖点少于槽位时删掉多余槽位或改用图形、留白，不能靠重复同一句卖点把版面填满。',
    '必须写「变量池」：按场景、机位、主体、色调四个维度，列出这份 SOP 允许使用的具体取值，每个维度至少 4 个。优先从用户给的候选里挑，删掉与参考图冲突的，再补上参考图里体现的行业特有取景；不要照抄候选全表。',
    '必须写「互斥规则」：用可执行的条款写清同一批提示词之间怎么避重 —— 任意两条至少在场景、机位、主体、色调中的两项上不同；相邻两条不得使用同一机位或同一色调；不得靠替换形容词冒充差异；一批里同一场景出现次数不超过该批条数的一半。',
  ].filter(Boolean)
}

/** 发散机制的两节：无论系统提示词怎么定义结构，这两节都要保留 */
export const VARIATION_SECTIONS = ['变量池', '互斥规则']

/** 系统提示词里没有定义小节时用的默认结构 */
export const DEFAULT_SOP_SECTIONS = [
  'SOP 名称',
  '适用场景',
  '版式结构',
  '画面元素',
  '文字规范',
  '配色与光线',
  '必守与禁忌',
  ...VARIATION_SECTIONS,
]

/**
 * 取出「系统提示词」那一段。
 * buildPromptBundle 会把三份包成 `# 文案…` / `# 系统提示词（…）` / `# 风格` 三段，
 * 直接扫全文标题会把「文案」「风格」也当成 SOP 小节。
 */
function systemPromptBody(text: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^#\s*系统提示词/.test(line))
  if (start < 0) return text
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    // 下一个一级标题或合并用的分隔线就是这一段结束
    if (/^#\s/.test(line) || /^-{3,}$/.test(line.trim())) break
    body.push(line)
  }
  return body.join('\n')
}

/**
 * SOP 的输出结构由系统提示词决定：系统提示词里写了哪些小节，反推出的 SOP 就输出哪些小节。
 * 只取最外层标题（# 最少的那些），避免把 ## 下面 ### 的子项也当成小节；
 * 系统提示词里没有任何标题时退回默认 7 节。
 */
export function sopSectionsFrom(systemPrompt: string): string[] {
  const body = systemPromptBody(systemPrompt || '')
  const headings: Array<{ level: number; name: string }> = []
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (match) headings.push({ level: match[1].length, name: match[2].trim() })
  }
  if (!headings.length) return DEFAULT_SOP_SECTIONS
  const shallowest = Math.min(...headings.map((item) => item.level))
  const names = headings.filter((item) => item.level === shallowest).map((item) => item.name)
  if (!names.length) return DEFAULT_SOP_SECTIONS
  // 变量池与互斥规则是发散机制的载体，用户没自己写就追加在末尾
  const missing = VARIATION_SECTIONS.filter((name) => !names.includes(name))
  return [...names, ...missing]
}

/** 拼「输出哪些小节」这一段；结构来自系统提示词 */
function sopFormatLines(sections: string[]): string[] {
  const list = sections.map((name) => `## ${name}`).join('、')
  return [
    `输出 Markdown，必须包含以下小节，标题文字与顺序都照此执行：${list}。`,
    '不要输出任何解释性开场白。',
  ]
}

/**
 * 参考图分组：只按用户选的卡数均分，不再因为超过 16 张而自动多分卡。
 *
 * 参考图只用于反推 SOP / 提取变量，不进生图接口，所以不存在「一个请求塞不下」的硬限制。
 * 拖了 40 张又选了「1 张卡」，就是这 40 张一起送去反推，而不是被悄悄切成 3 张卡。
 * 想拆成多张卡请在上层直接选卡数（perImage / 自定义）。
 */
export function splitReferenceGroups<T>(items: T[], groups: number): T[][] {
  return splitEven(items, groups)
}

/** 反推 SOP 的系统提示词；单独导出便于测试哪些规则被写进去了 */
export function buildSopSystemPrompt(
  ignoreCompliance: boolean,
  useImageSellingPoints: boolean,
  avoidCta = false,
  /** 输出小节，来自系统提示词；不传时用默认 7 节 */
  sections: string[] = DEFAULT_SOP_SECTIONS,
  /** 后期预留区摘要（如「左上角（后期叠Logo）」）：反推时就让版式避开 */
  avoidZones = '',
) {
  return [
    '你是广告设计团队的资深生图指导。用户会给你若干张参考图，你要从这些图里反推出一套可复用的「生图 SOP」。',
    'SOP 要能被另一个模型直接照着写出多条提示词，所以必须具体、可执行：写清版式结构、画面元素、文字层级、配色倾向、镜头与光线、必须出现和必须避免的东西。',
    '只描述你从参考图里真实观察到的规律，不要编造参考图里没有的品牌、价格或功效。',
    ...sopRuleLines(ignoreCompliance, useImageSellingPoints, avoidCta, avoidZones),
    ...sopFormatLines(sections),
  ].filter(Boolean).join('\n')
}

/**
 * 没有参考图时的 SOP 系统提示词：只凭卖点与风格要求设计一份文字版 SOP。
 * 与有图版本的差别只在「来源」——规则与输出格式完全一致，保证后续写提示词不用分叉。
 */
export function buildTextSopSystemPrompt(
  ignoreCompliance: boolean,
  useImageSellingPoints: boolean,
  avoidCta = false,
  /** 输出小节，来自系统提示词；不传时用默认 7 节 */
  sections: string[] = DEFAULT_SOP_SECTIONS,
  avoidZones = '',
) {
  return [
    '你是广告设计团队的资深生图指导。本次用户没有提供参考图，只给了卖点文案与风格要求，你要仅凭这些文字设计出一套可复用的「生图 SOP」。',
    'SOP 要能被另一个模型直接照着写出多条提示词，所以必须具体、可执行：写清版式结构、画面元素、文字层级、配色倾向、镜头与光线、必须出现和必须避免的东西。',
    '所有画面设定都必须能用用户给的卖点与风格要求推出来，不要编造用户没提到的品牌、价格、功效、认证或数据。',
    ...sopRuleLines(ignoreCompliance, useImageSellingPoints, avoidCta, avoidZones),
    ...sopFormatLines(sections),
  ].filter(Boolean).join('\n')
}

/** 第一步：参考图 + 系统提示词 → 生图 SOP */
export interface RewriteResult {
  /** 模型给的新名称，解析不到时为空串 */
  name: string
  content: string
}

/**
 * 让模型按一句话要求同时改写「名称 + 正文」，用于卖点 / 风格 / 系统提示词的「AI 修改」。
 * 输出约定：第一行是名称，空一行，之后是正文。
 */
export async function rewriteText(
  profile: ApiProfile,
  original: string,
  instruction: string,
  currentName = '',
): Promise<RewriteResult> {
  const system = [
    '你是资深广告文案编辑。用户会给你一段原文（可能带现有名称）和一条修改要求，你要按要求同时改写名称和正文。',
    '输出格式必须严格是：第一行只写新的名称（不超过 16 个字，不要写「标题：」这类前缀）；第二行空一行；从第三行开始是新的正文。',
    '不要输出任何解释、不要加引号、不要用小标题、不要用代码块包裹。',
    '除非修改要求明确要求增删，否则保留原文的结构、关键信息和语气。',
  ].join('\n')
  const user = [
    currentName.trim() ? `【现有名称】\n${currentName.trim()}` : '',
    `【原文】\n${original.trim()}`,
    `【修改要求】\n${instruction.trim()}`,
  ].filter(Boolean).join('\n\n')

  const raw = await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])

  // 必须出现「名称 + 空行 + 正文」才算解析成功，否则整段当正文，名称交给调用方兜底
  const cut = raw.indexOf('\n\n')
  if (cut < 0) return { name: '', content: raw.trim() }
  const nameLine = raw.slice(0, cut).trim()
    .replace(/^(标题|名称)[:：]\s*/, '')
    .replace(/^#+\s*/, '')
    .replace(/^[「『"']|[」』"']$/g, '')
    .trim()
  const content = raw.slice(cut).trim()
  if (!content) return { name: '', content: raw.trim() }
  return { name: nameLine, content }
}

/**
 * SOP 的「AI 修改」：按一句话要求改写整份 SOP 正文。
 *
 * 和 rewriteText 的区别：SOP 本身是一份带「## SOP 名称」小节的 Markdown，
 * 名称就写在正文里，不能套用「第一行名称 + 空行 + 正文」的输出约定
 * （那样解析出来的名称行会被当成正文的一部分，标题被消掉或写重复）。
 * 所以这里只要求返回正文，名称沿用原文里那一节。
 */
export async function rewriteSopText(
  profile: ApiProfile,
  original: string,
  instruction: string,
): Promise<string> {
  const system = [
    '你是广告设计团队的资深生图指导。用户会给你一份「生图 SOP」（Markdown）和一条修改要求，你要按要求改写这份 SOP。',
    // 结构由这份 SOP 自己决定（源头是系统提示词），这里只要求原样保留
    '必须保持原文已有的小节结构与标题文字，顺序也不要改；原文没有的小节不要新增。',
    '只输出改写后的完整 SOP 正文，从第一个「## 」标题行开始，不要写任何解释、开场白或结束语，也不要用代码块包裹。',
    '除非修改要求明确要求增删，否则保留原文里已有的具体数值、比例、字号和禁忌条目。',
  ].join('\n')
  const user = [
    `【原文】\n${original.trim()}`,
    `【修改要求】\n${instruction.trim()}`,
  ].join('\n\n')

  const raw = await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])

  // 模型偶尔会用代码块包一层，去掉再判断
  let content = raw.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim()
  // 没输出小节结构时退回原文，避免把一份好 SOP 换成一段散文；
  // 结构本身由系统提示词决定，所以只要有任何一级/二级标题就认
  if (!/^#{1,3}\s+\S/m.test(content)) {
    throw new Error('模型返回的内容不像 SOP，已放弃这次改动')
  }
  return content
}

export async function generateSop(
  profile: ApiProfile,
  /** 系统提示词 + 卖点 + 风格合成的一份文档 */
  systemPrompt: string,
  imageDataUrls: string[],
  ignoreCompliance = true,
  useImageSellingPoints = false,
  /** 卖点原文：有就要求原样抄进 SOP 的文字规范 */
  copyText = '',
  /** 避免按钮等引导点击的仿系统界面设计 */
  avoidCta = false,
  /** 后期预留区摘要：反推 SOP 时就让版式避开，避免写完提示词再强行避让 */
  avoidZones = '',
): Promise<string> {
  const maxSide = imageDataUrls.length > MANY_IMAGE_THRESHOLD ? 768 : MODEL_MAX_SIDE
  const images = await Promise.all(imageDataUrls.map((url) => shrinkToDataUrl(url, maxSide)))
  // 输出哪些小节由系统提示词决定，没定义就用默认 7 节
  const sections = sopSectionsFrom(systemPrompt)

  // 没有参考图：仅凭系统提示词与卖点反推文字版 SOP，规则与有图版一致
  if (!images.length) {
    return chat(profile, [
      { role: 'system', content: buildTextSopSystemPrompt(ignoreCompliance, useImageSellingPoints, avoidCta, sections, avoidZones) },
      {
        role: 'user',
        content: [
          '根据下面的要求与卖点，设计一套生图 SOP。',
          systemPrompt.trim() ? `\n【用户给定的要求与文案】\n${systemPrompt.trim()}` : '',
          `\n${variationCandidates()}`,
          copyText.trim()
            ? '\n注意：「文案」那一段是要印在图上、必须逐字使用的文字，请原样抄进 SOP 的文字规范里，不要改写或省略。'
            : '',
          '\n本次没有任何参考图，请完全依据上面的文字设计 SOP。',
        ].filter(Boolean).join('\n'),
      },
    ])
  }

  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        '根据下面这些参考图，反推一套生图 SOP。',
        systemPrompt.trim() ? `\n【用户给定的要求与文案】\n${systemPrompt.trim()}` : '',
        `\n${variationCandidates()}`,
        copyText.trim()
          ? '\n注意：「文案」那一段是要印在图上、必须逐字使用的文字，请原样抄进 SOP 的文字规范里，不要改写或省略。'
          : '',
        `\n共 ${images.length} 张参考图，请提炼它们的共同规律。`,
      ].filter(Boolean).join('\n'),
    },
  ]
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })

  return chat(profile, [
    { role: 'system', content: buildSopSystemPrompt(ignoreCompliance, useImageSellingPoints, avoidCta, sections, avoidZones) },
    { role: 'user', content },
  ])
}

/**
 * 排版专项优化规则：只对 needsLayoutOptimize 命中的模型注入。
 *
 * 这两条针对的是实测确认的两个毛病：
 * ① 写精确百分比坐标（「0%~17%×0%~30%」）—— 生图模型根本不认这种框，
 *    写了等于白写，还挤占了真正能执行的「左上角留空」描述；
 * ② 排版话术逐条复读 —— 同一条句式抄 30 遍，排版看起来毫无变化。
 */
function layoutOptimizeRules(): string[] {
  return [
    '【不要写坐标数字】不要用百分比、像素、坐标区间来描述位置（例如「横向 0%~17%、纵向 0%~30%」「左侧 45%」）。生图模型不执行这种数字框，写了只是浪费篇幅。位置一律用可执行的空间语言描述：左上角、右下角、画面中上部、左侧文字区、右侧插画区、贴着底边等。',
    '【排版话术必须逐条不同】禁止在多条提示词里复用同一套排版句式。每条的「文字区怎么排」都要换一种说法与侧重点，例如：稳重的左对齐单栏、主标题顶格卖点等距下排、主标题略偏上留出呼吸、卖点小一号紧随其后、文字整体靠左成一组、上下分组隔一层空白等。同一批里相邻两条不得用同一种排法描述，也不要把同一句原话重复给不同条。',
    '【排版只写生图模型能落地的信息】写清四件事就够了：文字块落在哪个区域、整体是左对齐还是居中、主标题与卖点的大小关系、卖点下方怎么收尾（留白 / 图形 / 色块）。不要写字号数值、行距数值、字重英文名、字体文件名。',
  ]
}

function promptSystem(ignoreCompliance: boolean, avoidHint = '', hasCopy = false, avoidCta = false, hasImage = false, hasRequirement = false, layoutOptimize = false, hasPeople = true) {
  return [
    '你是广告生图提示词工程师。用户会给你一份生图 SOP，你要严格按这份 SOP 写出指定数量的具体提示词。',
    hasImage
      ? '这批提示词会带底图出图，所以你写的是「在底图上怎么改、怎么加」，不是从零开始画一张新图；每条仍要能独立送进生图模型，写清改完之后的画面应该是什么样。'
      : hasPeople
        ? '每条提示词必须能独立送进文生图模型，包含完整的画面描述：版式、场景、人物、色调、光线、以及图上应有的文字（用「」包裹）。'
        : '每条提示词必须能独立送进文生图模型，包含完整的画面描述：版式、场景、主体形态、色调、光线、以及图上应有的文字（用「」包裹）。',
    /**
     * 无人的 SOP 必须单独钉一条。
     *
     * 只把要素清单里的「人物」换成「主体形态」还不够 —— 模型会把
     * 「有个人物更吸引人」当成广告常识自己补上去。实测纯文字大字报 SOP
     * 写出的 35 条提示词里有 20 条被塞了「独居中年男士」「青年女性」这类写实人物，
     * 出图就全是真人。
     */
    hasPeople
      ? ''
      : '【这份 SOP 里没有人物】SOP 的画面元素里没有任何人物，任何一条提示词都不许出现人、真人、模特、人像、背影、手部动作；也不许自行添加 SOP 没有列出的道具、建筑或场景元素，主体只能用 SOP 里写到的那几种。',
    hasImage
      ? '【底图优先于想象】不要重复描述底图里已经确定的产品外形、包装文字、品牌标识与底纹，也不要写出与底图矛盾的结构（比如底图是竖版就不要写横版通栏）。'
      : '',
    hasImage
      ? '【用户要求优先于底图】用户给出的文案、额外要求与保真档优先级最高：与底图冲突时以用户要求为准，不要为了贴合底图牺牲用户要求。'
      : '',
    hasRequirement
      ? '【本次要求必须落到每一条】用户会在末尾给出【本次要求】，那是他这次亲自写的、优先级最高的一条：每条提示词都要体现它，与 SOP 的既有写法冲突时以它为准。'
      : '',
    '发散按 SOP 里的「变量池」和「互斥规则」执行：每条从变量池里取用取值，同一批之间按互斥规则避重；不要自己另立一套维度，也不要把互斥规则当成建议。',
    avoidHint
      ? '如果给出了【画面预留区】，每条提示词都要写清主体、主要文字和关键视觉安排在预留区之外，并明确说明这些区域留白或保持干净背景。'
      : '',
    hasCopy
      ? '【文案唯一来源】用户会单独给出「卖点文案」。每张图都要把这份卖点用全，图上出现的所有文字必须逐字照抄这份卖点，不得改写、缩写、扩写、合并或新增；SOP、参考图里的文案与它冲突时一律以卖点文案为准。'
      : '',
    hasCopy
      ? '【括号里的内容也是文案】卖点里括号中的说明（如「(责任内)」）是那句话自带的限定语，属于原文，必须逐字跟在各自那句的后面写出来；不许当成注释、补充说明、免责声明或合规小字删掉，也不许只保留其中一处。'
      : '',
    hasCopy
      ? '【卖点在各图之间保持一致】所有提示词用的都是同一份卖点：每张图都要把这份卖点完整地用一遍，不能这张图只用前两条、那张图只用后两条，也不许某张图漏掉某一句。各图之间的差别只体现在场景、机位、人物、配色和版式上，文字内容逐张一致。'
      : '',
    hasCopy
      ? '【同一张图里不许重复卖点】同一句卖点在一张图上只能出现一次：主标题用掉一句，其他文字位就放别的卖点，不要重复、不要换个说法再写一遍、不要拆成两行重复。版式里的文字位比卖点多时，直接删掉多余的文字位（用图形、色块或留白补位），绝对不能拿同一句卖点去填满版面。'
      : '',
    hasCopy
      ? '【括号说明不算重复】判断「重复」只看括号外的正文：两句不同的卖点各自带同一个括号说明（如都以「(责任内)」结尾）时，那两处括号说明都算各自的原文，必须两处都写出来，不许去重、不许只留一处。'
      : '',
    hasCopy
      ? '【版式随卖点条数走】每条提示词先数清楚这份卖点有几条，再决定版面：3 条卖点就排 3 个文字位（主标题 + 副标题 + 角标），不要设计第 4 个装饰性文字位；卖点只有 1 条时就用单一大标题撑版面，把版面让给主视觉。'
      : '',
    hasCopy
      ? '【SOP 禁忌与卖点冲突时以卖点为准】SOP 里如果写了「画面不出现任何文字 / 不出现文案 / 纯画面」这类禁忌，它针对的是 logo、水印、二维码这些元素，不包括卖点文案 —— 卖点文字仍必须逐字排进画面。'
      : '',
    ignoreCompliance
      ? '不要写品牌 logo、免责声明、风险提示、警示语、合规说明，也不要写「请见条款及投保须知」「本素材纯属广告创意」这类附加小字。'
      : '',
    avoidCta
      ? '画面里不要出现按钮、悬浮球、进度条、返回箭头、开关等仿系统界面的可点击控件，也不要写「立即领取」「点击查看」「滑动解锁」「下载App」这类引导点击的文案，不要画手指点击示意或指向性箭头。'
      : '',
    avoidCta
      ? '不要留「按钮位置」：空白胶囊、空白长条、带描边的空白圆角块都算按钮。SOP 里如果写了「留出按钮位置 / 按钮槽位 / 按钮文案 / CTA 区」，一律不执行——那种「预留位」在成图里就是一只没有文字的按钮，是废图。'
      : '',
    '画面文字必须单层、实心、清晰：不要重影、错位复制、描边偏移、描边叠影这类「叠字」效果，同一个字不要画两遍。',
    hasPeople
      ? '多条之间要在场景、机位、人物、色调上做出区分，不能只是换几个词。'
      : '多条之间要在场景、机位、主体形态、色调上做出区分，不能只是换几个词。',
    layoutOptimize ? layoutOptimizeRules().join('\n') : '',
    '只输出编号列表，一行一条，不要任何解释、不要小标题、不要代码块。',
  ].filter(Boolean).join('\n')
}

export interface PromptMessagesInput {
  sopText: string
  count: number
  ignoreCompliance?: boolean
  /** 后处理预留区说明：Logo、警示语这些固定位置要避开 */
  avoidHint?: string
  /** 卖点原文：单独再喂一次，避免 SOP 摘要时把文案改写或丢掉 */
  copyText?: string
  /** 避免按钮等引导点击的仿系统界面设计 */
  avoidCta?: boolean
  /**
   * 已经写好的提示词（分批写的时候传已写的那些）。
   * 只用于让模型避重 —— 条数多到一次写不完时才用得上。
   */
  existing?: string[]
  /**
   * 底图说明。非空表示这批会带底图出图，
   * 写词规则要跟着变（不重复描述底图已有的东西、用户要求优先）。
   */
  imageHint?: string
  /**
   * 输入框里写的本次要求。
   *
   * 单独再喂一次而不只靠 SOP：反推出来的 SOP 是「通用套路」，
   * 用户这句是「这次要怎么做」，后者更容易在写多条时被忽略。
   */
  userRequirement?: string
  /**
   * 这批每条已经规划好的差异化方案（见 planPromptScenes）。
   *
   * 非空时模型只负责「把指定的场景写成完整的提示词」，不再自己决定画什么 ——
   * 这样多批可以并行，撞车在规划阶段就解决掉了。
   */
  scenes?: string[]
  /**
   * 是否对该模型启用排版专项优化（见 needsLayoutOptimize）。
   * 由 generatePrompts 按实际模型名判定后传入，避免每个调用点各判一次。
   */
  layoutOptimize?: boolean
}

/** 拼「SOP → 提示词」这一轮的两条消息；单独抽出来方便测试文案优先级有没有写进去 */
/**
 * 去掉 SOP 里「给按钮留位置」这类要求。
 *
 * 反推出来的 SOP 常写成「必须留出底部按钮位置（但不生成按钮）」「按钮文案放在卡片底部」，
 * 模型会照着画一只没有文字的空白胶囊/长条 —— 那在成图里就是一只废按钮。
 * 只删同时提到「按钮/CTA/胶囊」和「留、位置、槽位、占位」的句子，
 * 「不画按钮」这类禁忌不受影响。
 */
export function stripButtonPlaceholders(sopText: string): string {
  const pattern = /(按钮|CTA|胶囊)[^。\n]*(留出|留白|位置|槽位|占位)|(预留|留出)[^。\n]*(按钮|CTA)/
  /**
   * 按**分句**删，不按整行删。
   *
   * 原来按行过滤：一行里只要出现「按钮 + 位置」，整行都没了。
   * 而 SOP 的一行常常既是按钮要求、又带着真正的版式信息
   * （「底部留白 40px，按钮位置在右下角，整体版式保持居中」）——整行删掉等于把版式也删了。
   * 更糟的是整份 SOP 写成一段（没有换行）时，一次命中会把**整份 SOP 删空**，
   * 提示词就退化成「只按系统提示词自由发挥」，看起来就是「SOP 没生效」。
   */
  const cleanedLines = sopText
    .split('\n')
    .map((line) => {
      if (!pattern.test(line)) return line
      // 分句符不只逗号：SOP 里「。必守：留出按钮位置。标题两行」这种写法很常见，
      // 只按逗号切会把后半句真正的版式要求一起带走
      const clauses = line.split(/([，,；;。])/)
      const kept: string[] = []
      for (const clause of clauses) {
        // 分隔符原样保留，只把它前面那句判断一下
        if (/^[，,；;。]$/.test(clause)) {
          kept.push(clause)
          continue
        }
        if (pattern.test(clause)) continue
        kept.push(clause)
      }
      return kept.join('')
    })
    // 只剩标点 / 分隔符的行等于空行，留着会让模型看到一串孤立的句号
    .filter((line) => !/^[\s。．.，,；;、:：!！?？\-—]*$/.test(line))
    .join('\n')

  // 兜底：删得太狠（剩不到四成）就当没删 —— 宁可留一句按钮要求，也不能把 SOP 弄丢
  return cleanedLines.length >= sopText.length * 0.4 ? cleanedLines : sopText
}

export function buildPromptMessages({
  sopText,
  count,
  ignoreCompliance = true,
  avoidHint = '',
  copyText = '',
  avoidCta = false,
  existing = [],
  imageHint = '',
  userRequirement = '',
  scenes = [],
  layoutOptimize = false,
}: PromptMessagesInput): { system: string; user: string } {
  const copy = copyText.trim()
  const tail = ignoreCompliance
    ? '\n如果 SOP 里提到 logo、免责声明、警示语、合规小字，一律忽略，不要写进任何一条提示词。'
    : ''
  const reserve = avoidHint.trim() ? `\n\n${avoidHint.trim()}` : ''
  const copyBlock = copy ? `\n\n【卖点文案（图上文字必须逐字照抄，不得改写）】\n${copy}` : ''
  const copyTail = copy
    ? '\n注意：每条提示词用的都是同一份卖点，各张图的卖点完全一致。同一张图里，一份卖点从头到尾只用一遍：一句进了主标题，就不许再出现在副标题、角标、贴片等其他文字位上，也不许换个说法或拆成两行重写。文字位数量按卖点条数来定，多出来的槽位删掉，用图形、色块或留白补位。卖点里括号中的说明（如「(责任内)」）是那句话的原文，必须逐字跟在各自那句后面；两句卖点带同一个括号说明时，那两处都要写，不算重复，也不许只留一处。'
    : ''
  // 分批写时把已写好的贴给模型：不说清楚它会从第一批的场景重头再来一遍
  const previous = existing.length
    ? `\n\n【已经写好的提示词（这一批不得与之重复：场景、机位、主体、色调至少两项要不一样，也不许换个说法重写）】\n${existing.map((item) => `- ${item.slice(0, 80)}`).join('\n')}`
    : ''
  const ctaBlock = avoidCta
    ? '\n\n【禁止按钮形占位】SOP 里凡是「留出按钮位置 / 按钮槽位 / 按钮文案 / CTA 区」的要求，一律不执行。画面里不要出现空白胶囊、空白长条、带描边的空白圆角块 —— 这种「预留位」在成图里就是一只没有文字的按钮，是废图。'
    : ''
  // 底图说明单独成块放在最后：模型对末尾的约束更敏感，写到一半忘了这层是最常见的情况
  const imageBlock = imageHint.trim() ? `\n\n${imageHint.trim()}` : ''
  // 本次要求排在 SOP 之后、图片说明之前：先读 SOP 的套路，再看这次的额外指定
  const requirement = userRequirement.trim()
    ? `\n\n【本次要求（用户输入框里写的，优先级最高）】\n${userRequirement.trim()}\n每条提示词都必须体现这条要求；与 SOP 冲突时以它为准。`
    : ''
  /**
   * 规划阶段已经把这 ${count} 条的画面方案定死了，这里只要求逐条照着写。
   *
   * 关键点：必须写明「第 N 条 = 哪个方案」。只丢一串场景而不编号的话，
   * 模型会自己重新分配，最后几条会挤到同一个场景上，并行写就白等了。
   */
  const sceneBlock = scenes.length
    ? `\n\n【这一批必须按下列画面方案逐条写，一条对应一条，顺序不得调整】\n${scenes.map((scene, index) => `${index + 1}. ${scene}`).join('\n')}\n每条都只写自己那一行的场景，不要挪用其他行的元素，也不要另起新的场景。`
    : ''
  const writeInstruction = scenes.length
    ? `按这份 SOP 写这 ${count} 条提示词：第 1 条对应上面方案的第 1 行，第 ${count} 条对应第 ${count} 行，逐条对齐。严禁合并、跳过或新增方案。`
    : `按这份 SOP 写 ${count} 条提示词，严格遵守其中的「变量池」与「互斥规则」，每条之间在场景和构图上要有明显区别。`

  return {
    system: promptSystem(ignoreCompliance, avoidHint, Boolean(copy), avoidCta, Boolean(imageBlock), Boolean(requirement), layoutOptimize, sopHasPeople(sopText)),
    user: `【生图 SOP】\n${(avoidCta ? stripButtonPlaceholders(sopText) : sopText).trim()}${copyBlock}${previous}${sceneBlock}\n\n${writeInstruction}${tail}${copyTail}${ctaBlock}${reserve}${requirement}${imageBlock}`,
  }
}

/**
 * 规划阶段：先只产出「画面方案标签」，不写正文。
 *
 * 为什么要多走这一步（原先的写法与它的毛病）：
 * 原来是顺序分批写，每批把已写好的提示词前 80 字贴给下一批「避重」。
 * 这带来两个问题：
 * 1. **必须串行** —— 后一批要等前一批写完才知道该避开什么；30 条 = 3 批串起来，
 *    光写词就要 3 分半，实测占整个准备阶段的 81%；
 * 2. **避重很弱** —— 模型只看到 80 字的开头，而且长上下文里本来就不容易守住。
 *
 * 改成「先规划、再并行」：
 * - 规划只输出 N 条短标签（每条 15~25 字，含场景/人物/色调/机位四项），
 *   输出量不到正文的 1/20，十几秒就能跑完；
 * - 撞车在标签层就能算出来（字符串相似度），当场丢掉重规划，
 *   比等到写完几百字正文再发现重复便宜得多；
 * - 标签互不重复之后，写正文的各批彼此独立，可以并行。
 */
/** SOP 里出现这些词，就认为这份 SOP 是「画面里有人物」的 */
const PEOPLE_WORDS = [
  '人物', '角色', '人像', '真人', '模特', '代言人', '职员', '顾问', '医生', '护士', '患者', '客户',
  '家庭', '夫妇', '夫妻', '母女', '父子', '情侣', '女性', '男性', '女士', '男士',
  '青年', '中年', '老年', '儿童', '宝宝', '孩子',
  '公仔', 'Q版', '背影', '侧影', '半身', '立绘', '手部', '手持',
]

/**
 * 明确「不许有人」的说法。
 *
 * 必须带动词（出现 / 画 / 生成…）才算全盘否定：
 * 「严禁出现任何人物」= 不要人；而「严禁写实人物」只是不要写实那种，
 * 画面本身是有人物的，不能因为命中一个「严禁」就把角色判没了。
 */
const NO_PEOPLE_PATTERNS = [
  /(严禁|禁止|不得|不要|不能)[^。\n]{0,12}(出现|有|画|绘制|生成|添加|加入|放)[^。\n]{0,6}(人物|人像|真人)/,
  /(无|不含|没有|不出现)[^。\n]{0,6}(人物|人像|真人)/,
]

/**
 * 判断一份 SOP 到底有没有规定人物。
 *
 * 为什么必须判：规划阶段和写词阶段的提示词里，「人物组合」原来是写死的必填项。
 * 遇到纯文字 / 纯 3D 字模的大字报 SOP（画面元素里只有立体数字、卡板、字模、剪影），
 * 模型为了满足「必须写人物组合」会自己编一个人 —— 实测 35 条里 20 条被塞进
 * 「独居中年男士」「青年女性」这类写实人物，出来的图就全是真人。
 * 所以先按 SOP 原文判断，没有人物就换成「视觉主体形态」这一维，并明确禁止加人。
 */
export function sopHasPeople(sopText: string): boolean {
  const text = sopText || ''
  if (!text.trim()) return false
  if (NO_PEOPLE_PATTERNS.some((re) => re.test(text))) return false
  return PEOPLE_WORDS.some((word) => text.includes(word))
}

/**
 * 规划阶段的系统提示词。
 *
 * hasPeople=false 时把第 ② 项从「人物组合」换成「视觉主体形态」，
 * 并明确禁止靠「加个人」制造差异 —— 否则无人的 SOP 会被硬塞真人。
 */
function scenePlanSystem(hasPeople: boolean) {
  return [
    '你是商业海报的生图策划。用户会给你一份「生图 SOP」，你要为接下来要写的 N 条提示词**各规划一个画面方案**。',
    '每条方案写成一行短标签，15~25 字，必须同时包含这四项信息：',
    '① 场景（具体地点与情境，如「城市天台花园」「居家飘窗角落」）；',
    hasPeople
      ? '② 人物组合（人数与关系，如「母女二人」「独处青年」）；'
      : '② 视觉主体形态（这一条撑画面的主体是什么、什么材质结构，如「香槟金 3D 立体数字」「白色悬浮圆角卡板」「红色镜面立体字」）；',
    '③ 主色调（如「薄荷绿配奶白」「暖橙配深棕」）；',
    '④ 机位（如「平视中景」「微俯全景」）。',
    '硬性要求：任意两条方案之间，上面四项里**至少三项不同**。只换一个色调或只换机位不算新方案。',
    hasPeople
      ? ''
      : '这份 SOP 的画面元素里没有任何人物：方案里绝对不要出现人、真人、模特、人像、背影、手部动作，也不要靠「加个人」制造差异。',
    '不要写画面细节、不要写文案、不要写排版，这些后面会按 SOP 统一处理 —— 你只负责把「拍什么」区分开。',
    '只输出编号列表，一行一条，不要小标题、不要解释、不要代码块。',
  ].filter(Boolean).join('\n')
}

/**
 * 排版专项优化版本的规划提示词：把「文字区排布形态」提为第 ⑤ 项。
 *
 * 原因：SOP 里已经写死了文字排版的强约束（主标题特粗、卖点垂直堆叠、左对齐），
 * 写正文的模型会把同一句排版描述抄 N 遍。只 forbid 复读不够 ——
 * 必须在规划阶段就给每条定一个不同的排布形态，写正文时才有话可换。
 */
function scenePlanSystemLayout(hasPeople: boolean) {
  return [
    '你是商业海报的生图策划。用户会给你一份「生图 SOP」，你要为接下来要写的 N 条提示词**各规划一个画面方案**。',
    '每条方案写成一行短标签，20~30 字，必须同时包含这五项信息：',
    '① 场景（具体地点与情境，如「城市天台花园」「居家飘窗角落」）；',
    hasPeople
      ? '② 人物组合（人数与关系，如「母女二人」「独处青年」）；'
      : '② 视觉主体形态（这一条撑画面的主体是什么、什么材质结构，如「香槟金 3D 立体数字」「白色悬浮圆角卡板」「红色镜面立体字」）；',
    '③ 主色调（如「薄荷绿配奶白」「暖橙配深棕」）；',
    '④ 机位（如「平视中景」「微俯全景」）；',
    '⑤ 文字区排布形态（这一条文字块怎么摆，如「左对齐单栏、主标题顶格、卖点等距下排」「主标题居中偏上、卖点两列并排」「文字整体靠左成一组、下方留一条空白呼吸带」「主标题与卖点左对齐、末端用色块收尾」）。',
    '硬性要求：任意两条方案之间，①~④ 里**至少三项不同**；⑤ 必须每条都不一样，不许两条用同一种排布形态。',
    '⑤ 只能用空间语言描述（左/右/上/下/居中/顶格/等距/成组/收尾方式），不要写百分比、像素、坐标区间、字号数值、行距、英文体重名。',
    hasPeople
      ? ''
      : '这份 SOP 的画面元素里没有任何人物：方案里绝对不要出现人、真人、模特、人像、背影、手部动作，也不要靠「加个人」制造差异。',
    '不要写画面细节、不要写文案，这些后面会按 SOP 统一处理 —— 你负责把「拍什么」和「文字怎么摆」都区分开。',
    '只输出编号列表，一行一条，不要小标题、不要解释、不要代码块。',
  ].filter(Boolean).join('\n')
}

/** 并行写词的批次上限：同时最多几批在飞 */
const PROMPT_WRITE_PARALLEL = 4

/** 标签相似度：按 2-gram 集合算 Jaccard，用来在规划阶段查出「换汤不换药」的方案 */
export function sceneSimilarity(a: string, b: string): number {
  const grams = (text: string) => {
    const out = new Set<string>()
    const clean = text.replace(/\s+/g, '')
    for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
    return out
  }
  const left = grams(a)
  const right = grams(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * 规划阶段产出的标签去重。
 *
 * 阈值 0.45：中文短句的 2-gram 重合度天然偏高（同一份 SOP 出来的标签都带
 * 「场景」「色调」这类词），门槛定太高会把正常的不同方案也判成重复。
 * 0.45 大约相当于「四项里只有一两项不一样」，正是要拦的情况。
 */
export function dedupeScenes(scenes: string[], threshold = 0.45): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  for (const scene of scenes) {
    const text = scene.trim()
    if (!text) continue
    if (kept.some((item) => sceneSimilarity(item, text) >= threshold)) {
      dropped.push(text)
      continue
    }
    kept.push(text)
  }
  return { kept, dropped }
}

/**
 * 规划要写多少条方案。
 *
 * 多要 30%：规划本身也会撞车，多出来的正好补上被去掉的那些；
 * 但至少要多给 2 条，否则条数少时补不动（3 条撞 1 条就没余量了）。
 */
function planSceneCount(total: number) {
  return total + Math.max(2, Math.ceil(total * 0.3))
}

async function planPromptScenes(
  profile: ApiProfile,
  input: {
    sopText: string
    total: number
    copyText: string
    avoidCta: boolean
    userRequirement: string
    layoutOptimize: boolean
  },
): Promise<string[]> {
  const want = planSceneCount(input.total)
  const copy = input.copyText.trim()
  const user = [
    `【生图 SOP】\n${(input.avoidCta ? stripButtonPlaceholders(input.sopText) : input.sopText).trim()}`,
    copy ? `【图上必须出现的卖点（仅供你理解画面主题，不用写进方案）】\n${copy}` : '',
    input.userRequirement.trim() ? `【本次要求】\n${input.userRequirement.trim()}` : '',
    input.layoutOptimize
      ? `请规划 ${want} 条互不相同的画面方案，按上面要求的五项写，一行一条。`
      : `请规划 ${want} 条互不相同的画面方案，按上面要求的四项写，一行一条。`,
  ].filter(Boolean).join('\n\n')

  const raw = await chat(
    profile,
    [
      {
        role: 'system',
        content: input.layoutOptimize
          ? scenePlanSystemLayout(sopHasPeople(input.sopText))
          : scenePlanSystem(sopHasPeople(input.sopText)),
      },
      { role: 'user', content: user },
    ],
    // 只出短标签，十几秒就够；给太紧会因为网络抖动误判失败
    120,
    // 每条 25 字 ≈ 40 token，want 条再留一倍余量（带排版项时标签更长，翻倍）
    Math.min(12000, Math.max(1500, want * (input.layoutOptimize ? 130 : 80))),
    // 规划要发散，否则模型会给出一堆相似的场景
    0.9,
  )
  return parseNumberedList(raw)
}

/**
 * 第二步：SOP → 多条具体提示词。
 *
 * 两阶段：先规划 N 条互不重复的画面方案，再按批次**并行**写正文。
 * 规划失败（网络抖动、模型返回空）时退回原来的顺序写法，不让整批卡住。
 * `onProgress(written, total)` 每批回调一次，供界面显示「正在写 24/100」。
 */
export async function generatePrompts(
  profile: ApiProfile,
  sopText: string,
  count: number,
  ignoreCompliance = true,
  avoidHint = '',
  copyText = '',
  avoidCta = false,
  onProgress?: (written: number, total: number) => void,
  /** 底图说明：非空时写词规则切到「在底图上改」，见 buildSopImageHint */
  imageHint = '',
  /** 输入框里写的本次要求：每条提示词都要体现 */
  userRequirement = '',
): Promise<string[]> {
  const total = clampPromptCount(count)
  // 按「这一刻真正要用的模型」决定是否注入排版专项规则，两条写词路径共用这一个判断
  const layoutOptimize = needsLayoutOptimize(resolveSopTextModel(profile))
  const opts = { sopText, ignoreCompliance, avoidHint, copyText, avoidCta, imageHint, userRequirement, layoutOptimize }

  // 阶段 1：规划画面方案。失败就退回顺序写法，不让整批卡住
  let scenes: string[] = []
  try {
    const planned = await planPromptScenes(profile, {
      sopText, total, copyText, avoidCta, userRequirement, layoutOptimize,
    })
    scenes = dedupeScenes(planned).kept
  } catch (err) {
    console.warn('规划画面方案失败，退回顺序写词：', err)
  }

  // 方案够数才并行；不够说明规划没成功，顺序写（它自带避重上下文）更稳
  if (scenes.length >= total) {
    return writePromptsInParallel(profile, opts, total, scenes.slice(0, total), onProgress)
  }

  return writePromptsSequentially(profile, opts, total, onProgress)
}

/** 顺序写词：原来的实现，规划失败时兜底用 */
async function writePromptsSequentially(
  profile: ApiProfile,
  opts: {
    sopText: string
    ignoreCompliance: boolean
    avoidHint: string
    copyText: string
    avoidCta: boolean
    imageHint: string
    userRequirement: string
    layoutOptimize: boolean
  },
  total: number,
  onProgress?: (written: number, total: number) => void,
): Promise<string[]> {
  const prompts: string[] = []
  const seen = new Set<string>()
  // 模型偶尔少写几条，多给两轮机会；轮数封顶避免一直写不出来时死循环
  const maxTries = Math.ceil(total / PROMPTS_PER_BATCH) * 2 + 2
  let tries = 0

  while (prompts.length < total && tries < maxTries) {
    tries += 1
    const need = Math.min(PROMPTS_PER_BATCH, total - prompts.length)
    const messages = buildPromptMessages({
      ...opts,
      count: need,
      // 只带最近几批：全量贴进去会把上下文顶爆，而最近写的最容易撞车
      existing: prompts.slice(-PROMPTS_PER_BATCH * 3),
    })
    const raw = await chat(
      profile,
      [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      240,
      tokensForPrompts(need),
      0.4,
    )
    const parsed = parseNumberedList(raw)
    const batch = opts.copyText.trim() ? dedupePrompts(parsed).prompts : parsed
    for (const prompt of batch) {
      const key = prompt.replace(/\s+/g, ' ').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      prompts.push(prompt)
      if (prompts.length >= total) break
    }
    onProgress?.(Math.min(prompts.length, total), total)
  }
  return prompts
}

/**
 * 并行写词：把规划好的方案切成若干批，最多 `PROMPT_WRITE_PARALLEL` 批同时在飞。
 *
 * 为什么现在能并行、以前不能：
 * 以前靠「把已写好的贴给下一批」避重，后一批必须等前一批出结果，天然串行。
 * 现在画面方案在规划阶段就分好了，各批任务互不重叠，不需要看别人的输出。
 *
 * 顺序仍要保住：每批完成时按**批号**写回自己的槽位，
 * 不能按完成先后拼接 —— 否则第 1 条可能落到第 12 条的位置上，
 * 后面图片分配、卖点对应、卡内排序全都会错位。
 */
async function writePromptsInParallel(
  profile: ApiProfile,
  opts: {
    sopText: string
    ignoreCompliance: boolean
    avoidHint: string
    copyText: string
    avoidCta: boolean
    imageHint: string
    userRequirement: string
    layoutOptimize: boolean
  },
  total: number,
  scenes: string[],
  onProgress?: (written: number, total: number) => void,
): Promise<string[]> {
  const chunks: string[][] = []
  for (let start = 0; start < total; start += PROMPTS_PER_BATCH) {
    chunks.push(scenes.slice(start, Math.min(start + PROMPTS_PER_BATCH, total)))
  }

  const slots: string[][] = chunks.map(() => [])
  let done = 0

  const writeChunk = async (chunk: string[], index: number) => {
    const messages = buildPromptMessages({
      ...opts,
      count: chunk.length,
      scenes: chunk,
    })
    const raw = await chat(
      profile,
      [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      240,
      tokensForPrompts(chunk.length),
      // 方案已经定死，这里不再需要发散，稳定采样即可
      0.4,
    )
    const parsed = parseNumberedList(raw)
    const cleaned = opts.copyText.trim() ? dedupePrompts(parsed).prompts : parsed
    // 条数对不上时按方案数补齐/截断：宁可少一条，也不能让后面的条错位
    slots[index] = cleaned.slice(0, chunk.length)
    done += slots[index].length
    onProgress?.(Math.min(done, total), total)
  }

  // 分批滚动：最多 PROMPT_WRITE_PARALLEL 批同时在飞，谁先完成谁补下一批
  let next = 0
  const workers = Array.from({ length: Math.min(PROMPT_WRITE_PARALLEL, chunks.length) }, async () => {
    while (next < chunks.length) {
      const index = next
      next += 1
      try {
        await writeChunk(chunks[index], index)
      } catch (err) {
        // 单批失败不拖垮整批：留下空槽，最后按实际拿到的条数返回
        console.warn(`第 ${index + 1} 批写词失败：`, err)
        slots[index] = []
      }
    }
  })
  await Promise.all(workers)

  // 按批号摊平，保持规划顺序
  const result = slots.flat().filter(Boolean)
  return result.slice(0, total)
}

/**
 * 生图前校正：把提示词里「」内的文字改回卖点原文，其余内容一个字都不动。
 * 条数对不上时放弃本次结果，避免把整批提示词弄乱。
 */
export async function fixPromptCopy(
  profile: ApiProfile,
  prompts: string[],
  copyText: string,
): Promise<string[]> {
  const system = [
    '你是广告生图提示词的校对员。用户会给你一份「卖点文案」和若干条生图提示词，你要把提示词里印在画面上的文字改回卖点原文。',
    '只改被「」包裹的文字：逐字替换成卖点里的原句，不得改写、缩写、扩写、合并或新增。',
    '「」以外的所有内容（场景、机位、人物、配色、光线、版式、装饰描述）一个字都不要动。',
    '每条提示词都要把全部卖点用上，可以换顺序；同一张图里同一句卖点只能出现一次。',
    '卖点里括号中的说明（如「(责任内)」）是那句话自带的限定语，属于原文：那句卖点出现时，括号说明必须紧跟在那句后面一起出现。提示词里只写了正文、把括号说明丢掉的（例如留下「及下方小字，」这种空壳），要把括号说明补回到该正文之后并用「」包裹。',
    '判断「同一句卖点」只看括号外的正文：两句不同的卖点各自带同一个括号说明时，两处括号说明都要保留，不许去重、不许只留一处。',
    '不要新增卖点以外的任何文字，也不要把卖点拆成两行或换个说法重写。',
    '只输出编号列表，一行一条，不要任何解释、不要小标题、不要代码块。',
  ].join('\n')
  const user = [
    `【卖点文案（唯一来源，必须逐字使用）】\n${copyText.trim()}`,
    `【待修正的提示词】\n${prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')}`,
  ].join('\n\n')

  const raw = await chat(
    profile,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    240,
    tokensForPrompts(prompts.length),
    // 校对要稳，不要自由发挥
    0.2,
  )
  const fixed = parseNumberedList(raw)
  return fixed.length === prompts.length ? fixed : prompts
}

/** 解析编号列表；解析不到编号时退回按空行切分 */
export function parseNumberedList(text: string): string[] {
  const body = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
  const numbered: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s*[.、)．]\s*(.+)$/)
    if (match) numbered.push(match[1].trim())
  }
  if (numbered.length) return numbered.filter(Boolean)
  return body.split(/\r?\n\s*\r?\n/).map((item) => item.trim()).filter(Boolean)
}

/** SOP 标题取「SOP 名称」那一行；自定义结构里没有这一节时，取第一个小节下的第一行，最后才用方向名兜底 */
export function sopTitleOf(sopText: string, fallback: string): string {
  const named = sopText.match(/^#{1,3}\s*SOP\s*名称\s*\n+\s*(.+)$/m)
  if (named) return named[1].trim().slice(0, 40)
  const firstBody = sopText
    .match(/^#{1,3}\s*.+\n+\s*(?:[-*]\s*)?([^\n#].+)$/m)?.[1]
    ?.trim()
  return (firstBody || fallback).slice(0, 40)
}

/** 卖点一节的标题；附进存档 SOP 时用它，重复附加以防 */
export const COPY_SECTION_HEADER = '# 卖点文案（最高优先级 · 图上文字的唯一来源）'

/**
 * 把卖点作为最高优先级的一节附到存档 SOP 末尾。
 *
 * 「直接使用 SOP」路径原本只把卖点单独喂给写提示词，SOP 文本本身看不到卖点，
 * 而且 SOP 里常写「画面不出现任何文字」这类禁忌，跟卖点文字互相打架。
 * 附上这一节后，SOP 全文（卡上、详情页、后续补充生图）都带着卖点。
 * 已经附过（比如拿存档过的任务卡再补充生图）就不重复加。
 */
export function appendCopySection(sopText: string, copyText: string): string {
  const copy = copyText.trim()
  if (!copy || sopText.includes(COPY_SECTION_HEADER)) return sopText
  return `${sopText.trim()}\n\n${COPY_SECTION_HEADER}\n${copy}`
}

// ===== 后台队列：点击后立即返回，界面不锁 =====

export interface SopJobRequest {
  label: string
  /**
   * 母卡：这次是「从哪张卡衍生出来的」。
   *
   * 目前只有详情页的「再次生成图片 → 新建一张卡」会传。
   * 有了它，素材投放跟踪那边才能把消耗沿着血缘往上卷，
   * 回答「这套创意整体花了多少钱、是从哪一版改出来的」。
   */
  parentCardId?: string
  imageDataUrls: string[]
  imageIds?: string[]
  /** 系统提示词 + 卖点 + 风格合成的一份 Markdown */
  systemPromptText: string
  /** 选中的系统提示词名称，写入任务卡供详情页追溯 */
  systemPromptName?: string
  /**
   * 已存档的 SOP 全文。有值就不反推，直接拿它写提示词：
   * 这是「选 SOP 直接出图」和「详情页补充生图」两条路径的入口。
   */
  sopText?: string
  /** 这份 SOP 在库里的名字，写进任务卡供详情页追溯 */
  savedSopName?: string
  /** 卖点原文：写提示词阶段要再单独喂一次，保证图上文字逐字来自这里 */
  copyText?: string
  promptsPerGroup: number
  directionId?: string
  ignoreCompliance?: boolean
  useImageSellingPoints?: boolean
  /** 避免按钮、悬浮球这类引导点击的仿系统界面设计，默认开启 */
  avoidCta?: boolean
  /**
   * 发送瞬间输入框里的原文。
   * SOP 模式不会拿它去生成，但「复用配置」要能把它还原回输入框 ——
   * 否则只能塞模型生成的那条长提示词，看着像「输入框被替换成了别的东西」。
   */
  inputPrompt?: string
  /**
   * 发送瞬间「本次文案」那一栏的内容。
   * 已经合进 copyText 参与生成，这里只是为了「复用配置」能把它还原回输入区。
   */
  customCopy?: string
  /**
   * 不把后处理预留区写进提示词。由「额外要求」里“避开 Logo / 警示语位置”那条控制：
   * 用户关掉它就不该再算预留区，否则会继续强行避让。
   */
  skipOverlay?: boolean
  /**
   * 入队那一刻的输入参数（尺寸 / 质量 / 后处理开关…）。
   *
   * 反推 SOP、写提示词要跑好几分钟，这期间用户完全可能回去改尺寸。
   * 这一批的「预留区模板」是按发送时的尺寸挑的，出图却用最新尺寸的话，
   * Logo / 警示语的位置就对不上了 —— 所以从入队起就把参数定死，全程用这一份。
   */
  params: TaskParams
  /**
   * 图生图：整批共用的固定图，每条提示词都带同一组。
   * 为空表示纯文生图（参考图仍然只用于反推）。
   */
  fixedImages?: InputImage[]
  /** 图生图：变量图，每条轮换一张 */
  variableImages?: InputImage[]
  /**
   * 变量图从第几张开始轮。跨卡累计用（见 sopVariableImageOffset），
   * 否则多张卡的这一批永远只用池子最前面那几张。
   */
  variableImageOffset?: number
  /** 底图保真档，默认「保版式」 */
  imageFidelity?: ImageFidelity
  /**
   * 输入框里写的本次要求（已 trim）。
   *
   * 反推阶段它已经并进 systemPromptText 出现过一次，但写提示词阶段还要再喂一次 ——
   * 模型按 SOP 写二十条时，很容易把「这次要怎么做」当成背景信息忽略掉。
   */
  userRequirement?: string
}

/** 同时在跑的任务卡数量 */
const QUEUE_LIMIT = 10

const queue: SopJobRequest[] = []
let runningCount = 0
let totalCount = 0
let doneCount = 0

function refreshProgress(label: string) {
  useSopStore.getState().setProgress({
    queued: queue.length,
    running: runningCount,
    done: doneCount,
    total: totalCount,
    label,
  })
}

async function runJob(job: SopJobRequest) {
  const state = useStore.getState()
  const settings = state.settings
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  if (!profile) throw new Error('没有可用的接口配置')
  // 参数以入队那一刻为准：反推期间用户改了尺寸也不影响这一批（见 SopJobRequest.params）
  const runParams = job.params ?? state.params

  // 后处理预留区：出图后要在固定位置叠 Logo / 警示语，写提示词时就让模型避开
  // 关掉后处理就不用留位了，画面可以画满
  const sopState = useSopStore.getState()
  // skipOverlay 来自「额外要求」里“避开 Logo / 警示语位置”有没有选
  const avoidTemplate = job.skipOverlay || sopState.avoidOverlay === false || runParams.post_process === false
    ? null
    : pickAvoidTemplate(
      resolvePostTemplates(sopState.postTemplates, sopState.directions, job.directionId).templates,
      runParams.size,
      job.imageDataUrls,
    )
  const avoidHint = buildAvoidHint(avoidTemplate)
  // 反推 SOP 时也把预留区告诉模型：版式一开始就避开，比写完提示词再强行避让稳
  const avoidZones = avoidZoneSummary(avoidTemplate)

  const sopJobId = `sop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  // 衍生关系顺手记一笔：失败不影响出图（recordLineage 内部吞异常）
  if (job.parentCardId) void recordLineage(sopJobId, job.parentCardId, 'derive')
  // 实际要用的文本模型：先定死，反推与写词都用它，也记进任务卡（中途改配置不影响这一批）
  const textModel = resolveSopTextModel(profile)
  // 先占位，用户点完发送立刻能看到这张卡
  const presetSop = Boolean(job.sopText?.trim())
  const placeholderId = createSopPlaceholder(sopJobId, job.label, job.directionId, presetSop ? 'write' : 'reverse', textModel)

  try {
    // 已存档的 SOP 直接拿来写提示词；没有才按参考图反推
    let sop = job.sopText?.trim()
      || await generateSop(
        profile,
        job.systemPromptText,
        job.imageDataUrls,
        job.ignoreCompliance !== false,
        job.useImageSellingPoints === true,
        job.copyText ?? '',
        job.avoidCta !== false,
        avoidZones,
      )
    const copyText = (job.copyText ?? '').trim()
    // 直接用存档 SOP 时把卖点并进 SOP 文本：卡上、详情页看到的 SOP 就带着卖点，
    // 和「反推」路径一致；不然 SOP 里连卖点一节都找不到，看起来像没生效
    if (presetSop && copyText) sop = appendCopySection(sop, copyText)
    /**
     * 图生图：每条提示词带哪些底图，在写词之前就定下来。
     * 写词阶段要按「有底图」的规则写（不重复描述底图、用户要求优先），
     * 出图阶段再用同一份计划 —— 两边各算一次的话，提示词和图很容易对不上。
     */
    const imagePlan = planSopImages(
      job.fixedImages ?? [],
      job.variableImages ?? [],
      job.promptsPerGroup,
      job.variableImageOffset ?? 0,
    )
    const imageHint = buildSopImageHint({
      fixedCount: job.fixedImages?.length ?? 0,
      variableCount: job.variableImages?.length ?? 0,
      fidelity: job.imageFidelity,
    })
    let prompts = await generatePrompts(
      profile,
      sop,
      job.promptsPerGroup,
      job.ignoreCompliance !== false,
      avoidHint,
      job.copyText ?? '',
      job.avoidCta !== false,
      // 一大批要写很久，占位卡上直接显示进度，比一直停在「正在写提示词」安心
      job.promptsPerGroup > PROMPTS_PER_BATCH
        ? (written, total) => updateTaskInStore(placeholderId, {
          prompt: `${job.label} · 正在写提示词（${written}/${total}）`,
        })
        : undefined,
      imageHint,
      job.userRequirement,
    )
    if (!prompts.length) throw new Error(`${job.label} 没有得到提示词`)
    // 模型少写几条时按实际条数截断：多出来的计划条目没有提示词可用
    let assignments = imagePlan.assignments.slice(0, prompts.length)

    // 生图前校验：选了卖点就必须逐字一致，不一致先让模型改回原文再验一次
    if (copyText) {
      const before = checkPromptCopy(prompts, copyText)
      if (!before.ok) {
        updateTaskInStore(placeholderId, { prompt: `${job.label} · 正在校正卖点…` })
        prompts = await fixPromptCopy(profile, prompts, copyText)
        const after = checkPromptCopy(prompts, copyText)
        if (!after.ok) {
          // 不再「按校正结果继续」：改不回来的那几条会出成没字 / 改过字的废图，
          // 交给下面的发送前校对拦下来
          console.warn('卖点校正后仍有不一致：', after.issues)
        }
      }
    }

    // 发送前校对：卖点逐字、有没有画面文案、广告违禁词与违规内容
    updateTaskInStore(placeholderId, { prompt: `${job.label} · 正在校对提示词…` })
    const proofread = await proofreadPrompts({
      profile,
      prompts,
      copyText,
      enabled: useStore.getState().settings.promptProofread !== false,
    })
    if (proofread.blocks.length) {
      const kept = keepIndexes(prompts.length, proofread.blocks)
      prompts = kept.map((index) => prompts[index])
      // 图要跟着提示词一起留下：只删提示词会把后面每条的底图都顶偏一位
      assignments = kept.map((index) => assignments[index])
      useStore.getState().showToast(
        `${job.label}：${proofread.blocks.length} 条没通过校对，已跳过（${describeBlocks(proofread.blocks)}）`,
        'error',
      )
    }
    for (const note of proofread.notes) useStore.getState().showToast(`${job.label}：${note}`, 'info')
    if (!prompts.length) {
      throw new Error(`提示词没通过校对：${describeBlocks(proofread.blocks, 2)}`)
    }
    // 底图说明在发送前再拼一次：写词模型常常漏掉这层，漏了就会跟底图打架
    const promptsToSend = prompts.map((prompt) => withSopImageHint(prompt, imageHint))

    await removeSopPlaceholder(placeholderId)
    // 出图任务由 submitSopTasks 内部再限并发，这里不等待，避免占住队列
    void submitSopTasks({
      sopJobId,
      sopName: sopTitleOf(sop, job.label),
      // 出图沿用入队时的参数，别用此刻的全局参数（中途可能被改过）
      params: runParams,
      // 用的是存档 SOP 时不记系统提示词，详情页改显示 SOP 名字
      systemPromptName: job.savedSopName
        ? ''
        : job.systemPromptName?.trim()
          // 老数据没有名字时退回第一行，至少能看出是哪种提示词
          || job.systemPromptText.split('\n')[0].slice(0, 24)
          || '系统提示词',
      savedSopName: job.savedSopName,
      sopText: sop,
      textModel: textModel,
      directionId: job.directionId,
      referenceImageIds: job.imageIds,
      prompts: promptsToSend,
      /**
       * 图生图：每条提示词带自己的底图。没有池时是空数组，
       * submitSopTasks 会退回「纯提示词出图」，行为和以前一样。
       */
      inputImagesPerPrompt: prompts.map((_, index) => assignments[index]?.images ?? []),
      variableImageIds: prompts.map((_, index) => assignments[index]?.variableImage?.id),
      imageFidelity: job.imageFidelity,
      /**
       * 发送前快照：SOP 模式下参考图只用于反推，
       * 固定图 / 变量图才是出图底图，各自回原池，复用配置时不用重新分。
       */
      inputSnapshot: {
        mode: 'sop',
        prompt: job.inputPrompt?.trim() || undefined,
        // 「本次文案」那一栏：复用配置时原样还原回去
        customCopy: job.customCopy?.trim() || undefined,
        fixedImageIds: (job.fixedImages ?? []).map((img) => img.id),
        variableImageIds: (job.variableImages ?? []).map((img) => img.id),
      },
    })
  } catch (err) {
    // 不删卡：删掉只剩「转圈后卡片消失」，用户看不到原因。转成错误卡，原因留在卡上。
    const message = err instanceof Error ? err.message : String(err)
    updateTaskInStore(placeholderId, {
      status: 'error',
      error: message,
      prompt: `${job.label} · SOP 失败`,
      finishedAt: Date.now(),
      // 清掉占位标记，否则详情页会把它当临时占位过滤掉
      sopPlaceholder: false,
    })
    throw err
  }
}

function pump() {
  while (runningCount < QUEUE_LIMIT && queue.length) {
    const job = queue.shift()
    if (!job) return
    runningCount += 1
    refreshProgress(job.label)
    void runJob(job)
      .catch((err) => {
        useStore.getState().showToast(`${job.label}：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
      .finally(() => {
        runningCount -= 1
        doneCount += 1
        if (!queue.length && runningCount === 0) {
          totalCount = 0
          doneCount = 0
          useSopStore.getState().setProgress(null)
          useStore.getState().showToast('SOP 生图已全部提交', 'success')
          return
        }
        refreshProgress(job.label)
        pump()
      })
  }
}

/** 把任务卡推入后台队列，立即返回 */
export function enqueueSopJobs(jobs: SopJobRequest[]) {
  if (!jobs.length) return
  totalCount += jobs.length
  queue.push(...jobs)
  refreshProgress(jobs[0].label)
  pump()
}

/** 用一份现成的 SOP 给已有任务卡补充生图的入参 */
export interface SopSupplementInput {
  /** 补充到哪张卡：沿用原来的 sopJobId，新图直接挂在这张卡下面 */
  sopJobId: string
  sopName: string
  sopText: string
  /** 用的是库里某份 SOP 时记它的名字；用本卡原有 SOP 补充时留空 */
  savedSopName?: string
  /** 这次补几条提示词（=几张图） */
  count: number
  directionId?: string
  ignoreCompliance?: boolean
  avoidCta?: boolean
  /** 这张卡现有多少条提示词：新条目编号从这里往后顺延 */
  existingCount: number
  /**
   * 原卡当时在输入框里写的本次要求。
   * 补充生图没有输入框，但这批图要和卡上前几条是同一套要求，所以得沿用。
   */
  userRequirement?: string
}

/**
 * 用 SOP 给已完成的任务卡补充生图。
 *
 * 与 enqueueSopJobs 的区别：这里不反推、也不新建卡，直接按这份 SOP 写 N 条提示词，
 * 挂到同一个 sopJobId 下，等于给这张卡再补 N 张图。
 * 返回新任务 id；提示词写失败时抛错，由调用方提示。
 */
export async function supplementCardWithSop(input: SopSupplementInput): Promise<string[]> {
  const sopText = input.sopText.trim()
  if (!sopText) throw new Error('这份 SOP 是空的，无法补充生图')
  const state = useStore.getState()
  const settings = state.settings
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  if (!profile) throw new Error('没有可用的接口配置')
  // 写提示词时按这一刻的参数算预留区，出图也必须用同一份，否则位置的依据就变了
  const runParams = state.params

  // 与正常出图一致：后处理要叠 Logo / 警示语时，提示词得避开预留区
  const sopState = useSopStore.getState()
  const avoidHint = sopState.avoidOverlay === false || runParams.post_process === false
    ? ''
    : buildAvoidHint(pickAvoidTemplate(
      resolvePostTemplates(sopState.postTemplates, sopState.directions, input.directionId).templates,
      runParams.size,
    ))

  const count = clampPromptCount(input.count)
  /**
   * 补充生图沿用这张卡原来的底图。
   *
   * 不沿用的后果是「同一张卡里前半批是图生图、后半批是纯文生图」，
   * 画面基底直接对不上，而且用户完全看不出为什么。
   * 图片可能已被清理，取不到就跳过 —— 少一张底图也比整批补不出来强。
   */
  const siblings = state.tasks.filter((item) => item.sopJobId === input.sopJobId && !item.sopPlaceholder)
  const sample = siblings[0]
  const fixedIds = sample?.variableFixedImageIds ?? []
  const variableIds = sample?.inputSnapshot?.variableImageIds ?? []
  const loadBase = async (ids: string[]): Promise<InputImage[]> => {
    const out: InputImage[] = []
    for (const id of ids) {
      const dataUrl = await ensureImageCached(id)
      if (dataUrl) out.push({ id, dataUrl })
    }
    return out
  }
  const fixedImages = await loadBase(fixedIds)
  const variableImages = await loadBase(variableIds)
  const imageFidelity = sample?.imageFidelity
  // 从这张卡已有的条数接着轮，补出来的图和前面几张用的不是同一组底图才怪
  const imagePlan = planSopImages(fixedImages, variableImages, count, input.existingCount)
  const imageHint = buildSopImageHint({
    fixedCount: fixedImages.length,
    variableCount: variableImages.length,
    fidelity: imageFidelity,
  })

  const prompts = await generatePrompts(
    profile,
    sopText,
    count,
    input.ignoreCompliance !== false,
    avoidHint,
    '',
    input.avoidCta !== false,
    // 条数多时分批写，界面上要能看出还在推进，不然像卡死了
    count > PROMPTS_PER_BATCH
      ? (written, total) => {
        useStore.getState().showToast(`正在按 SOP 写提示词：${written}/${total} 条…`, 'info')
      }
      : undefined,
    imageHint,
    input.userRequirement,
  )
  if (!prompts.length) throw new Error('没有得到提示词')
  const assignments = imagePlan.assignments.slice(0, prompts.length)

  return await submitSopTasks({
    sopJobId: input.sopJobId,
    sopName: input.sopName,
    params: runParams,
    // 补充生图不改 SOP 来源，避免把这张卡的「用的是什么」覆盖掉
    systemPromptName: '',
    savedSopName: input.savedSopName,
    sopText,
    // 补充生图是用此刻的配置写的，记这一批实际用的模型（可能与卡上原有批次不同）
    textModel: resolveSopTextModel(profile),
    directionId: input.directionId,
    prompts: prompts.map((prompt) => withSopImageHint(prompt, imageHint)),
    inputImagesPerPrompt: prompts.map((_, index) => assignments[index]?.images ?? []),
    variableImageIds: prompts.map((_, index) => assignments[index]?.variableImage?.id),
    imageFidelity,
    promptIndexOffset: input.existingCount,
    /**
     * 快照要带上底图池：留空的话，复用这类补充出来的卡时
     * 固定图 / 变量图会全部丢掉，下次出图又退回纯文生图。
     */
    inputSnapshot: {
      mode: 'sop',
      fixedImageIds: fixedImages.map((img) => img.id),
      variableImageIds: variableImages.map((img) => img.id),
    },
  })
}
