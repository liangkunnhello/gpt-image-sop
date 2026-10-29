/**
 * 单任务自定义文案：输入框上方那一栏「本次文案」。
 *
 * 为什么要单独一栏：卖点是「按方向记、会一直被记住」的库配置，临时换一套文案出图
 * 就得去库里改预设、发完再改回来。这一栏是**只对这一批生效**的手写文案，
 * 填了就参与本次出图，不填就跟以前一样（只用卖点）。
 *
 * 位置：排在该方向的卖点**前面** —— 手写的更贴近这一次的意图，
 * 卖点原文跟在后面补充，两者合成一份「图上文字的唯一来源」。
 */

/**
 * 合并「本次自定义文案 + 所选卖点」，按约定的顺序（自定义在前）。
 *
 * - 两边都有 → 自定义文案、空行、卖点（分段，模型不会把两段混成一句）
 * - 只有一边 → 就是那一边
 * - 都没有 → 空串（不再往下拼，保持「图上文字」为空的原行为）
 */
export function mergeTaskCopy(custom: string | undefined, preset: string | undefined): string {
  const customText = String(custom ?? '').trim()
  const presetText = String(preset ?? '').trim()
  if (!customText) return presetText
  if (!presetText) return customText
  // 卖点原文里已经包含这段时不再重复：用户手写的东西常常是卖点里的一句
  if (presetText.includes(customText)) return presetText
  return `${customText}\n\n${presetText}`
}

/**
 * 自定义文案在界面上怎么显示：单行摘要。
 * 换行全都压掉，多行文案在按钮上只占一行，具体内容点开编辑看。
 */
export function customCopySummary(text: string, maxLength = 12): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat
}

/**
 * 自定义文案里「应逐字出现在图上」的条目，拆成质检用的期望文案。
 *
 * 用户填的通常是几行卖点句子，一行就是一句。这里只按行拆，不做别的推断 ——
 * 猜错会把质检判成「缺文案」，反而更糟。
 */
export function customCopyLines(text: string): string[] {
  return String(text ?? '')
    .split(/\n|；|;/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * 普通模式下拼到提示词最前面的那一小段。
 *
 * 普通模式没有「文案区块」这个概念，只能把文案平铺进提示词前缀。
 * 自定义文案与卖点各带标签、各自成行 —— 都套「卖点：」会让人分不清
 * 哪句是自己手写的、哪句是库里那份。
 */
export function buildCopyPrefix(input: {
  customCopy?: string
  point?: string
  style?: string
}): string {
  const custom = String(input.customCopy ?? '').trim()
  const point = String(input.point ?? '').trim()
  const style = String(input.style ?? '').trim()
  return [
    custom ? `文案：${custom}` : '',
    point ? `卖点：${point}` : '',
    style ? `风格：${style}` : '',
  ].filter(Boolean).join('\n')
}
