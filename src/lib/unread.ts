import type { TaskRecord } from '../types'

/**
 * 首次启用未读提示的时间点，存在本地。
 *
 * 没有它的话，升级后第一次打开，几个月前生成、早就看过的任务会一起冒红点，
 * 而且没法一键消掉。基线之前完成的任务统一按已读处理。
 */
const UNREAD_SINCE_KEY = 'gpt-image-sop:unread-since'

function readUnreadSince(): number {
  try {
    if (typeof localStorage === 'undefined') return 0
    const saved = Number(localStorage.getItem(UNREAD_SINCE_KEY) ?? 0)
    if (saved > 0) return saved
    const now = Date.now()
    localStorage.setItem(UNREAD_SINCE_KEY, String(now))
    return now
  } catch {
    // 隐私模式等取不到存储时不做基线限制，功能照常
    return 0
  }
}

const unreadSince = readUnreadSince()

/**
 * 结果出来之后有没有被看过。
 *
 * 用「查看时间 vs 完成时间」判断而不是维护一个布尔值：
 * 重试、重新生成会让 finishedAt 往后走，卡片会自动重新变成未读，不需要额外清标记。
 * 生成中、失败、占位卡都没有「新结果」可看，统一不算未读。
 *
 * @param since 只提示这个时间之后完成的任务；默认用本地记录的启用时间
 */
export function isTaskUnread(task: TaskRecord, since = unreadSince): boolean {
  if (task.sopPlaceholder) return false
  if (task.status !== 'done') return false
  if (!task.outputImages?.length) return false
  const finishedAt = task.finishedAt ?? task.createdAt
  if (finishedAt < since) return false
  return !task.detailViewedAt || task.detailViewedAt < finishedAt
}

/** 一张卡里只要还有一条没看过，整张卡就算未读（SOP / 变量卡由多条任务拼成） */
export function isAnyTaskUnread(tasks: TaskRecord[]): boolean {
  return tasks.some((task) => isTaskUnread(task))
}
