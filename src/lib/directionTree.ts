/**
 * 业务树节点的删除/恢复，与任务卡的联动。
 *
 * 为什么不写在 sopStore 里：sopStore 不该反过来依赖主 store（任务存在那边），
 * 否则会形成 store → sopStore → store 的循环。这里做单向编排。
 *
 * 删除语义（按用户要求定的）：
 * 删方向 = 方向 + 它下面的任务卡一起进回收站，两者共用一个 trashBatchId。
 * 恢复时任务卡一起回来，归属原样保留 —— 不再把卡片划成「未归属」。
 * 早先的做法是「只删节点、卡片留着重置归属」，结果用户看到的是
 * "归属那个方向的任务卡不见了"，体验上等同于数据丢失。
 */

import type { SopDirectionNode, TaskRecord } from '../types'
import { purgeTrashTasks, useStore } from '../store'
import { putTask } from '../lib/db'
import { useSopStore } from './sopStore'

/**
 * 节点在树里的「实际身份」。
 *
 * 为什么不信 kind 字段：老版本建的节点 kind 可能写错（历史数据里出现过
 * 挂在类目下的产品被记成 direction），而右键菜单是按 kind 给操作的——
 * 一旦 kind 不对，产品行右键就不出现「新建方向」，用户直接卡住。
 * 树本身是按 parentId 渲染的，所以身份也按层级算：深度 0=类目、1=产品、2+=方向。
 */
export function effectiveNodeKind(
  nodes: Array<{ id: string; parentId: string | null }>,
  nodeId: string,
): SopDirectionNode['kind'] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>([nodeId])
  let depth = 0
  let cursor = byId.get(nodeId)
  while (cursor?.parentId) {
    // 防御脏数据里父子成环，避免死循环
    if (seen.has(cursor.parentId)) break
    const parent = byId.get(cursor.parentId)
    if (!parent) break
    seen.add(parent.id)
    cursor = parent
    depth += 1
    if (depth >= 2) return 'direction'
  }
  if (depth === 0) return 'category'
  return 'product'
}

/** 某个节点及其全部子孙的 id（含已进回收站的，保证一次处理干净） */
export function subtreeIds(nodes: Array<{ id: string; parentId: string | null }>, rootId: string): Set<string> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        grew = true
      }
    }
  }
  return ids
}

/** 生成一个回收站批次号 */
export function newTrashBatchId(): string {
  return `trash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 把节点连同子孙放进回收站，同时把归属这些方向的任务卡一起放进去。
 *
 * 共用一个 batchId：恢复/清空时按批次处理，节点和卡片天然同进同出，
 * 不会出现「方向恢复了但卡片还在回收站」这种半截状态。
 */
export async function trashNodeWithTasks(nodeId: string): Promise<{ batchId: string; trashedCards: number }> {
  const before = useSopStore.getState().directions
  const doomed = subtreeIds(before, nodeId)
  const batchId = newTrashBatchId()

  // 受影响的卡片：同一条 SOP 会展开成多行任务，按 sopJobId 去重才是「卡」数
  const affected = useStore.getState().tasks.filter(
    (task) => task.sopDirectionId && doomed.has(task.sopDirectionId),
  )
  const cardKeys = new Set(affected.map((task) => task.sopJobId ?? task.id))

  // 先搬任务卡：这样即使节点删除那边抛错，卡片也不会丢
  if (affected.length) {
    const affectedIds = new Set(affected.map((task) => task.id))
    const moved: TaskRecord[] = []
    useStore.setState((state) => {
      const stay: TaskRecord[] = []
      for (const task of state.tasks) {
        if (!affectedIds.has(task.id)) {
          stay.push(task)
          continue
        }
        moved.push({ ...task, deletedAt: Date.now(), trashBatchId: batchId })
      }
      return {
        tasks: stay,
        trashedTasks: [...moved, ...state.trashedTasks],
        selectedTaskIds: state.selectedTaskIds.filter((id) => !affectedIds.has(id)),
      }
    })
    for (const task of moved) await putTask(task)
  }

  useSopStore.getState().trashNode(nodeId, batchId)

  return { batchId, trashedCards: cardKeys.size }
}

/**
 * 恢复一个批次：业务树节点与任务卡一起回来。
 * 任务卡的归属字段从来没被动过，所以恢复后自动回到原来的方向。
 */
export async function restoreTrashBatchWithTasks(batchId: string): Promise<{ nodes: number; tasks: number }> {
  const nodeCount = useSopStore.getState().directions.filter((node) => node.trashBatchId === batchId).length
  useSopStore.getState().restoreTrashBatch(batchId)

  const restored: TaskRecord[] = []
  useStore.setState((state) => {
    const remaining: TaskRecord[] = []
    for (const task of state.trashedTasks) {
      if (task.trashBatchId !== batchId) {
        remaining.push(task)
        continue
      }
      restored.push({ ...task, deletedAt: undefined, trashBatchId: undefined })
    }
    return {
      tasks: [...restored, ...state.tasks],
      trashedTasks: remaining,
    }
  })
  for (const task of restored) await putTask(task)

  return { nodes: nodeCount, tasks: restored.length }
}

/** 彻底删除一个批次：节点与任务卡一起清掉 */
export async function purgeTrashBatchWithTasks(batchId: string): Promise<{ nodes: number; tasks: number }> {
  const nodeCount = useSopStore.getState().directions.filter((node) => node.trashBatchId === batchId).length
  // 任务卡的彻底删除（含清图）统一走 store 里的实现，这里不重复造一套
  const taskCount = await purgeTrashTasks(batchId)
  useSopStore.getState().purgeTrashBatch(batchId)
  return { nodes: nodeCount, tasks: taskCount }
}
