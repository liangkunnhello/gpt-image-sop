import { useEffect, useMemo, useState } from 'react'
import type { SopDirectionNode, TaskRecord } from '../types'
import { useSopStore, directionPath } from '../lib/sopStore'
import { purgeTrashBatchWithTasks, restoreTrashBatchWithTasks } from '../lib/directionTree'
import { collectTrashedOutputImages, purgeAllTrashTasks, purgeAllTrashedOutputImages, purgeTrashedOutputImages, restoreOutputImages, useStore } from '../store'
import { ensureImageThumbnailCached } from '../lib/imageCache'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

const KIND_LABEL: Record<SopDirectionNode['kind'], string> = {
  category: '业务线',
  product: '产品',
  direction: '方向',
}

/** 回收站里的图片缩略图：只看不还原，点开进灯箱确认是哪几张 */
function TrashImageThumbs({ ids }: { ids: string[] }) {
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const [thumbs, setThumbs] = useState<Array<{ id: string; src: string }>>([])
  const key = ids.join('|')

  useEffect(() => {
    let cancelled = false
    const preview = key ? key.split('|').slice(0, 8) : []
    if (!preview.length) {
      setThumbs([])
      return
    }
    void Promise.all(preview.map(async (id) => {
      const thumb = await ensureImageThumbnailCached(id).catch(() => undefined)
      return { id, src: thumb?.src || '' }
    })).then((list) => {
      if (!cancelled) setThumbs(list.filter((item) => item.src))
    })
    return () => { cancelled = true }
  }, [key])

  if (!thumbs.length) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {thumbs.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setLightboxImageId(item.id, ids)}
          title="点击查看大图"
          className="h-10 w-10 overflow-hidden rounded border border-black/5 bg-gray-100 transition-opacity hover:opacity-80 dark:border-white/10 dark:bg-white/[0.06]"
        >
          <img src={item.src} alt="" className="h-full w-full object-cover" />
        </button>
      ))}
      {ids.length > thumbs.length && (
        <span className="text-[10px] text-gray-400">+{ids.length - thumbs.length}</span>
      )}
    </div>
  )
}

/**
 * 一个回收站批次：删方向时节点和它下面的任务卡共用一个 batchId，
 * 所以恢复/清空都按批次整体处理，不会出现半截状态。
 */
interface TrashBatch {
  batchId: string
  deletedAt: number
  nodes: SopDirectionNode[]
  tasks: TaskRecord[]
  /** 用户当初删的那个节点的名字，作为整批的标题 */
  rootName: string
  rootKind: SopDirectionNode['kind'] | null
}

/**
 * 回收站：按批次展示。
 *
 * 删除语义是「方向 + 归属它的任务卡」一起进回收站、一起恢复、一起彻底删除，
 * 所以这里不再分「节点/任务卡」两个 tab —— 那会让用户以为两者可以分开处理，
 * 实际必须配套，分开反而容易删出半截数据。
 */
export default function TrashModal() {
  const trashOpen = useSopStore((s) => s.trashOpen)
  const setTrashOpen = useSopStore((s) => s.setTrashOpen)
  const directions = useSopStore((s) => s.directions)
  const purgeAllTrash = useSopStore((s) => s.purgeAllTrash)
  const tasks = useStore((s) => s.tasks)
  const trashedTasks = useStore((s) => s.trashedTasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  useCloseOnEscape(trashOpen, () => setTrashOpen(false))
  usePreventBackgroundScroll(trashOpen)

  const batches = useMemo<TrashBatch[]>(() => {
    const map = new Map<string, TrashBatch>()

    const ensure = (batchId: string, deletedAt: number) => {
      const existing = map.get(batchId)
      if (existing) {
        existing.deletedAt = Math.min(existing.deletedAt, deletedAt)
        return existing
      }
      const created: TrashBatch = { batchId, deletedAt, nodes: [], tasks: [], rootName: '', rootKind: null }
      map.set(batchId, created)
      return created
    }

    for (const node of directions) {
      if (!node.deletedAt || !node.trashBatchId) continue
      ensure(node.trashBatchId, node.deletedAt).nodes.push(node)
    }
    for (const task of trashedTasks) {
      if (!task.deletedAt || !task.trashBatchId) continue
      ensure(task.trashBatchId, task.deletedAt).tasks.push(task)
    }

    for (const batch of map.values()) {
      // 根节点 = 父级不在本批里的那个，它才是用户当初点删除的对象
      const root = batch.nodes.find(
        (node) => !node.parentId || !batch.nodes.some((item) => item.id === node.parentId),
      )
      batch.rootName = root?.name ?? ''
      batch.rootKind = root?.kind ?? null
    }

    return [...map.values()].sort((a, b) => b.deletedAt - a.deletedAt)
  }, [directions, trashedTasks])

  // Hook 必须无条件调用：放在 `if (!trashOpen) return null` 之前
  const trashedImages = useMemo(() => collectTrashedOutputImages(tasks), [tasks])

  if (!trashOpen) return null

  const totalNodes = batches.reduce((sum, batch) => sum + batch.nodes.length, 0)
  const totalTasks = batches.reduce((sum, batch) => sum + batch.tasks.length, 0)
  const totalImages = batches.reduce(
    (sum, batch) => sum + batch.tasks.reduce((count, task) => count + task.outputImages.length, 0),
    0,
  )
  const totalTrashedImages = trashedImages.reduce((sum, item) => sum + item.imageIds.length, 0)

  const formatTime = (value: number) => {
    const date = new Date(value)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const purgeAll = () => {
    if (!batches.length && !totalTrashedImages) return
    const parts = [
      totalNodes > 0 ? `${totalNodes} 个业务树节点` : '',
      totalTasks > 0 ? `${totalTasks} 个任务卡` : '',
      totalTrashedImages > 0 ? `${totalTrashedImages} 张单图` : '',
    ].filter(Boolean).join('、')
    setConfirmDialog({
      title: '清空回收站',
      message: `将彻底删除 ${parts}${totalImages > 0 ? `（含 ${totalImages} 张图）` : ''}，**无法恢复**。确定继续吗？`,
      tone: 'danger',
      confirmText: '彻底删除',
      action: () => {
        purgeAllTrash()
        void purgeAllTrashTasks()
        void purgeAllTrashedOutputImages().then((count) => {
          showToast(count > 0 ? `回收站已清空，彻底删除 ${count} 张图片` : '回收站已清空', 'success')
        })
      },
    })
  }

  return (
    <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={() => setTrashOpen(false)}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-5 py-3 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">回收站</h2>
          <span className="text-[11px] text-gray-400">
            {batches.length
              ? `${batches.length} 批 · ${totalNodes} 个节点 · ${totalTasks} 个任务卡`
              : '空'}
          </span>
          <div className="flex-1" />
          {(batches.length > 0 || totalTrashedImages > 0) && (
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

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!batches.length && !totalTrashedImages && (
            <p className="px-2 py-16 text-center text-xs leading-relaxed text-gray-400">
              回收站是空的
              <br />
              删除方向或任务卡、在详情页把单张图移入回收站，都会先出现在这里，可以随时恢复
            </p>
          )}

          {/* 图片回收站：详情页里单张「放入回收站」的图。与任务卡回收站分开，
              这里只回收图本身，还原不回任务状态 */}
          {totalTrashedImages > 0 && (
            <div className="mb-3 rounded-lg border border-amber-100 bg-amber-50/40 p-2.5 dark:border-amber-500/20 dark:bg-amber-500/[0.06]">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs font-medium text-gray-800 dark:text-gray-100">图片回收站</span>
                <span className="text-[11px] text-gray-400">{totalTrashedImages} 张</span>
              </div>
              {trashedImages.map(({ task, imageIds }) => (
                <div key={task.id} className="mb-1.5 flex items-start gap-2 rounded-md bg-white/70 px-2 py-1.5 dark:bg-white/[0.04]">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-gray-700 dark:text-gray-200">
                      {task.sopName || task.prompt?.slice(0, 30) || '(无提示词)'}
                    </div>
                    <div className="mt-0.5 text-[10px] text-gray-400">{imageIds.length} 张图已筛出，不再展示与交付</div>
                    <TrashImageThumbs ids={imageIds} />
                  </div>
                  <button
                    type="button"
                    onClick={() => { void restoreOutputImages(task.id, imageIds) }}
                    className="shrink-0 rounded-lg bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-600"
                  >
                    还原
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDialog({
                      title: '彻底删除这些图',
                      message: `将从任务卡里删掉这 ${imageIds.length} 张图并删除图片本体，**无法恢复**。确定继续吗？`,
                      tone: 'danger',
                      confirmText: '彻底删除',
                      action: () => {
                        void purgeTrashedOutputImages(task.id, imageIds).then((count) => {
                          showToast(count > 0 ? `已彻底删除 ${count} 张图片` : '这些图片已经不在任务卡里了', 'success')
                        })
                      },
                    })}
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    彻底删除
                  </button>
                </div>
              ))}
            </div>
          )}

          {batches.map((batch) => {
            const imageCount = batch.tasks.reduce((sum, task) => sum + task.outputImages.length, 0)
            const jobCount = new Set(batch.tasks.map((task) => task.sopJobId ?? task.id)).size
            return (
              <div key={batch.batchId} className="mb-2 rounded-lg border border-gray-100 p-2.5 dark:border-white/[0.06]">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                      {batch.rootKind
                        ? `${KIND_LABEL[batch.rootKind]}：${batch.rootName}`
                        : `任务卡：${batch.tasks[0]?.sopName || batch.tasks[0]?.prompt?.slice(0, 30) || '(无提示词)'}`}
                    </div>
                    <div className="mt-0.5 text-[11px] text-gray-400">
                      {formatTime(batch.deletedAt)}
                      {batch.nodes.length > 1 && ` · ${batch.nodes.length} 个节点`}
                      {jobCount > 0 && ` · ${jobCount} 张任务卡`}
                      {imageCount > 0 && ` · ${imageCount} 张图`}
                    </div>
                    {batch.nodes.length > 1 && (
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
                        void restoreTrashBatchWithTasks(batch.batchId).then(({ nodes, tasks }) => {
                          showToast(
                            tasks > 0 ? `已恢复 ${nodes} 个节点、${tasks} 个任务` : `已恢复 ${nodes} 个节点`,
                            'success',
                          )
                        })
                      }}
                      className="rounded-lg bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-600"
                    >
                      恢复
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDialog({
                        title: '彻底删除',
                        message: `将彻底删除这一批（${batch.nodes.length} 个节点、${jobCount} 张任务卡${imageCount > 0 ? `，含 ${imageCount} 张图` : ''}），**无法恢复**。确定继续吗？`,
                        tone: 'danger',
                        confirmText: '彻底删除',
                        action: () => {
                          void purgeTrashBatchWithTasks(batch.batchId).then(({ nodes, tasks }) => {
                            showToast(`已彻底删除 ${nodes} 个节点、${tasks} 个任务`, 'success')
                          })
                        },
                      })}
                      className="rounded-lg px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      删除
                    </button>
                  </div>
                </div>
                {batch.tasks.length > 0 && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-gray-400">
                    任务卡与方向是同一批删除的，恢复后归属原样回到这个方向下。
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <div className="shrink-0 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400 dark:border-white/[0.06]">
          删除方向会把它下面的任务卡一起放进来，恢复时也一起回去；图片在回收站期间不会被清理，点「彻底删除」或「清空回收站」才真正删掉图片本体。
        </div>
      </div>
    </div>
  )
}
