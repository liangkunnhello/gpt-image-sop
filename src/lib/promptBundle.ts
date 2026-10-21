/**
 * 把「系统提示词 / 卖点 / 风格」三份 Markdown 合成一份发给模型。
 *
 * 前端分区是为了好维护，但模型只看一份文本：分开喂的时候，系统提示词里的
 * 旧文案、参考图上的文案很容易盖过卖点，实测生图就不按卖点写了。
 * 所以合并时把优先级写死：文案 > 系统提示词 > 风格，且文案是图上文字的唯一来源。
 */

export interface PromptBundleInput {
  /** 系统提示词（画面/版式/执行要求） */
  systemPrompt?: string
  /** 卖点文案，图上文字的唯一来源 */
  point?: string
  /** 风格 */
  style?: string
}

export interface PromptBundle {
  /** 三份合成的一份 Markdown，SOP 反推阶段用 */
  merged: string
  /** 只有卖点原文，写提示词阶段再单独喂一次，避免被 SOP 摘要吃掉 */
  copyText: string
}

const COPY_RULE = '优先级：文案 > 系统提示词 > 风格。图上出现的每一句文字都必须逐字来自「文案」，不得改写、缩写、扩写、合并或新增；其余部分与文案冲突时，一律以文案为准。'

export function buildPromptBundle({ systemPrompt = '', point = '', style = '' }: PromptBundleInput): PromptBundle {
  const system = systemPrompt.trim()
  const copy = point.trim()
  const styleText = style.trim()

  const sections: string[] = []
  if (copy) {
    sections.push(`# 文案（最高优先级 · 图上文字的唯一来源）\n${copy}`)
  }
  if (system) {
    sections.push(`# 系统提示词（画面、版式与执行要求）\n${system}`)
  }
  if (styleText) {
    sections.push(`# 风格\n${styleText}`)
  }

  const merged = sections.length
    ? [copy ? `> ${COPY_RULE}` : '', sections.join('\n\n---\n\n')].filter(Boolean).join('\n\n')
    : ''

  return { merged, copyText: copy }
}
