/**
 * 生图前校验：提示词里印在画面上的文字，必须和所选卖点逐字一致。
 *
 * 为什么要有这一步：写提示词时模型会顺手改写、缩写、合并卖点，或者自己加一句
 * 「限时」「爆款」这类装饰文字。图一旦出来才发现，只能重跑，成本比校验高得多。
 * 这里做确定性比对：不一致就交给模型按专门提示词改回原文，改完再验一次。
 */

import { normalizeCopy } from './copyDedupe'

/** 卖点原文拆成条目：一行一条，忽略空行与列表符号 */
export function splitCopyLines(copyText: string): string[] {
  return copyText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*·•]\s*/, '').trim())
    .filter(Boolean)
}

/** 取出一条提示词里所有「」包裹的文案 */
export function extractQuotedCopy(prompt: string): string[] {
  return [...prompt.matchAll(/「([^」]*)」/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
}

export type CopyIssueKind = 'missing' | 'altered'

export interface CopyCheckIssue {
  /** 第几条提示词（从 0 开始） */
  index: number
  kind: CopyIssueKind
  /** missing：缺的卖点原文；altered：提示词里多出来/被改写的文字 */
  detail: string
}

export interface CopyCheckResult {
  ok: boolean
  issues: CopyCheckIssue[]
}

/**
 * 归一化后互相包含就算同一条文案。
 *
 * 卖点是「600万」，模型写成「600万保额」/「保额600万」都是同一句话的扩写，
 * 逐字相等会把这些正常写法全判成「缺卖点 + 被改写」——
 * 而这个判定现在会拦着不发，误判代价比漏判大得多。
 */
function sameCopy(a: string, b: string) {
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * 逐条比对：
 * - 卖点每一条都必须出现在「」里（missing 表示漏了），允许被扩写 / 缩写（见 sameCopy）
 * - 「」里与卖点毫无关系的文字算 altered（模型自己加的，或把卖点改得面目全非）
 * 长度小于 2 的碎片不做 altered 判定，避免把「¥」「1」这类误判成篡改。
 */
export function checkPromptCopy(prompts: string[], copyText: string): CopyCheckResult {
  const lines = splitCopyLines(copyText)
  const expected = lines.map(normalizeCopy).filter(Boolean)
  /**
   * 没有卖点清单时这里原本直接返回通过 —— 但「卖点没得比」不等于「提示词没问题」。
   * 那批 30 条里有 4 条被模型熔断在半句（第 24 条只写了 48 个字），
   * 而这一批恰好没填卖点文案，整批截断就这么流到出图阶段了。
   * 结构完整性另见 checkPromptIntegrity，由 checkPromptRules 无条件调用。
   */
  if (!expected.length) return { ok: true, issues: [] }

  const issues: CopyCheckIssue[] = []
  prompts.forEach((prompt, index) => {
    const quoted = extractQuotedCopy(prompt)
    const quotedNorm = quoted.map(normalizeCopy).filter(Boolean)
    for (const line of lines) {
      const key = normalizeCopy(line)
      if (!key) continue
      if (!quotedNorm.some((item) => sameCopy(item, key))) {
        issues.push({ index, kind: 'missing', detail: line })
      }
    }
    for (const item of quoted) {
      const key = normalizeCopy(item)
      if (!key || key.length < 2) continue
      if (!expected.some((line) => sameCopy(key, line))) {
        issues.push({ index, kind: 'altered', detail: item })
      }
    }
  })
  return { ok: issues.length === 0, issues }
}

/** 把校验结果整理成一句能放进 toast 的话 */
export function describeCopyIssues(issues: CopyCheckIssue[]): string {
  const missing = issues.filter((item) => item.kind === 'missing')
  const altered = issues.filter((item) => item.kind === 'altered')
  const parts: string[] = []
  if (missing.length) parts.push(`${missing.length} 处卖点缺失`)
  if (altered.length) parts.push(`${altered.length} 处文案被改写`)
  return parts.join('、') || '卖点一致'
}

/**
 * 提示词**结构完整性**检测：判断这一条是不是被模型写到一半就断了。
 *
 * 为什么必须有这道检测（真实事故）：
 * 一批 30 条 SOP 提示词里有 4 条被熔断在句子中间——第 11 条断在
 * 「内部文字分别规范排布「赔付总限额6」（连金额都没写完），第 24 条只写了 48 个字
 * 就停在「暖阳米黄色调」。而卖点校验**一条都没报**，因为：
 * 1) 没填卖点文案时 checkPromptCopy 直接返回 ok；
 * 2) 卖点比对只看「卖点有没有出现」，不看「这句话说完了没有」。
 * 结果这 4 张废图一路流到出图阶段，白花 4 次 4K 生成。
 *
 * 三个判据（任一命中就算不完整）：
 * - **引号未闭合**：`「` 比 `」` 多。这是最强的信号，截断几乎都发生在这里；
 * - **过短**：不足同批中位数的 55%。模型正常写 380~460 字，48 字的必然是断的；
 * - **没有收尾**：正常条都以留白/无按钮/无构件这类收束语结束，截断条则停在动词上。
 *
 * 过短判据需要参照值，所以按整批传进来（`lengths` 由调用方提供）。
 */
export interface PromptIntegrityIssue {
  index: number
  reason: string
}

/**
 * 判断结尾像不像「话说完了」。
 *
 * 第一版用「必须以留白/无/干净等词结尾」，实测误报 5 条（4/5/6/23/29）：
 * 这几条明明正常结束，只是那些词出现在句中而不是句尾。
 * 第二版要求「最后分句 ≥8 字」，又误报了大半批 —— 中文收尾句本来就短
 * （「无系统交互控件」只有 7 字），门槛过高等于把正常条全判死。
 *
 * 现在的判据只保留两条，都是截断条才会触发的特征：
 * 1) **没有句末标点**（。！？）—— 实测 4 条截断里 3 条停在字符中间，全都没有句号；
 * 2) **最后分句悬空**—— 停在「写入」「展示」「排布」这类纯动词上，后面显然还有内容。
 */
const DANGLING_TAIL = /(?:的|和|与|或|及|并|写入|展示|排布|标注|呈现|对应|依次|分别)$/

 /**
  * 「结尾没有收束语」这个判据只对足够长的提示词生效。
  *
  * 理由：一条 400 字的 SOP 提示词没有句号，几乎必然是写到一半断了；
  * 但一条 5 字的短句（「正常」「一条有问题」这类）本来就不需要句号。
  * 不加这个门槛会把所有简短提示词都判成截断 —— 实测在校对模块的既有用例里
  * 就直接误报了 7 条。
  */
 const MIN_LENGTH_FOR_TAIL_CHECK = 100

function hasTail(prompt: string) {
  const text = prompt.trim()
  if (!text) return false
  // 太短的提示词不判收尾：短句本来就可以没有句号
  if (text.length < MIN_LENGTH_FOR_TAIL_CHECK) return true
  // 没有句末标点：句子没说完。这是最强的信号，4 条截断全部命中
  if (!/[。！？]$/.test(text)) return false
  // 有句号但停在悬空动词上，后面还有内容没写出来
  const lastClause = text.replace(/[。！？]+$/, '').split(/[，、；：]/).pop() ?? ''
  return !DANGLING_TAIL.test(lastClause)
}

/** 单条判断，参照值是「同批其他条的中位长度」 */
export function checkPromptIntegrity(prompt: string, medianLength: number): string | null {
  const text = prompt.trim()
  if (!text) return '提示词是空的'

  const opens = (text.match(/「/g) ?? []).length
  const closes = (text.match(/」/g) ?? []).length
  if (opens > closes) return `引号没闭合（「${opens} 个 / 」${closes} 个），句子被截断`

  /**
   * 过短判定：低于中位数 55% 就算。
   *
   * 但必须叠加一个绝对下限：同批都是 5~9 字的短提示词时，「中位数的 55%」
   * 会把 3 字的正常短句判成截断（实测在校对模块的既有用例里误报了）。
   * SOP 的真实提示词是 380~460 字，所以只对「本来该长」的批次启用这条，
   * 判据是**中位长度本身够长**（≥200 字）。
   */
  if (medianLength >= 200 && text.length < medianLength * 0.55) {
    return `只有 ${text.length} 字（同批中位 ${medianLength} 字），很可能写到一半就断了`
  }

  if (!hasTail(text)) return '结尾没有收束语，像是句子没说完'

  return null
}

/** 整批检测：需要同批所有条一起算中位长度，单条自己判断不了「过短」 */
export function checkPromptsIntegrity(prompts: string[]): PromptIntegrityIssue[] {
  const lengths = prompts.map((prompt) => prompt.trim().length).filter(Boolean)
  if (!lengths.length) return []
  const ordered = [...lengths].sort((a, b) => a - b)
  const median = ordered[Math.floor(ordered.length / 2)]
  const issues: PromptIntegrityIssue[] = []
  prompts.forEach((prompt, index) => {
    const reason = checkPromptIntegrity(prompt, median)
    if (reason) issues.push({ index, reason })
  })
  return issues
}
