import { useMemo, useState } from 'react'
import type { TaskRecord } from '../types'
import { useStore } from '../store'
import { directionPath, useSopStore } from '../lib/sopStore'
import { enqueueSopJobs, supplementCardWithSop } from '../lib/sopPipeline'
import { ensureImageCached } from '../lib/imageCache'
import { clampPromptCount, MAX_PROMPTS_PER_RUN, PROMPTS_PER_BATCH } from '../lib/promptLimits'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

interface Props {
  /** 详情页当前这张卡（已按 sopJobId 聚合过） */
  task: TaskRecord
  /** 这张卡现有多少条提示词，新条目编号从它往后顺延 */
  existingCount: number
  onClose: () => void
}

/** 新图挂到这张卡，还是另起一张卡 */
type RunMode = 'append' | 'new'

/**
 * 用 SOP 再次生成图片。
 *
 * 两种去向：
 * - 补充：拿一份 SOP 再写 N 条提示词，挂到同一张卡下（不新建卡、不重新反推）；
 * - 新建：用同一份 SOP 另起一张卡，参考图沿用这张卡的（图被清理了就纯靠 SOP 写）。
 *
 * 默认「补充」——从详情页点进来说明多半就是想给这张卡加图；
 * 想另起一张时不用退回输入区重选一遍。
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
  const [mode, setMode] = useState<RunMode>('append')
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
  // 新建卡不需要原卡有 sopJobId，只要有一份能用的 SOP 就够
  const canRun = Boolean(sopText.trim()) && !busy && (mode === 'new' || Boolean(task.sopJobId))

  /**
   * 另起一张卡：参考图沿用这张卡的，图被清理过就纯按 SOP 文字写提示词。
   *
   * 参数用**当前输入区**的设置（尺寸、质量…），不用这张卡当年的 ——
   * 新建卡是全新一批，用户多半就是想在现在的设置下再跑一版。
   */
  const createNewCard = async (total: number) => {
    const referenceIds = task.sopReferenceImageIds ?? task.inputImageIds ?? []
    const loaded = await Promise.all(referenceIds.map(async (id) => {
      const dataUrl = await ensureImageCached(id)
      return dataUrl ? { id, dataUrl } : null
    }))
    const images = loaded.filter((item): item is { id: string; dataUrl: string } => item !== null)
    if (referenceIds.length && !images.length) {
      showToast('这张卡的参考图已被清理，只能按 SOP 文字写提示词', 'info')
    }
    enqueueSopJobs([{
      label: '第 1/1 张卡',
      params: useStore.getState().params,
      imageDataUrls: images.map((item) => item.dataUrl),
      imageIds: images.map((item) => item.id),
      systemPromptText: task.sopSystemPrompt ?? '',
      sopText,
      savedSopName: pickedLibrarySop?.name,
      promptsPerGroup: total,
      directionId: task.sopDirectionId,
      ignoreCompliance,
      avoidCta: avoidCtaDesign,
      // 本次文案跟着走：新卡也是同一批需求；卖点内容在 SOP 里，不重复喂
      customCopy: task.inputSnapshot?.customCopy,
    }])
  }

  const submit = () => {
    if (!canRun) return
    setBusy(true)
    const total = clampPromptCount(Number(count) || 1)
    if (mode === 'append') {
      if (!task.sopJobId) return
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
    } else {
      showToast(`正在新建任务卡并写 ${total} 条提示词…`, 'info')
      void createNewCard(total).catch((err) => {
        showToast(`新建卡失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    }
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
          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">生成方式</div>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: 'append', label: '补充到这张卡', hint: `新图接在这张卡后面（当前 ${existingCount} 条）` },
                { value: 'new', label: '新建一张卡', hint: '另起一张新卡，这张卡不受影响' },
              ] as Array<{ value: RunMode; label: string; hint: string }>).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setMode(item.value)}
                  className={`rounded-xl border px-3 py-2 text-left transition-colors ${mode === item.value
                    ? 'border-teal-400 bg-teal-50 text-teal-700 dark:border-teal-500/50 dark:bg-teal-500/10 dark:text-teal-300'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
                >
                  <div className="text-xs font-medium">{item.label}</div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">{item.hint}</div>
                </button>
              ))}
            </div>
          </div>

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
                {mode === 'append'
                  ? '换库里的 SOP 只影响这次新补的图，这张卡原来那批不会改。'
                  : '新卡会用这份 SOP 写提示词，这张卡的图不会被改动。'}
              </p>
            )}
            {!sopText.trim() && (
              <p className="mt-1.5 text-[11px] text-red-500">
                {useCardSop ? '这张卡没有可用的 SOP 正文。' : '这份 SOP 是空的。'}
                {mode === 'new' ? '换一份库里的 SOP 才能新建卡。' : '无法补充生图。'}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {mode === 'append' ? '这次补几张' : '新卡出几张'}
            </span>
            <input
              type="number"
              min={1}
              max={MAX_PROMPTS_PER_RUN}
              value={count}
              onChange={(event) => setCount(event.target.value)}
              className="w-20 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            />
            <span className="text-[11px] text-gray-400">每条提示词出一张图</span>
          </div>
          {clampPromptCount(Number(count) || 1) > PROMPTS_PER_BATCH && (
            <p className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
              超过 {PROMPTS_PER_BATCH} 条会分批写提示词（模型一次写不完），
              张数越多耗时越长；写的过程中界面上会显示进度。
            </p>
          )}
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
            {mode === 'append' ? '开始补充' : '新建并生成'}
          </button>
        </div>
      </div>
    </div>
  )
}
