import type { TaskRecord } from '../types'
import { isTaskUnread } from './unread'

/**
 * 把同一份 SOP 生成的任务合并成一张卡。
 * 以组内第一条任务作为代表（保留它的 id，选择、详情、删除都仍按它走），
 * 输出图按提示词序号合并，状态取最"差"的那个。
 */
export function groupSopTasks(tasks: TaskRecord[]): TaskRecord[] {
  const out: TaskRecord[] = []
  const groups = new Map<string, TaskRecord[]>()

  for (const task of tasks) {
    // 回收站里的任务不参与聚合，否则卡片数和侧栏计数会把已删的算进去
    if (task.deletedAt) continue
    if (!task.sopJobId) {
      out.push(task)
      continue
    }
    const bucket = groups.get(task.sopJobId)
    if (bucket) bucket.push(task)
    else groups.set(task.sopJobId, [task])
  }

  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      out.push(bucket[0])
      continue
    }
    const sorted = [...bucket].sort((a, b) => (a.sopPromptIndex ?? 0) - (b.sopPromptIndex ?? 0))
    const rep = sorted[0]
    const anyRunning = sorted.some((task) => task.status === 'running')
    const allError = sorted.every((task) => task.status === 'error')
    /**
     * 未读按整组算：组里任意一条没看过，这张卡就该提示未读。
     * 代表任务的 detailViewedAt 只属于它自己，所以这里按组重写一遍——
     * 组内全看过时取最晚的完成时间，保证后面再单独完成某条也能正确判定。
     */
    const cardUnread = sorted.some((task) => isTaskUnread(task))
    const latestFinishedAt = sorted.reduce(
      (latest, task) => Math.max(latest, task.finishedAt ?? task.createdAt),
      0,
    )
    // 普通模式拆出来的请求没有 SOP 正文，标题按「张图」算，别写成「条提示词」
    const plainBatch = !rep.sopText
    out.push({
      ...rep,
      prompt: plainBatch
        ? `${rep.sopName || '批量'} · ${sorted.length} 张图`
        : `${rep.sopName || 'SOP'} · ${sorted.length} 条提示词`,
      outputImages: sorted.flatMap((task) => task.outputImages),
      outputErrors: sorted.flatMap((task) => task.outputErrors ?? []),
      status: anyRunning ? 'running' : allError ? 'error' : 'done',
      elapsed: sorted.reduce((sum, task) => sum + (task.elapsed ?? 0), 0),
      detailViewedAt: cardUnread ? undefined : Math.max(rep.detailViewedAt ?? 0, latestFinishedAt),
    })
  }

  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/** 某个 SOP 卡片下的全部真实任务 */
export function tasksOfSopJob(tasks: TaskRecord[], sopJobId: string | undefined) {
  if (!sopJobId) return []
  return tasks
    .filter((task) => task.sopJobId === sopJobId)
    .sort((a, b) => (a.sopPromptIndex ?? 0) - (b.sopPromptIndex ?? 0))
}
