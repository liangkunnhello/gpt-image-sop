/**
 * 把「系统提示词 / 卖点 / 风格 / 额外要求」几份 Markdown 合成一份发给模型。
 *
 * 前端分区是为了好维护，但模型只看一份文本：分开喂的时候，系统提示词里的
 * 旧文案、参考图上的文案很容易盖过卖点，实测生图就不按卖点写了。
 * 所以合并时把优先级写死：文案 > 系统提示词 > 风格，且文案是图上文字的唯一来源。
 */

/** 输入框原文在合成结果里的标题：排在系统提示词之后，作为本次的额外画面要求 */
export const INPUT_PROMPT_HEADER = '# 本次要求（输入框里写的，优先级高于系统提示词）'

export interface PromptBundleInput {
  /**
   * 输入框里写的原文。
   *
   * SOP / 变量模式下输入框不会直接成为提示词（提示词由模型按 SOP 写），
   * 但用户写下的往往是这次的具体意图（「把固定图完整植入图片」这类），
   * 必须带进生成链路，否则他写了字却看不到任何影响。
   */
  inputPrompt?: string
  /** 系统提示词（画面/版式/执行要求） */
  systemPrompt?: string
  /** 卖点文案，图上文字的唯一来源 */
  point?: string
  /** 风格 */
  style?: string
  /**
   * 额外要求：可编辑的规则文本（不参考 logo、不要按钮、避开预留区…）。
   * 优先级排在文案之后、系统提示词之前 —— 它们是硬性约束，不能被系统提示词里的措辞盖掉。
   */
  extras?: string[]
}

export interface PromptBundle {
  /** 几份合成的一份 Markdown，SOP 反推 / 变量提策略阶段用 */
  merged: string
  /** 只有卖点原文，写提示词阶段再单独喂一次，避免被 SOP 摘要吃掉 */
  copyText: string
  /**
   * 输入框原文（已 trim）。
   * 反推阶段并进 merged 就够了，写提示词 / 填词阶段还要单独再喂一次 ——
   * 模型按 SOP 写词时很容易只看 SOP，把用户这次的具体要求丢掉。
   */
  inputPrompt: string
}

const COPY_RULE = '优先级：文案 > 系统提示词 > 风格。图上出现的每一句文字都必须逐字来自「文案」，不得改写、缩写、扩写、合并或新增；其余部分与文案冲突时，一律以文案为准。'

export function buildPromptBundle({
  inputPrompt = '',
  systemPrompt = '',
  point = '',
  style = '',
  extras = [],
}: PromptBundleInput): PromptBundle {
  const input = inputPrompt.trim()
  const system = systemPrompt.trim()
  const copy = point.trim()
  const styleText = style.trim()
  const extraLines = extras.map((item) => item.trim()).filter(Boolean)

  const sections: string[] = []
  if (copy) {
    sections.push(`# 文案（最高优先级 · 图上文字的唯一来源）\n${copy}`)
  }
  if (extraLines.length) {
    sections.push(`# 额外要求（硬性约束，必须遵守）\n${extraLines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`)
  }
  if (system) {
    sections.push(`# 系统提示词（画面、版式与执行要求）\n${system}`)
  }
  // 输入框原文排在系统提示词之后：它是「这次要怎么做」的具体要求，
  // 具体 > 通用，所以优先级写在标题里，与系统提示词冲突时以它为准
  if (input) {
    sections.push(`${INPUT_PROMPT_HEADER}\n${input}`)
  }
  if (styleText) {
    sections.push(`# 风格\n${styleText}`)
  }

  const merged = sections.length
    ? [copy ? `> ${COPY_RULE}` : '', sections.join('\n\n---\n\n')].filter(Boolean).join('\n\n')
    : ''

  return { merged, copyText: copy, inputPrompt: input }
}
