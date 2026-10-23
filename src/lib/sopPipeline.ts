import type { ApiProfile } from '../types'
import { createSopPlaceholder, removeSopPlaceholder, submitSopTasks, updateTaskInStore, useStore } from '../store'
import { useSopStore } from './sopStore'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'
import { resolvePostTemplates } from './applyPostTemplate'
import { buildAvoidHint, pickAvoidTemplate } from './postReserve'
import { dedupePrompts } from './copyDedupe'
import { variationCandidates } from './promptVariation'

/** 生成 SOP 与提示词所用的文本模型 */
export const SOP_TEXT_MODEL = 'deepseek-v4.1-flash'

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

/** 一轮纯文本/多模态对话，返回助手消息正文 */
async function chat(
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
  // 有些渠道认死的输出上限比我们要求的小，按原值再要一次会一直 400；降级到保守值重试一次
  if (res.status === 400 && maxTokens > 4000) res = await send(4000)
  if (!res.ok) throw new Error(`HTTP ${res.status}：${await getApiErrorMessage(res)}`)
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = String(json.choices?.[0]?.message?.content ?? '').trim()
  if (!content) throw new Error('模型返回了空内容')
  return content
}

/** 写提示词时每条预留的输出预算（中文提示词一条约 150~250 字，留足余量） */
const TOKENS_PER_PROMPT = 500
/** 单次请求的输出上限天花板，超过这个值很多渠道会直接 400 */
const MAX_OUTPUT_TOKENS = 16000

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
function sopRuleLines(ignoreCompliance: boolean, useImageSellingPoints: boolean, avoidCta = false) {
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

/** 反推 SOP 的系统提示词；单独导出便于测试哪些规则被写进去了 */
export function buildSopSystemPrompt(
  ignoreCompliance: boolean,
  useImageSellingPoints: boolean,
  avoidCta = false,
  /** 输出小节，来自系统提示词；不传时用默认 7 节 */
  sections: string[] = DEFAULT_SOP_SECTIONS,
) {
  return [
    '你是广告设计团队的资深生图指导。用户会给你若干张参考图，你要从这些图里反推出一套可复用的「生图 SOP」。',
    'SOP 要能被另一个模型直接照着写出多条提示词，所以必须具体、可执行：写清版式结构、画面元素、文字层级、配色倾向、镜头与光线、必须出现和必须避免的东西。',
    '只描述你从参考图里真实观察到的规律，不要编造参考图里没有的品牌、价格或功效。',
    ...sopRuleLines(ignoreCompliance, useImageSellingPoints, avoidCta),
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
) {
  return [
    '你是广告设计团队的资深生图指导。本次用户没有提供参考图，只给了卖点文案与风格要求，你要仅凭这些文字设计出一套可复用的「生图 SOP」。',
    'SOP 要能被另一个模型直接照着写出多条提示词，所以必须具体、可执行：写清版式结构、画面元素、文字层级、配色倾向、镜头与光线、必须出现和必须避免的东西。',
    '所有画面设定都必须能用用户给的卖点与风格要求推出来，不要编造用户没提到的品牌、价格、功效、认证或数据。',
    ...sopRuleLines(ignoreCompliance, useImageSellingPoints, avoidCta),
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
): Promise<string> {
  const maxSide = imageDataUrls.length > MANY_IMAGE_THRESHOLD ? 768 : MODEL_MAX_SIDE
  const images = await Promise.all(imageDataUrls.map((url) => shrinkToDataUrl(url, maxSide)))
  // 输出哪些小节由系统提示词决定，没定义就用默认 7 节
  const sections = sopSectionsFrom(systemPrompt)

  // 没有参考图：仅凭系统提示词与卖点反推文字版 SOP，规则与有图版一致
  if (!images.length) {
    return chat(profile, [
      { role: 'system', content: buildTextSopSystemPrompt(ignoreCompliance, useImageSellingPoints, avoidCta, sections) },
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
    { role: 'system', content: buildSopSystemPrompt(ignoreCompliance, useImageSellingPoints, avoidCta, sections) },
    { role: 'user', content },
  ])
}

function promptSystem(ignoreCompliance: boolean, avoidHint = '', hasCopy = false, avoidCta = false) {
  return [
    '你是广告生图提示词工程师。用户会给你一份生图 SOP，你要严格按这份 SOP 写出指定数量的具体提示词。',
    '每条提示词必须能独立送进文生图模型，包含完整的画面描述：版式、场景、人物、色调、光线、以及图上应有的文字（用「」包裹）。',
    '发散按 SOP 里的「变量池」和「互斥规则」执行：每条从变量池里取用取值，同一批之间按互斥规则避重；不要自己另立一套维度，也不要把互斥规则当成建议。',
    avoidHint
      ? '如果给出了【画面预留区】，每条提示词都要写清主体、主要文字和关键视觉安排在预留区之外，并明确说明这些区域留白或保持干净背景。'
      : '',
    hasCopy
      ? '【文案唯一来源】用户会单独给出「卖点文案」。每张图都要把这份卖点用全，图上出现的所有文字必须逐字照抄这份卖点，不得改写、缩写、扩写、合并或新增；SOP、参考图里的文案与它冲突时一律以卖点文案为准。'
      : '',
    hasCopy
      ? '【卖点在各图之间保持一致】所有提示词用的都是同一份卖点：每张图都要把这份卖点完整地用一遍，不能这张图只用前两条、那张图只用后两条，也不许某张图漏掉某一句。各图之间的差别只体现在场景、机位、人物、配色和版式上，文字内容逐张一致。'
      : '',
    hasCopy
      ? '【同一张图里不许重复卖点】同一句卖点在一张图上只能出现一次：主标题用掉一句，其他文字位就放别的卖点，不要重复、不要换个说法再写一遍、不要拆成两行重复。版式里的文字位比卖点多时，直接删掉多余的文字位（用图形、色块或留白补位），绝对不能拿同一句卖点去填满版面。'
      : '',
    hasCopy
      ? '【版式随卖点条数走】每条提示词先数清楚这份卖点有几条，再决定版面：3 条卖点就排 3 个文字位（主标题 + 副标题 + 角标），不要设计第 4 个装饰性文字位；卖点只有 1 条时就用单一大标题撑版面，把版面让给主视觉。'
      : '',
    ignoreCompliance
      ? '不要写品牌 logo、免责声明、风险提示、警示语、合规说明，也不要写「请见条款及投保须知」「本素材纯属广告创意」这类附加小字。'
      : '',
    avoidCta
      ? '画面里不要出现按钮、悬浮球、进度条、返回箭头、开关等仿系统界面的可点击控件，也不要写「立即领取」「点击查看」「滑动解锁」「下载App」这类引导点击的文案，不要画手指点击示意或指向性箭头。'
      : '',
    '多条之间要在场景、机位、人物、色调上做出区分，不能只是换几个词。',
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
}

/** 拼「SOP → 提示词」这一轮的两条消息；单独抽出来方便测试文案优先级有没有写进去 */
export function buildPromptMessages({
  sopText,
  count,
  ignoreCompliance = true,
  avoidHint = '',
  copyText = '',
  avoidCta = false,
}: PromptMessagesInput): { system: string; user: string } {
  const copy = copyText.trim()
  const tail = ignoreCompliance
    ? '\n如果 SOP 里提到 logo、免责声明、警示语、合规小字，一律忽略，不要写进任何一条提示词。'
    : ''
  const reserve = avoidHint.trim() ? `\n\n${avoidHint.trim()}` : ''
  const copyBlock = copy ? `\n\n【卖点文案（图上文字必须逐字照抄，不得改写）】\n${copy}` : ''
  const copyTail = copy
    ? '\n注意：每条提示词用的都是同一份卖点，各张图的卖点完全一致。同一张图里，一份卖点从头到尾只用一遍：一句进了主标题，就不许再出现在副标题、角标、贴片等其他文字位上，也不许换个说法或拆成两行重写。文字位数量按卖点条数来定，多出来的槽位删掉，用图形、色块或留白补位。'
    : ''
  return {
    system: promptSystem(ignoreCompliance, avoidHint, Boolean(copy), avoidCta),
    user: `【生图 SOP】\n${sopText.trim()}${copyBlock}\n\n按这份 SOP 写 ${count} 条提示词，严格遵守其中的「变量池」与「互斥规则」，每条之间在场景和构图上要有明显区别。${tail}${copyTail}${reserve}`,
  }
}

/** 第二步：SOP → 多条具体提示词 */
export async function generatePrompts(
  profile: ApiProfile,
  sopText: string,
  count: number,
  ignoreCompliance = true,
  avoidHint = '',
  copyText = '',
  avoidCta = false,
): Promise<string[]> {
  const messages = buildPromptMessages({ sopText, count, ignoreCompliance, avoidHint, copyText, avoidCta })
  const raw = await chat(
    profile,
    [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.user },
    ],
    // 条数多时写得更久，超时要跟着放宽，否则正常的长输出会被中断
    240,
    tokensForPrompts(count),
    // 发散交给 SOP 的变量池与互斥规则，这里保持稳定采样，避免 SOP 之外的随机漂移
    0.4,
  )
  const prompts = parseNumberedList(raw)
  // 规则层要求「同一张图里每种卖点只出现一次」，但模型可能写重；
  // 这里做确定性兜底：同一句卖点在一张图里重复出现时，只保留第一次。
  return copyText.trim() ? dedupePrompts(prompts).prompts : prompts
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

// ===== 后台队列：点击后立即返回，界面不锁 =====

export interface SopJobRequest {
  label: string
  imageDataUrls: string[]
  imageIds?: string[]
  /** 系统提示词 + 卖点 + 风格合成的一份 Markdown */
  systemPromptText: string
  /** 选中的系统提示词名称，写入任务卡供详情页追溯 */
  systemPromptName?: string
  /** 卖点原文：写提示词阶段要再单独喂一次，保证图上文字逐字来自这里 */
  copyText?: string
  promptsPerGroup: number
  directionId?: string
  ignoreCompliance?: boolean
  useImageSellingPoints?: boolean
  /** 避免按钮、悬浮球这类引导点击的仿系统界面设计，默认开启 */
  avoidCta?: boolean
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

  // 后处理预留区：出图后要在固定位置叠 Logo / 警示语，写提示词时就让模型避开
  // 关掉后处理就不用留位了，画面可以画满
  const sopState = useSopStore.getState()
  const avoidHint = sopState.avoidOverlay === false || state.params.post_process === false
    ? ''
    : buildAvoidHint(pickAvoidTemplate(
      resolvePostTemplates(sopState.postTemplates, sopState.directions, job.directionId).templates,
      state.params.size,
      job.imageDataUrls,
    ))

  const sopJobId = `sop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  // 先占位，用户点完发送立刻能看到这张卡
  const placeholderId = createSopPlaceholder(sopJobId, job.label, job.directionId)

  try {
    const sop = await generateSop(
      profile,
      job.systemPromptText,
      job.imageDataUrls,
      job.ignoreCompliance !== false,
      job.useImageSellingPoints === true,
      job.copyText ?? '',
      job.avoidCta !== false,
    )
    const prompts = await generatePrompts(
      profile,
      sop,
      job.promptsPerGroup,
      job.ignoreCompliance !== false,
      avoidHint,
      job.copyText ?? '',
      job.avoidCta !== false,
    )
    if (!prompts.length) throw new Error(`${job.label} 没有得到提示词`)

    await removeSopPlaceholder(placeholderId)
    // 出图任务由 submitSopTasks 内部再限并发，这里不等待，避免占住队列
    void submitSopTasks({
      sopJobId,
      sopName: sopTitleOf(sop, job.label),
      systemPromptName: job.systemPromptName?.trim()
        // 老数据没有名字时退回第一行，至少能看出是哪种提示词
        || job.systemPromptText.split('\n')[0].slice(0, 24)
        || '系统提示词',
      sopText: sop,
      directionId: job.directionId,
      referenceImageIds: job.imageIds,
      prompts,
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
