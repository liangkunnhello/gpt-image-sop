import type { TaskRecord } from '../types'

/**
 * 结果出来之后有没有被看过。
 *
 * 用「查看时间 vs 完成时间」判断而不是维护一个布尔值：
 * 重试、重新生成会让 finishedAt 往后走，卡片会自动重新变成未读，不需要额外清标记。
 * 生成中、失败、占位卡都没有「新结果」可看，统一不算未读。
 */
export function isTaskUnread(task: TaskRecord): boolean {
  if (task.sopPlaceholder) return false
  if (task.status !== 'done') return false
  if (!task.outputImages?.length) return false
  const finishedAt = task.finishedAt ?? task.createdAt
  return !task.detailViewedAt || task.detailViewedAt < finishedAt
}

/** 一张卡里只要还有一条没看过，整张卡就算未读（SOP / 变量卡由多条任务拼成） */
export function isAnyTaskUnread(tasks: TaskRecord[]): boolean {
  return tasks.some(isTaskUnread)
}
