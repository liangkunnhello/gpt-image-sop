/**
 * 单张图内的卖点去重（确定性兜底）。
 *
 * 规则层已经要求「同一句卖点在一张图里只能出现一次」，但模型仍可能把同一句
 * 卖点先写进主标题、又写进角标。这里对写好的提示词做一次清洗：把「」包裹的
 * 文案按规范化后的文本判重，重复的只保留第一次出现，其余整段删除。
 */

/** 判重用的规范化：去掉空白、标点与全半角差异，只比较实质文字 */
export function normalizeCopy(text: string): string {
  return text
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？,.;:!?"'“”‘’「」『』（）()【】[\]·•\-—_~～/\\|]/g, '')
    .toLowerCase()
}

/** 删掉重复文案后，清理残留的空标点、悬挂标点与多余空格 */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+(?=[，。、；：！？,.;:!?])/g, '')
    .replace(/([,，、;；:：])\s*(?=[,，、;；:：。.！!？?]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface DedupeResult {
  /** 清洗后的提示词 */
  text: string
  /** 被删掉的重复卖点（原样，便于上层提示或排查） */
  removed: string[]
}

/**
 * 把一条提示词里重复出现的卖点文案删掉，只保留第一次。
 * 判重按规范化后的文本比较，所以「住院 0 免赔」与「住院0免赔」视为同一句。
 */
export function dedupeCopyInPrompt(prompt: string): DedupeResult {
  const seen = new Set<string>()
  const removed: string[] = []
  const text = prompt.replace(/「\s*([^」]*?)\s*」/g, (whole, inner: string) => {
    const key = normalizeCopy(inner)
    if (!key) return whole
    if (seen.has(key)) {
      removed.push(inner.trim())
      return ''
    }
    seen.add(key)
    return whole
  })
  if (!removed.length) return { text: prompt, removed }
  return { text: tidy(text), removed }
}

/**
 * 批量清洗一组提示词，返回清洗后的列表与被删掉的重复卖点。
 * 空白的条目会被丢弃（删掉文案后可能只剩装饰性描述）。
 */
export function dedupePrompts(prompts: string[]): { prompts: string[]; removed: string[] } {
  const removed: string[] = []
  const cleaned: string[] = []
  for (const prompt of prompts) {
    const result = dedupeCopyInPrompt(prompt)
    removed.push(...result.removed)
    if (result.text.trim()) cleaned.push(result.text)
  }
  return { prompts: cleaned, removed }
}
