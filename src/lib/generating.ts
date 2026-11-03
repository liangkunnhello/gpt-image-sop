import type { TaskRecord } from '../types'

/**
 * 这个任务是不是「正在生成」。
 *
 * 口径要和任务卡上的「生成中…」完全一致，否则会出现「卡片在转圈、侧栏却没有任何提示」
 * 这种对不上的情况：
 * - status === 'running'          → 真在跑
 * - status === 'error' 但可恢复    → fal / 自定义服务商断线重连中，逻辑上仍在等结果
 *
 * **占位卡也算在生成中。**
 * 这里原来显式排除占位卡，理由是「反推阶段还没拿到提示词，没有图可看，只是准备」。
 * 但用户已经点了发送、这段时间一样要等，侧栏却什么都没亮 ——
 * 反推 + 写提示词常常要好几分钟，看起来就像「发了没反应」。
 * 既然任务卡上本来就是「生成中…」+ 蓝边框，侧栏的蓝点也该同时亮起，两边才对得上。
 */
export function isTaskGenerating(task: TaskRecord): boolean {
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
