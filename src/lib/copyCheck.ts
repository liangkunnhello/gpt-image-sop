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
 * 逐条比对：
 * - 卖点每一条都必须出现在「」里（missing 表示漏了）
 * - 「」里不能出现卖点以外的文字（altered 表示被改写或自己加了字）
 * 长度小于 2 的碎片不做 altered 判定，避免把「¥」「1」这类误判成篡改。
 */
export function checkPromptCopy(prompts: string[], copyText: string): CopyCheckResult {
  const lines = splitCopyLines(copyText)
  const expected = new Set(lines.map(normalizeCopy))
  if (!expected.size) return { ok: true, issues: [] }

  const issues: CopyCheckIssue[] = []
  prompts.forEach((prompt, index) => {
    const quoted = extractQuotedCopy(prompt)
    const got = new Set(quoted.map(normalizeCopy))
    for (const line of lines) {
      if (!got.has(normalizeCopy(line))) {
        issues.push({ index, kind: 'missing', detail: line })
      }
    }
    for (const item of quoted) {
      const key = normalizeCopy(item)
      if (!expected.has(key) && key.length >= 2) {
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
