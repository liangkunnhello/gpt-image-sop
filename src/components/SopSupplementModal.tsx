import { useMemo, useState } from 'react'
import type { TaskRecord } from '../types'
import { useStore } from '../store'
import { directionPath, useSopStore } from '../lib/sopStore'
import { supplementCardWithSop } from '../lib/sopPipeline'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

interface Props {
  /** 详情页当前这张卡（已按 sopJobId 聚合过） */
  task: TaskRecord
  /** 这张卡现有多少条提示词，新条目编号从它往后顺延 */
  existingCount: number
  onClose: () => void
}

/**
 * 用 SOP 给已完成的任务卡补充生图。
 *
 * 只做一件事：拿一份 SOP 再写 N 条提示词，挂到同一张卡下 —— 所以这里不新建卡，
 * 也不重新反推。SOP 来源默认是这张卡自己的（保持风格连续），
 * 也可以换库里另一份给自己的卡补一批不同的图。
 */
export default function SopSupplementModal({ task, existingCount, onClose }: Props) {
  const savedSops = useSopStore((s) => s.savedSops)
  const directions = useSopStore((s) => s.directions)
  const promptsPerGroup = useSopStore((s) => s.promptsPerGroup)
  const ignoreCompliance = useSopStore((s) => s.ignoreCompliance)
  const avoidCtaDesign = useSopStore((s) => s.avoidCtaDesign)
  const showToast = useStore((s) => s.showToast)

  /** 'card' = 用这张卡原来的 SOP；否则是库里某份 SOP 的 id */
  const [sourceId, setSourceId] = useState('card')
  const [count, setCount] = useState(String(Math.max(1, promptsPerGroup)))
  const [busy, setBusy] = useState(false)

  useCloseOnEscape(true, onClose)

  /** 按产品分组列出库里的 SOP，当前方向所属的组排在最前 */
  const groups = useMemo(() => {
    const scope = task.sopDirectionId ? directionPath(directions, task.sopDirectionId) : ''
    const byProduct = new Map<string, { label: string; items: typeof savedSops }>()
    for (const item of savedSops) {
      const node = directions.find((entry) => entry.id === item.productId)
      const label = node ? directionPath(directions, node.id) : '未归属'
      const bucket = byProduct.get(item.productId) ?? { label, items: [] }
      bucket.items.push(item)
      byProduct.set(item.productId, bucket)
    }
    return [...byProduct.entries()]
      .map(([productId, bucket]) => ({ productId, ...bucket }))
      .sort((a, b) => {
        const aHit = Boolean(scope) && scope.endsWith(a.label)
        const bHit = Boolean(scope) && scope.endsWith(b.label)
        if (aHit !== bHit) return aHit ? -1 : 1
        return a.label.localeCompare(b.label, 'zh')
      })
  }, [savedSops, directions, task.sopDirectionId])

  const pickedLibrarySop = sourceId === 'card' ? undefined : savedSops.find((item) => item.id === sourceId)
  const useCardSop = sourceId === 'card'
  const sopText = useCardSop ? (task.sopText ?? '') : (pickedLibrarySop?.content ?? '')
  const canRun = Boolean(task.sopJobId) && Boolean(sopText.trim()) && !busy

  const submit = () => {
    if (!canRun || !task.sopJobId) return
    setBusy(true)
    const total = Math.max(1, Math.min(30, Number(count) || 1))
    showToast(`正在按 SOP 写 ${total} 条提示词…`, 'info')
    void supplementCardWithSop({
      sopJobId: task.sopJobId,
      sopName: task.sopName || 'SOP',
      sopText,
      savedSopName: pickedLibrarySop?.name,
      count: total,
      directionId: task.sopDirectionId,
      ignoreCompliance,
      avoidCta: avoidCtaDesign,
      existingCount,
    })
      .catch((err) => {
        // 提示词阶段失败要明确告诉用户，否则只看到「什么都没发生」
        showToast(`补充生图失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">用 SOP 再次生成图片</h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            新图会补到这张卡下面（当前 {existingCount} 条提示词），排在后面，不影响已有的图。
          </p>

          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">用哪份 SOP</div>
            <select
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            >
              <option value="card">这张卡原来的 SOP{task.sopName ? `（${task.sopName}）` : ''}</option>
              {groups.map((group) => (
                <optgroup key={group.productId} label={`SOP 库 · ${group.label}`}>
                  {group.items.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {!useCardSop && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                换库里的 SOP 只影响这次新补的图，这张卡原来那批不会改。
              </p>
            )}
            {!sopText.trim() && (
              <p className="mt-1.5 text-[11px] text-red-500">这张卡没有可用的 SOP 正文，无法补充生图。</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">这次补几张</span>
            <input
              type="number"
              min={1}
              max={30}
              value={count}
              onChange={(event) => setCount(event.target.value)}
              className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            />
            <span className="text-[11px] text-gray-400">每条提示词出一张图</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canRun}
            onClick={submit}
            className="rounded-lg bg-teal-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.06]"
          >
            开始补充
          </button>
        </div>
      </div>
    </div>
  )
}
