import type { ApiProfile } from '../types'
import { chat } from './sopPipeline'
import { getSelectedTextMentionLabel } from './promptImageMentions'

/**
 * 输入框「优化提示词」：拿现有提示词 + 一条优化要求，让文本模型改写一遍。
 *
 * 和 SOP / 变量模式的「生成提示词」不同，这里不改需求、不加结构，
 * 只按用户自己写的那句要求做局部改写 —— 所以在客户端要守住三件事：
 *   1. 变量占位符 {{...}} 不能被模型吃掉（否则变量模式直接跑不了）
 *   2. @图N 这类图片引用要还原成带不可见标记的形态（否则覆盖回去就不再是引用，只是一串文字）
 *   3. 模型爱加的解释、代码块、引号要剥掉，覆盖进输入框的只能是提示词正文
 */

/** 快捷优化要求：点一下拼进输入框，用户还能继续改 */
export const PROMPT_OPTIMIZE_PRESETS: Array<{ label: string; text: string }> = [
  { label: '更具体', text: '把描述写得更具体：补上主体细节、材质、光线、镜头与画幅，去掉含糊笼统的词' },
  { label: '更简洁', text: '精简到只保留最关键的画面信息，删掉重复和套话，长度压到原文的一半左右' },
  { label: '强化画面感', text: '强化画面张力：明确主体占比、构图方式、色调与光影氛围，让画面更有视觉冲击' },
  { label: '贴合参考图', text: '按参考图的排版结构和主体动作重写，把排版层次、文字位置与画面元素的关系说清楚' },
  { label: '更口语化', text: '把书面化的表述改成自然口语，去掉形容词堆砌和广告腔' },
]

/** 变量占位符：{{变量名}} */
const PLACEHOLDER_RE = /\{\{[^{}]{1,40}\}\}/g
/** 图片引用：@图1、@第2轮图3 */
const MENTION_RE = /@(?:图\d+|第\d+轮图\d+)/g
/** 已经是带不可见标记的引用（\u2063@图1\u2064），还原时不能重复包一层 */
const WRAPPED_MENTION_RE = /[\u2063]@(?:图\d+|第\d+轮图\d+)[\u2064]/g

export function collectPlaceholders(text: string): string[] {
  return Array.from(new Set(text.match(PLACEHOLDER_RE) ?? []))
}

export function collectMentions(text: string): string[] {
  const bare = text.replace(WRAPPED_MENTION_RE, '')
  return Array.from(new Set(bare.match(MENTION_RE) ?? []))
}

/** 优化要求留空时用一句中性兜底，免得模型自由发挥把提示词改歪 */
export const DEFAULT_OPTIMIZE_REQUIREMENT = '在不改变原意和关键信息的前提下，让画面描述更清楚、更能直接照着出图'

export function buildOptimizeMessages(prompt: string, requirement: string, imageCount: number) {
  const system = [
    '你是投放素材的出图提示词优化师。用户给你一段现有的出图提示词和一条优化要求，你只改写这段提示词。',
    '规则：',
    '1. 只输出改写后的提示词正文，不要解释、不要前缀（不要写「优化后：」）、不要引号、不要用代码块包裹。',
    '2. 语言和原文一致（原文是中文就用中文），不要翻译。',
    '3. 原文里的 {{变量}} 占位符必须原样保留，数量和写法都不能变，也不要解释它们是什么。',
    '4. 原文里的 @图1、@图2 这类图片引用必须原样保留，位置不要挪动。',
    '5. 只按优化要求改；没提到的部分（主体、卖点、画面元素、合规要求）不要自行增删。',
    '6. 不要凭空添加品牌、数字、承诺、联系方式、二维码或「点击查看」这类引导语。',
    '7. 长度控制在原文的 0.7~1.5 倍，写成可执行的画面描述，不要写成条目式需求说明。',
  ].join('\n')

  const user = [
    `【现有提示词】\n${prompt.trim()}`,
    `【优化要求】\n${(requirement.trim() || DEFAULT_OPTIMIZE_REQUIREMENT)}`,
    imageCount > 0
      ? `附带的 ${imageCount} 张图是这段提示词要生成的参考画面：可以据此把主体、排版、色彩写准，但不要把图上的文字照抄进提示词。`
      : '',
    '直接输出优化后的提示词。',
  ].filter(Boolean).join('\n\n')

  return { system, user }
}

/** 剥掉模型爱加的包装：代码块、前缀、首尾引号 */
export function cleanOptimizedPrompt(raw: string): string {
  let text = (raw || '').trim()
  const fence = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) text = fence[1].trim()
  text = text.replace(/^(优化后|改写后|新的?提示词|提示词)[:：]\s*/i, '').trim()
  // 整段被引号包住才剥，句内的引号是提示词的一部分
  if (/^["'「『].*["'」』]$/s.test(text)) text = text.slice(1, -1).trim()
  return text
}

/** 把 @图N 重新包上不可见提及标记，覆盖回输入框后才能继续当图片引用用 */
export function restoreMentionMarkers(text: string): string {
  if (!text) return text
  // 先把已经包好的挖掉，避免重复包装
  const stash: string[] = []
  const masked = text.replace(WRAPPED_MENTION_RE, (match) => {
    stash.push(match)
    return `\u0000${stash.length - 1}\u0000`
  })
  const restored = masked.replace(MENTION_RE, (label) => getSelectedTextMentionLabel(label))
  return restored.replace(/\u0000(\d+)\u0000/g, (_, index: string) => stash[Number(index)] ?? '')
}

/** 模型弄丢的变量占位符：非空就不能覆盖，否则变量模式会直接跑不了 */
export function missingPlaceholders(original: string, optimized: string): string[] {
  return collectPlaceholders(original).filter((item) => !optimized.includes(item))
}

/**
 * 模型弄丢的图片引用。
 * 引用带不可见标记，用户看不出来，丢了就会变成一句普通文字；位置又没法凭空补，
 * 所以和占位符一样，丢一项就让用户重试。
 */
export function missingMentions(original: string, optimized: string): string[] {
  return collectMentions(original).filter((item) => !optimized.includes(item))
}

export interface OptimizePromptInput {
  profile: ApiProfile
  prompt: string
  requirement: string
  /** 参考图（已缩过图），带上能让改写更贴合画面 */
  imageDataUrls?: string[]
}

export async function optimizePrompt({ profile, prompt, requirement, imageDataUrls = [] }: OptimizePromptInput): Promise<string> {
  const { system, user } = buildOptimizeMessages(prompt, requirement, imageDataUrls.length)
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: user }]
  for (const url of imageDataUrls) content.push({ type: 'image_url', image_url: { url } })

  const raw = await chat(
    profile,
    [
      { role: 'system', content: system },
      { role: 'user', content: imageDataUrls.length ? content : user },
    ],
    // 改写是单轮短任务，超时给短一点，失败也好让用户马上重试
    120,
    4000,
    0.6,
  )

  const cleaned = cleanOptimizedPrompt(raw)
  if (!cleaned) throw new Error('模型返回了空内容，请重试')
  const missing = missingPlaceholders(prompt, cleaned)
  if (missing.length) {
    throw new Error(`模型把变量占位符弄丢了（${missing.join('、')}），请重试或换个要求`)
  }
  const lostRefs = missingMentions(prompt, cleaned)
  if (lostRefs.length) {
    throw new Error(`模型把图片引用弄丢了（${lostRefs.join('、')}），请重试或换个要求`)
  }
  return restoreMentionMarkers(cleaned)
}
