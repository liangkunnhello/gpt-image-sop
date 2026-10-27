/**
 * 任务 ID 的展示与复制。
 *
 * 任务 id 是「base36 时间戳 + 序号 + 4 位随机串」，尾部随机性最强，
 * 所以卡片上只显示尾部几位：既能一眼区分，又不会把标签行撑开。
 * 复制出去的始终是完整 id —— 沟通时对方要拿它去对任务。
 */

/** 卡片上显示的短 id 长度 */
export const SHORT_TASK_ID_LENGTH = 6

/** 短 id：太长就取尾部；本身很短就原样返回 */
export function shortTaskId(id: string, length = SHORT_TASK_ID_LENGTH): string {
  const trimmed = (id || '').trim()
  if (!trimmed) return ''
  const size = Math.max(1, Math.floor(length))
  return trimmed.length <= size ? trimmed : trimmed.slice(-size)
}

/** 卡片 / 详情页上展示的形态，前面带 # 表示这是个编号 */
export function taskIdLabel(id: string, length = SHORT_TASK_ID_LENGTH): string {
  const short = shortTaskId(id, length)
  return short ? `#${short}` : ''
}

/** 复制到剪贴板的内容：完整 id，不加 # 方便直接粘进链接或搜索框 */
export function taskIdCopyText(id: string): string {
  return (id || '').trim()
}
