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
