import type { TaskRecord } from '../types'
import { isTaskUnread } from './unread'

/**
 * 把同一份 SOP 生成的任务合并成一张卡。
 * 以组内第一条任务作为代表（保留它的 id，选择、详情、删除都仍按它走），
 * 输出图按提示词序号合并，状态取最"差"的那个。
 */
/**
 * 「输入内容」该显示什么。
 *
 * 规则只有一条：显示**发送瞬间输入框里的原文**。
 * - 有快照：直接用 snapshot.prompt（普通模式就是用户写的提示词；SOP / 变量模式多半是空的）
 * - 没有快照的老任务：靠 variableMode / sopText 认 SOP / 变量卡，也给空；
 *   普通卡退回各条提示词拼接（内容相同会去重）
 *
 * 为什么不显示 task.prompt：SOP / 变量模式下它是模型写出来的最终提示词（几十条、每条几千字），
 * 堆进「输入内容」既不是用户填的东西，也把面板撑成一片文字墙。那些内容在
 * 「每条提示词与它产出的图」入口里逐条看。
 */
export function resolveCardInputText(group: TaskRecord[]): { text: string; fromInputBox: boolean } {
  const withSnapshot = group.find((item) => item.inputSnapshot)
  if (withSnapshot?.inputSnapshot) {
    return { text: (withSnapshot.inputSnapshot.prompt ?? '').trim(), fromInputBox: true }
  }
  if (group.some((item) => item.variableMode || item.sopText)) {
    return { text: '', fromInputBox: true }
  }
  return { text: mergePromptText(group.map((item) => item.prompt)).text, fromInputBox: false }
}

/**
 * 把同一张卡里多条任务的提示词合并成「输入内容」显示。
 *
 * 批量生图常见「同一条提示词跑 N 张」，直接拼会得到同一段话重复 N 遍；
 * 所以先按内容去重（保留第一次出现的顺序），只有内容真的不同时才按空行分段。
 */
export function mergePromptText(prompts: Array<string | undefined | null>): { text: string; count: number } {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of prompts) {
    const value = String(raw ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return { text: unique.join('\n\n'), count: unique.length }
}

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
     * 图片回收站的标记也要按整组拼起来。
     *
     * 卡片展示的是全组的 outputImages，但「哪些图进了回收站」只记在真正持有它的那条任务上；
     * 只带代表任务自己那份数组的话，兄弟任务里的图即使进了回收站也照样显示（还会被交付）。
     */
    const trashed = sorted.flatMap((task) => task.trashedOutputImages ?? [])
    /** 人工改判同理：改判跟着持有图的任务走，展示层要按整组合并 */
    const qcVerdicts: Record<string, 'pass' | 'fail'> = {}
    for (const task of sorted) Object.assign(qcVerdicts, task.qcVerdicts ?? {})
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
    // 输入内容要显示真正提交的提示词，不能拿「批量 · N 张图」这种概况顶替：
    // 详情页/卡片上的「输入内容」就是这一栏，概况会让人以为提示词丢了。
    const merged = mergePromptText(sorted.map((task) => task.prompt))
    out.push({
      ...rep,
      prompt: merged.text || rep.prompt,
      outputImages: sorted.flatMap((task) => task.outputImages),
      outputErrors: sorted.flatMap((task) => task.outputErrors ?? []),
      trashedOutputImages: trashed.length ? trashed : undefined,
      qcVerdicts: Object.keys(qcVerdicts).length ? qcVerdicts : undefined,
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
