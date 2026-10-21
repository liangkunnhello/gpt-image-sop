/**
 * 卖点分配到每一条提示词，保证一轮里同一句卖点不重复出现。
 *
 * 之前是把整段卖点原样喂给模型，让它「自己看着用」，结果每张图都把同一批卖点写一遍。
 * 改成先按行/分号拆成条目，再按条数分配：卖点够就均摊，不够就让后面的图改成不需要文字的版式。
 */

/** 去掉行首的项目符号与序号，保留文案本身 */
function stripBullet(line: string): string {
  return line
    .replace(/^\s*(?:[-*+•·]|\d+[.、)）]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/, '')
    .trim()
}

/**
 * 拆卖点：先按行拆，再把一行里的「；」「;」拆开；重复的条目只留一条。
 * 逗号不拆，避免把一句文案切碎。
 */
export function splitCopyItems(copyText: string): string[] {
  const items: string[] = []
  const seen = new Set<string>()
  for (const rawLine of copyText.replace(/\r\n/g, '\n').split('\n')) {
    for (const part of rawLine.split(/[；;]/)) {
      const text = stripBullet(part).replace(/\s+/g, ' ')
      if (!text) continue
      if (seen.has(text)) continue
      seen.add(text)
      items.push(text)
    }
  }
  return items
}

/**
 * 把卖点分给 count 条提示词：
 * - 卖点够：均摊，前面的条目多分一个（5 条分 3 张 → 2/2/1）
 * - 卖点不够：前几条各分一个，剩下的是空数组，由版式去适配
 * 返回值长度始终等于 count，且同一句只会出现在一个位置。
 */
export function planCopyAssignment(copyText: string, count: number): string[][] {
  const total = Math.max(0, Math.floor(count))
  const plan: string[][] = Array.from({ length: total }, () => [])
  const items = splitCopyItems(copyText)
  if (!total || !items.length) return plan

  if (items.length >= total) {
    const base = Math.floor(items.length / total)
    const extra = items.length % total
    let cursor = 0
    for (let index = 0; index < total; index += 1) {
      const take = base + (index < extra ? 1 : 0)
      plan[index] = items.slice(cursor, cursor + take)
      cursor += take
    }
    return plan
  }

  for (let index = 0; index < items.length; index += 1) plan[index] = [items[index]]
  return plan
}
