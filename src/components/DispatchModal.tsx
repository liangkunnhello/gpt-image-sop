import { useEffect, useMemo, useState } from 'react'
import type { TaskRecord } from '../types'
import { collectDispatchOriginals, dispatchTaskCard, useStore, type DispatchResult } from '../store'
import { useSopStore } from '../lib/sopStore'
import { resolveDeliveryDir } from '../lib/deliveryDir'
import { getImage } from '../lib/db'
import { imageSizeFromDataUrl } from '../lib/imageDimensions'
import { isTauri } from '../lib/platform'
import { getDefaultSaveDir } from '../lib/saveFile'
import {
  countDispatchable,
  dispatchCandidates,
  dispatchSkipNote,
  type DispatchImageSize,
} from '../lib/dispatch'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

interface Props {
  /** 详情页当前这张卡（已按 sopJobId 聚合过） */
  task: TaskRecord
  onClose: () => void
}

/**
 * 派发：一张卡的 AI 原图，分别套多个「产品-方向」的后处理模板（水印 / Logo），
 * 每个目标出一份成品、落到它自己的交付地址，同时在应用内生成一张卡。
 *
 * 原卡不动：派发是复制，不是重做。想改原卡的成品用详情页的「再次后处理」。
 */
export default function DispatchModal({ task, onClose }: Props) {
  const directions = useSopStore((s) => s.directions)
  const postTemplates = useSopStore((s) => s.postTemplates)
  const deliveryDirs = useSopStore((s) => s.deliveryDirs)
  const settings = useStore((s) => s.settings)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sizes, setSizes] = useState<DispatchImageSize[] | null>(null)
  const [fallbackDir, setFallbackDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DispatchResult | null>(null)

  useCloseOnEscape(!busy, onClose)

  // 原图尺寸决定「这个目标能出几张」：模板是按比例挑的，比例对不上会被跳过
  useEffect(() => {
    let cancelled = false
    const ids = collectDispatchOriginals(task)
    void (async () => {
      const next: DispatchImageSize[] = []
      for (const id of ids) {
        const image = await getImage(id)
        const size = image?.dataUrl ? imageSizeFromDataUrl(image.dataUrl) : null
        if (size) next.push({ width: size.width, height: size.height })
      }
      if (!cancelled) setSizes(next)
    })()
    return () => {
      cancelled = true
    }
  }, [task])

  // 「默认保存地址」模式下，没单独配交付地址的产品也会写到默认地址，提示要跟上实际行为
  useEffect(() => {
    if (!isTauri || settings.saveLocationMode !== 'default') {
      setFallbackDir('')
      return
    }
    let cancelled = false
    void getDefaultSaveDir()
      .then((path) => {
        if (!cancelled) setFallbackDir(path)
      })
      .catch(() => {
        if (!cancelled) setFallbackDir('')
      })
    return () => {
      cancelled = true
    }
  }, [settings.saveLocationMode])

  const candidates = useMemo(
    () => dispatchCandidates(directions, postTemplates),
    [directions, postTemplates],
  )

  const rows = useMemo(() => candidates.map((candidate) => ({
    candidate,
    count: sizes ? countDispatchable(candidate, sizes, task.channel) : 0,
    dir: resolveDeliveryDir(deliveryDirs, directions, candidate.id)?.path ?? fallbackDir,
  })), [candidates, sizes, task.channel, deliveryDirs, directions, fallbackDir])

  const total = sizes?.length ?? 0
  const selectableIds = rows.filter((row) => row.count > 0).map((row) => row.candidate.id)
  const planned = rows
    .filter((row) => selected.has(row.candidate.id))
    .reduce((sum, row) => sum + row.count, 0)

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async () => {
    if (busy || !selected.size) return
    setBusy(true)
    try {
      setResult(await dispatchTaskCard(task.id, [...selected]))
    } catch (err) {
      useStore.getState().showToast(
        `派发失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">派发到其他产品 / 方向</h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-white/[0.06]"
          >
            {result ? '关闭' : '取消'}
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <p className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            用这张卡的 <span className="font-medium text-gray-700 dark:text-gray-200">AI 原图</span>
            （共 {sizes === null ? '…' : total} 张，已含后处理前的直出图）分别套各目标的水印 / Logo。
            原卡和原图都不会被改动，每个目标会新增一张卡。
          </p>

          {sizes !== null && total === 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              这张卡没有可读到的 AI 原图，先确认图片还在本地（没被清理）。
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              派发到（{selected.size} 个已选 · 共 {planned} 张）
            </span>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setSelected(new Set(selectableIds))}
                disabled={!selectableIds.length || busy}
                className="text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
              >
                全选
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={!selected.size || busy}
                className="text-gray-500 hover:underline disabled:opacity-40 dark:text-gray-400"
              >
                清空
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
              还没有任何产品 / 方向配了启用的后处理模板。先去「后处理模板」里给目标配好水印 / Logo（并勾上启用），
              这里才会出现可选目标。
            </p>
          ) : (
            <div className="space-y-1.5">
              {rows.map(({ candidate, count, dir }) => {
                const disabled = count === 0 || busy || Boolean(result)
                const checked = selected.has(candidate.id)
                return (
                  <label
                    key={candidate.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition ${
                      disabled
                        ? 'cursor-not-allowed border-transparent bg-gray-50/70 opacity-60 dark:bg-white/[0.02]'
                        : checked
                          ? 'border-teal-400 bg-teal-50/70 dark:border-teal-500/50 dark:bg-teal-500/10'
                          : 'border-gray-100 hover:bg-gray-50 dark:border-white/[0.06] dark:hover:bg-white/[0.04]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-teal-500"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(candidate.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
                          {candidate.path}
                        </span>
                        <span className="flex-shrink-0 rounded bg-gray-100 px-1 py-[1px] text-[10px] text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
                          {candidate.scope === 'direction' ? '方向' : '产品'}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-gray-400 dark:text-gray-500" title={dir || undefined}>
                        {sizes === null
                          ? '正在读原图尺寸…'
                          : count === 0
                            ? dispatchSkipNote(total, total) || '比例对不上，出不了图'
                            : `${count} 张 · ${dir || '没配交付地址（只生成卡片）'}`}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          )}

          {result && (
            <div className="space-y-1.5 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]">
              <div className="text-[11px] font-medium text-gray-600 dark:text-gray-300">派发结果</div>
              {result.results.map((item) => (
                <div key={item.targetId} className="flex items-start gap-2 text-[11px] leading-relaxed">
                  <span className="flex-1 truncate text-gray-600 dark:text-gray-300">{item.name}</span>
                  <span className={item.created > 0 ? 'text-teal-600 dark:text-teal-400' : 'text-gray-400'}>
                    {item.created > 0 ? `${item.created} 张` : '0 张'}
                  </span>
                  <span className="max-w-[45%] truncate text-gray-400 dark:text-gray-500" title={item.error || item.path || undefined}>
                    {item.error || (item.written ? `已写入 ${item.written} 张` : `卡片已生成`)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            {isTauri ? '成品写进各目标的交付地址' : '网页版不会写本地文件夹，只生成卡片'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              {result ? '关闭' : '取消'}
            </button>
            <button
              type="button"
              disabled={busy || Boolean(result) || !selected.size || planned === 0}
              onClick={() => void run()}
              className="rounded-lg bg-teal-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.06]"
            >
              {busy ? '派发中…' : `开始派发${planned ? `（${planned} 张）` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
