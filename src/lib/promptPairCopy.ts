/**
 * 「图片与提示词对照」里复制的文本怎么拼。
 *
 * 单条复制就是那条提示词原文，不需要处理。
 * 全部复制要能被直接粘回输入框批量跑 —— 项目的批量提示词按「空两行」切分
 * （见 splitBatchPrompts），所以这里用 \n\n 连接纯提示词，不加编号：
 * 加了「第 1 条」这种行反而会把编号也当成提示词发出去。
 */
export function joinPromptsForClipboard(prompts: Array<string | undefined | null>): string {
  const cleaned = prompts
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
  if (!cleaned.length) return ''
  // 单条不用加分隔符，原样返回
  if (cleaned.length === 1) return cleaned[0]
  return cleaned.join('\n\n')
}

/** 一条提示词是否值得复制（空白的不算，避免复制出一堆空行） */
export function hasCopyablePrompt(prompt: string | undefined | null): boolean {
  return Boolean(String(prompt ?? '').trim())
}
