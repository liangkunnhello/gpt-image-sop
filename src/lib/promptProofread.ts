/**
 * 发送前的文字校对。
 *
 * 目的：图一旦出来才发现「没有文案」「卖点被改」「写了违规词」，只能重跑，成本比校对高得多。
 *
 * 分两层：
 * 1. 规则层（免费、确定性）：卖点逐字比对（复用 copyCheck）、有卖点却没有任何画面文案、
 *    广告法绝对化用语 / 医疗功效承诺 / 引流词。
 * 2. 模型层（一次调用）：色情低俗、政治敏感、暴力赌博迷信、冒充官方这类规则查不准的，
 *    交给文本模型判。**模型判失败不做拦截** —— 校对本身不能把正常发货流程卡死。
 *
 * 为什么违规词表里没有色情 / 政治词：这类词表既查不准（改写一下就不命中），
 * 放在公开仓库里也不合适，所以统一交给模型判断，规则层只放商业广告类的硬性违禁词。
 */

import type { ApiProfile } from '../types'
import { chat } from './sopPipeline'
import { normalizeCopy } from './copyDedupe'
import { checkPromptCopy, extractQuotedCopy, splitCopyLines } from './copyCheck'

export interface BannedWordRule {
  label: string
  pattern: RegExp
}

/**
 * 写进画面就是违规的词。
 *
 * 「第一」这类单字太容易误伤（「第一张」「第一步」），所以只收明确的组合；
 * 「不画二维码」「不要出现按钮」这种否定句由 isNegated 放过。
 */
export const BANNED_WORD_RULES: BannedWordRule[] = [
  {
    label: '绝对化用语',
    pattern: /国家级|最高级|最佳|最好用|第一品牌|行业第一|全国第一|全网最低|顶流|极致|唯一|独家|史无前例|万能|100%|百分百/g,
  },
  {
    label: '医疗功效承诺',
    pattern: /治愈|根治|包治|药到病除|无副作用|零风险|永久有效|立即见效|保证赔付|保证报销|必赔|稳赚/g,
  },
  {
    label: '引流 / 诱导点击',
    pattern: /加微信|微信号|扫码|二维码|点击领取|立即领取|立即购买|私信|下载\s*APP|咨询客服|添加客服/gi,
  },
]

/**
 * 命中词前面几个字内出现这些词，说明是在「别画」而不是「要画」。
 *
 * 单独一个「不」也算：提示词里常见「也不加微信号」「不出现二维码」这类说法，
 * 否定的写法太多，逐个列举反而漏判。宁可少报一个违规，也别把正常提示词拦下来。
 */
const NEGATION_RE = /(不|禁止|严禁|避免|勿|别|莫)/

function isNegated(text: string, index: number): boolean {
  // 只看前 8 个字：太远就与这个词无关了
  return NEGATION_RE.test(text.slice(Math.max(0, index - 8), index))
}

export interface BannedWordHit {
  label: string
  word: string
}

/** 扫出提示词里的违规词（跳过被否定的那些） */
export function findBannedWords(prompt: string): BannedWordHit[] {
  const hits: BannedWordHit[] = []
  const seen = new Set<string>()
  for (const rule of BANNED_WORD_RULES) {
    // 正则带 g，复用时会记住 lastIndex，每次重置
    rule.pattern.lastIndex = 0
    for (const match of prompt.matchAll(rule.pattern)) {
      const index = match.index ?? 0
      if (isNegated(prompt, index)) continue
      const word = match[0].trim()
      const key = `${rule.label}:${word}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ label: rule.label, word })
    }
  }
  return hits
}

/** 一条提示词被判不能发的理由 */
export interface PromptBlock {
  /** 在传进来的 prompt 数组里的下标（从 0 开始） */
  index: number
  reasons: string[]
}

export interface ProofreadOutcome {
  blocks: PromptBlock[]
  /** 校对过程中的附加说明（模型没跑成功之类），给用户看的 */
  notes: string[]
}

export interface RuleCheckResult {
  /** 拦下来不发的原因 */
  blocks: string[]
  /** 只提示、不拦的原因（可能有两处写法，但不影响出图） */
  warnings: string[]
}

/**
 * 规则层：拿「输入栏里选的卖点正文」和「提示词里「」包住的画面文案」对。
 *
 * 注意比的是**卖点正文**而不是卖点名字（名字只是下拉里显示的标签），
 * 一条卖点可以有多行，每行单独比对；空格、标点、全半角先归一化再比。
 *
 * 判定口径（都是为了不被正常写法误伤）：
 * - 归一化后互相包含就算同一条 —— 「600万」和「600万保额」视为一致；
 * - 卖点没进「」但正文里写了 → 只提示「没加引号」，不拦；
 * - 「」里出现与卖点无关的文字 → 只提示，不拦（可能是必要的补充小字）；
 * - 卖点既没进「」也没进正文 → 拦（这就是出「没有文案的图」的根因）。
 */
export function checkPromptRules(prompt: string, copyText: string): RuleCheckResult {
  const blocks: string[] = []
  const warnings: string[] = []
  const copyLines = splitCopyLines(copyText)
  const quoted = extractQuotedCopy(prompt)

  if (copyLines.length) {
    const checked = checkPromptCopy([prompt], copyText)
    const bodyNorm = normalizeCopy(prompt)
    const missing = checked.issues.filter((item) => item.kind === 'missing').map((item) => item.detail)

    for (const issue of checked.issues) {
      if (issue.kind === 'altered') {
        warnings.push(`多出卖点以外的画面文案「${issue.detail}」`)
      }
    }
    for (const line of missing) {
      if (bodyNorm.includes(normalizeCopy(line))) {
        warnings.push(`卖点「${line}」写在正文里但没加「」，模型可能不把它当画面文字`)
      } else {
        blocks.push(`缺卖点「${line}」`)
      }
    }
    // 一个「」都没有、卖点也没写进正文：典型「出纯画面无字图」，单独给一句更直白的
    if (!quoted.length && missing.length === copyLines.length && !copyLines.some((line) => bodyNorm.includes(normalizeCopy(line)))) {
      blocks.unshift('整条提示词里没有任何画面文案（卖点一个字都没写进去）')
    }
  }

  for (const hit of findBannedWords(prompt)) {
    blocks.push(`含${hit.label}「${hit.word}」`)
  }
  return { blocks: Array.from(new Set(blocks)), warnings: Array.from(new Set(warnings)) }
}

const COMPLIANCE_SYSTEM = [
  '你是广告投放素材的合规审核员。用户会给你若干条「生图提示词」，判断每条要画出来的内容或文字有没有违规。',
  '只判这几类：色情低俗；政治敏感（领导人、国旗国徽不当使用、敏感事件、地图残缺或错绘）；暴力血腥；赌博；封建迷信；医疗功效夸大或承诺赔付；冒充官方机构、伪造资质。',
  '画面风格、构图、配色、机位、版式这类描述不算违规，不要因为出现人物、儿童、药品包装就判违规。',
  '提示词里写「不要画二维码」「避免出现按钮」这类禁忌说明，是被禁止的对象，不算违规。',
  '只输出 JSON 数组，不要解释、不要代码块：违规的条目输出 {"index":序号,"reason":"不超过 20 字的原因"}，序号从 1 开始；一条都不违规就输出 []。',
  '拿不准的一律不判违规（宁可放过，不要误杀正常的投放素材）。',
].join('\n')

/** 从模型回复里抠出 JSON 数组；抠不出来返回 null（调用方当作校对没跑成功） */
export function parseComplianceReply(raw: string, count: number): Array<{ index: number; reason: string }> | null {
  const text = (raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const out: Array<{ index: number; reason: string }> = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const record = item as { index?: unknown; reason?: unknown }
    const index = Number(record.index)
    // 序号越界的条目直接丢：模型偶尔会把序号写成 0 或超出条数
    if (!Number.isFinite(index) || index < 1 || index > count) continue
    const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
    out.push({ index: index - 1, reason: reason || '模型判定为违规' })
  }
  return out
}

/** 一次把整批提示词交给模型判违规；失败返回空并带一条 note */
async function checkCompliance(
  profile: ApiProfile,
  prompts: string[],
  copyText: string,
): Promise<{ violations: Map<number, string>; note?: string }> {
  const violations = new Map<number, string>()
  if (!prompts.length) return { violations }
  try {
    const user = [
      copyText.trim() ? `【这批素材要用的卖点文案】\n${copyText.trim()}` : '',
      `【提示词】\n${prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')}`,
    ].filter(Boolean).join('\n\n')
    const raw = await chat(
      profile,
      [
        { role: 'system', content: COMPLIANCE_SYSTEM },
        { role: 'user', content: user },
      ],
      // 审核是短任务，超时给短一点，卡住就跳过而不是拖住整批
      90,
      4000,
      0,
    )
    const parsed = parseComplianceReply(raw, prompts.length)
    if (!parsed) return { violations, note: '合规检查没看懂模型回复，已跳过这一项' }
    for (const item of parsed) violations.set(item.index, item.reason)
    return { violations }
  } catch (err) {
    console.warn('合规检查失败，已跳过', err)
    return { violations, note: '合规检查没跑成功，已跳过这一项' }
  }
}

export interface ProofreadInput {
  profile: ApiProfile
  prompts: string[]
  /** 这批要用的卖点原文（SOP 模式才有；普通 / 变量模式留空就只查违规） */
  copyText?: string
  /** 本次校对的开关；关掉就直接全放过 */
  enabled?: boolean
}

/**
 * 校对一整批提示词，返回哪几条不能发。
 *
 * 不负责过滤：调用方按 index 自己摘（变量模式还有图片分配、填词结果等并行的数组要一起摘）。
 */
export async function proofreadPrompts({ profile, prompts, copyText = '', enabled = true }: ProofreadInput): Promise<ProofreadOutcome> {
  if (!enabled || !prompts.length) return { blocks: [], notes: [] }

  const reasons = new Map<number, string[]>()
  const push = (index: number, reason: string) => {
    const list = reasons.get(index) ?? []
    if (!list.includes(reason)) list.push(reason)
    reasons.set(index, list)
  }

  const warnings: string[] = []
  prompts.forEach((prompt, index) => {
    const checked = checkPromptRules(prompt, copyText)
    for (const reason of checked.blocks) push(index, reason)
    for (const warning of checked.warnings) warnings.push(`第 ${index + 1} 条：${warning}`)
  })

  const notes: string[] = []
  if (warnings.length) notes.push(describeWarnings(warnings))
  const compliance = await checkCompliance(profile, prompts, copyText)
  if (compliance.note) notes.push(compliance.note)
  for (const [index, reason] of compliance.violations) push(index, `疑似违规：${reason}`)

  const blocks = [...reasons.entries()]
    .map(([index, list]) => ({ index, reasons: list }))
    .sort((a, b) => a.index - b.index)
  return { blocks, notes }
}

/** 按 blocked 下标摘出还能发的那些，并行数组（图片分配、填词结果）用同一份下标摘 */
export function keepIndexes(total: number, blocks: PromptBlock[]): number[] {
  const blocked = new Set(blocks.map((item) => item.index))
  const kept: number[] = []
  for (let index = 0; index < total; index += 1) {
    if (!blocked.has(index)) kept.push(index)
  }
  return kept
}

/** 把「第几条、什么问题」整理成一句能放进 toast 的话 */
export function describeBlocks(blocks: PromptBlock[], max = 3): string {
  const parts = blocks.slice(0, max).map((item) => `第 ${item.index + 1} 条：${item.reasons[0]}`)
  const rest = blocks.length - parts.length
  return `${parts.join('；')}${rest > 0 ? `；另有 ${rest} 条` : ''}`
}

/** 只提示不拦的那些也别刷屏：最多列 3 条 */
export function describeWarnings(warnings: string[], max = 3): string {
  const parts = warnings.slice(0, max)
  const rest = warnings.length - parts.length
  return `${parts.join('；')}${rest > 0 ? `；另有 ${rest} 处` : ''}`
}
