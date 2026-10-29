import type { TaskRecord } from '../types'

/**
 * 这个任务是不是「正在生成」。
 *
 * 口径要和任务卡上的「生成中…」完全一致，否则会出现「卡片在转圈、侧栏却没有任何提示」
 * 这种对不上的情况：
 * - status === 'running'          → 真在跑
 * - status === 'error' 但可恢复    → fal / 自定义服务商断线重连中，逻辑上仍在等结果
 *
 * 显式排除占位卡：SOP 反推阶段的占位任务还没拿到提示词，没有图可看，
 * 用户视角里它只是「正在准备」，和真正的出图进度不是一回事。
 */
export function isTaskGenerating(task: TaskRecord): boolean {
  if (task.sopPlaceholder) return false
  if (task.deletedAt) return false
  if (task.status === 'running') return true
  return task.status === 'error' && Boolean(task.falRecoverable || task.customRecoverable)
}

/** 一张卡里只要有一条还在跑，整张卡就算在生成（SOP / 变量卡的图来自多条任务） */
export function isAnyTaskGenerating(tasks: TaskRecord[]): boolean {
  return tasks.some((task) => isTaskGenerating(task))
}

/**
 * 有任务正在生成的「产品-方向」归属节点集合。
 *
 * 和未读红点一样要**往上卷**：方向在跑时，它所属的产品、业务线（分类）也该亮，
 * 否则把产品折叠起来就完全看不出来「下面有东西在跑」。
 *
 * @param ancestorOf 给一个节点 id，返回它的祖先 id 列表（不含自身）
 */
export function generatingNodeIds(
  tasks: TaskRecord[],
  ancestorOf: (nodeId: string) => string[],
): Set<string> {
  const out = new Set<string>()
  for (const task of tasks) {
    if (!isTaskGenerating(task)) continue
    const directionId = task.sopDirectionId
    if (!directionId) continue
    out.add(directionId)
    for (const id of ancestorOf(directionId)) out.add(id)
  }
  return out
}
