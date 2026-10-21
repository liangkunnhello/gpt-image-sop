import { useMemo, useState } from 'react'
import type { SopDirectionNode, TaskRecord } from '../types'
import { useSopStore, directionPath } from '../lib/sopStore'
import { purgeAllTrashTasks, purgeTrashTasks, restoreTrashTasks, useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

const KIND_LABEL: Record<SopDirectionNode['kind'], string> = {
  category: '业务线',
  product: '产品',
  direction: '方向',
}

/** 同一批删除的节点归成一组，恢复/清空都按批次走 */
interface NodeBatch {
  batchId: string
  deletedAt: number
  /** 批次里最早的节点名，用来给整批起个可读的标题 */
  title: string
  /** 只有被删的那个根节点名字有意义，子孙是连带删的 */
  rootName: string
  count: number
  nodes: SopDirectionNode[]
}

interface TaskBatch {
  batchId: string
  deletedAt: number
  count: number
  images: number
  /** 代表性提示词，便于认出是哪一批 */
  sample: string
  tasks: TaskRecord[]
}

/**
 * 回收站：业务树节点 + 任务卡两个分组。
 *
 * 两类的恢复语义不同，分开呈现：
 * - 业务树节点：整批恢复（整棵子树一起回来），但下属任务卡的归属不会自动填回，
 *   因为删的时候已经清成「未归属」了，猜着填可能填错方向
 * - 任务卡：整批恢复，图片一直没删，恢复即完整
 */
export default function TrashModal() {
  const trashOpen = useSopStore((s) => s.trashOpen)
  const setTrashOpen = useSopStore((s) => s.setTrashOpen)
  const directions = useSopStore((s) => s.directions)
  const restoreTrashBatch = useSopStore((s) => s.restoreTrashBatch)
  const purgeTrashBatch = useSopStore((s) => s.purgeTrashBatch)
  const purgeAllTrash = useSopStore((s) => s.purgeAllTrash)
  const tasks = useStore((s) => s.trashedTasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  const [tab, setTab] = useState<'node' | 'task'>('node')

  useCloseOnEscape(trashOpen, () => setTrashOpen(false))
  usePreventBackgroundScroll(trashOpen)

  const nodeBatches = useMemo<NodeBatch[]>(() => {
    const map = new Map<string, SopDirectionNode[]>()
    for (const node of directions) {
      if (!node.deletedAt || !node.trashBatchId) continue
      const list = map.get(node.trashBatchId)
      if (list) list.push(node)
      else map.set(node.trashBatchId, [node])
    }
    return [...map.entries()]
      .map(([batchId, nodes]) => {
        // 根节点 = 父级不在本批里的那个，它的名字才是用户当初点的那个
        const root = nodes.find((node) => !node.parentId || !nodes.some((item) => item.id === node.parentId)) ?? nodes[0]
        return {
          batchId,
          deletedAt: Math.min(...nodes.map((node) => node.deletedAt ?? 0)),
          title: `${KIND_LABEL[root.kind]}：${root.name}`,
          rootName: root.name,
          count: nodes.length,
          nodes,
        }
      })
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }, [directions])

  const taskBatches = useMemo<TaskBatch[]>(() => {
    const map = new Map<string, TaskRecord[]>()
    for (const task of tasks) {
      if (!task.deletedAt || !task.trashBatchId) continue
      const list = map.get(task.trashBatchId)
      if (list) list.push(task)
      else map.set(task.trashBatchId, [task])
    }
    return [...map.entries()]
      .map(([batchId, list]) => ({
        batchId,
        deletedAt: Math.min(...list.map((task) => task.deletedAt ?? 0)),
        count: list.length,
        images: list.reduce((sum, task) => sum + task.outputImages.length, 0),
        sample: list[0]?.sopName || list[0]?.prompt?.slice(0, 40) || '(无提示词)',
        tasks: list,
      }))
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }, [tasks])

  if (!trashOpen) return null

  const nodeCount = nodeBatches.reduce((sum, batch) => sum + batch.count, 0)
  const taskCount = taskBatches.reduce((sum, batch) => sum + batch.count, 0)

  const confirmPurge = (title: string, message: string, action: () => void) => {
    setConfirmDialog({
      title,
      message,
      tone: 'danger',
      confirmText: '彻底删除',
      action,
    })
  }

  const purgeAll = () => {
    const total = nodeCount + taskCount
    if (!total) return
    confirmPurge(
      '清空回收站',
      `将彻底删除 ${nodeCount} 个业务树节点和 ${taskCount} 个任务卡，图片也会一并清除，**无法恢复**。确定继续吗？`,
      () => {
        purgeAllTrash()
        void purgeAllTrashTasks()
        showToast('回收站已清空', 'success')
      },
    )
  }

  const formatTime = (value: number) => {
    const date = new Date(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  return (
    <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={() => setTrashOpen(false)}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-5 py-3 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">回收站</h2>
          <span className="text-[11px] text-gray-400">删除的东西先放这里，清空才真正消失</span>
          <div className="flex-1" />
          {(nodeCount > 0 || taskCount > 0) && (
            <button
              type="button"
              onClick={purgeAll}
              className="rounded-lg px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              清空回收站
            </button>
          )}
          <button
            type="button"
            onClick={() => setTrashOpen(false)}
            title="关闭（Esc）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-4 dark:border-white/[0.06]">
          {([
            ['node', '业务树节点', nodeCount],
            ['task', '任务卡', taskCount],
          ] as Array<['node' | 'task', string, number]>).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`relative px-3 py-2.5 text-xs font-medium transition-colors ${
                tab === key
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {label}
              <span className={`ml-1 text-[10px] tabular-nums ${tab === key ? 'text-blue-400' : 'text-gray-400'}`}>{count}</span>
              {tab === key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-blue-500" />}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === 'node' && (
            !nodeBatches.length
              ? <p className="px-2 py-16 text-center text-xs text-gray-400">回收站里没有业务树节点</p>
              : nodeBatches.map((batch) => (
                <div key={batch.batchId} className="mb-2 rounded-lg border border-gray-100 p-2.5 dark:border-white/[0.06]">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">{batch.title}</div>
                      <div className="mt-0.5 text-[11px] text-gray-400">
                        {formatTime(batch.deletedAt)}
                        {batch.count > 1 && ` · 共 ${batch.count} 个节点一起删除`}
                      </div>
                      {batch.count > 1 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {batch.nodes.slice(0, 6).map((node) => (
                            <span key={node.id} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                              {directionPath(directions, node.id) || node.name}
                            </span>
                          ))}
                          {batch.nodes.length > 6 && (
                            <span className="text-[10px] text-gray-400">等 {batch.nodes.length} 个</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          restoreTrashBatch(batch.batchId)
                          showToast('已恢复，任务归属需手动重新指定', 'success')
                        }}
                        className="rounded-lg bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-600"
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        onClick={() => confirmPurge(
                          '彻底删除节点',
                          `将彻底删除「${batch.rootName}」${batch.count > 1 ? ` 及其 ${batch.count - 1} 个下级节点` : ''}，连同挂在产品上的提示词，**无法恢复**。确定继续吗？`,
                          () => {
                            purgeTrashBatch(batch.batchId)
                            showToast('已彻底删除', 'success')
                          },
                        )}
                        className="rounded-lg px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-gray-400">
                    恢复后节点回到原位，但原本归属它们的任务卡仍是「未归属」，需要重新指定。
                  </p>
                </div>
              ))
          )}

          {tab === 'task' && (
            !taskBatches.length
              ? <p className="px-2 py-16 text-center text-xs text-gray-400">回收站里没有任务卡</p>
              : taskBatches.map((batch) => (
                <div key={batch.batchId} className="mb-2 flex items-center gap-2 rounded-lg border border-gray-100 p-2.5 dark:border-white/[0.06]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">{batch.sample}</div>
                    <div className="mt-0.5 text-[11px] text-gray-400">
                      {formatTime(batch.deletedAt)} · {batch.count} 个任务
                      {batch.images > 0 && ` · ${batch.images} 张图`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void restoreTrashTasks(batch.batchId)}
                      className="rounded-lg bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-600"
                    >
                      恢复
                    </button>
                    <button
                      type="button"
                      onClick={() => confirmPurge(
                        '彻底删除任务',
                        `将彻底删除 ${batch.count} 个任务${batch.images > 0 ? ` 和 ${batch.images} 张图片` : ''}，**无法恢复**。确定继续吗？`,
                        () => { void purgeTrashTasks(batch.batchId) },
                      )}
                      className="rounded-lg px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
          )}
        </div>

        <div className="shrink-0 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400 dark:border-white/[0.06]">
          任务卡的图片在回收站期间不会被清理，恢复后即可正常查看和下载。
        </div>
      </div>
    </div>
  )
}
