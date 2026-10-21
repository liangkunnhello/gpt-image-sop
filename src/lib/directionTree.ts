/**
 * 业务树节点的删除/恢复，与任务卡归属的联动。
 *
 * 为什么不写在 sopStore 里：sopStore 不该反过来依赖主 store（任务存在那边），
 * 否则会形成 store → sopStore → store 的循环。这里做单向编排：
 * 先动业务树，再把受影响的卡片归属清掉。
 */

import type { TaskRecord } from '../types'
import { useStore } from '../store'
import { putTask } from '../lib/db'
import { useSopStore } from './sopStore'

/** 某个节点及其全部子孙的 id（含已进回收站的，保证一次清干净） */
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

/**
 * 把节点连同子孙放进回收站，并把这些方向下的任务卡划为「未归属」。
 *
 * 为什么要清归属：业务线/产品/方向都不在树上了，任务卡还挂着它的 id，
 * 侧栏筛选点不到、计数也不对，等于挂在一个不存在的节点上。
 * 返回受影响的卡片数，便于提示用户。
 */
export async function trashNodeWithTasks(nodeId: string): Promise<{ batchId: string; clearedCards: number }> {
  const before = useSopStore.getState().directions
  const doomed = subtreeIds(before, nodeId)

  // 先算受影响的卡片：同一条 SOP 会展开成多行任务，这里按 sopJobId 去重
  const affected = useStore.getState().tasks.filter(
    (task) => !task.deletedAt && task.sopDirectionId && doomed.has(task.sopDirectionId),
  )
  const jobKeys = new Set(affected.map((task) => task.sopJobId ?? task.id))

  const batchId = useSopStore.getState().trashNode(nodeId)

  if (affected.length) {
    const changed: TaskRecord[] = []
    useStore.setState((state) => ({
      tasks: state.tasks.map((task) => {
        if (task.deletedAt || !task.sopDirectionId || !doomed.has(task.sopDirectionId)) return task
        const next = { ...task, sopDirectionId: undefined }
        changed.push(next)
        return next
      }),
    }))
    for (const task of changed) await putTask(task)
  }

  return { batchId, clearedCards: jobKeys.size }
}

/**
 * 恢复一批节点。归属在删除时已经被清掉了，这里不猜着往回填——
 * 猜错会把卡片挂到用户没预期的方向上。任务归属继续靠「设置归属」手动指回。
 */
export function restoreNodeBatch(batchId: string) {
  useSopStore.getState().restoreTrashBatch(batchId)
}
