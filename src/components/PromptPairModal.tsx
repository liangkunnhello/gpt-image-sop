import { useEffect, useMemo, useState } from 'react'
import type { TaskRecord } from '../types'
import { useSopStore } from '../lib/sopStore'
import { useStore } from '../store'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../lib/imageCache'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

interface Props {
  /** 同一张卡（同一 sopJobId）下的全部任务，已经按 sopPromptIndex 排好 */
  tasks: TaskRecord[]
  /** 卡片名，顶部展示 */
  title: string
  onClose: () => void
}

/** 对照表的一行：一条提示词 + 它自己产出的全部图 */
export interface PairRow {
  key: string
  index: number
  prompt: string
  images: string[]
  status: TaskRecord['status']
  error: string | null
  assignments?: Record<string, string>
  strategy?: string
  direction: string
  /** 这一行属于变量模式时为 true，决定强调色（变量紫 / SOP 蓝） */
  variableMode: boolean
}

/**
 * 把一组任务整理成对照行。抽出来是为了能单测这段对应关系。
 *
 * 关键：一条提示词 = 一条 TaskRecord，各自只存自己的 outputImages，
 * 所以这里必须逐条取，绝不能从 flatMap 之后的图片数组反推归属。
 */
export function buildPairRows(tasks: TaskRecord[], directions: Array<{ id: string; name: string }> = []): PairRow[] {
  return tasks
    .filter((task) => !task.sopPlaceholder)
    .slice()
    .sort((a, b) => (a.sopPromptIndex ?? 0) - (b.sopPromptIndex ?? 0))
    .map((task, position) => ({
      key: task.id,
      index: task.sopPromptIndex ?? position + 1,
      prompt: task.prompt,
      images: task.outputImages,
      status: task.status,
      error: task.error,
      assignments: task.variableAssignments,
      strategy: task.variableSkeleton,
      direction: task.sopDirectionId
        ? directions.find((node) => node.id === task.sopDirectionId)?.name ?? ''
        : '',
      variableMode: Boolean(task.variableMode),
    }))
}

/**
 * 图片 ↔ 提示词对照表。
 *
 * 为什么要单独做这个视图：SOP / 变量模式一条提示词就是一条 TaskRecord，
 * 各自只存自己的 outputImages，对应关系在数据层是天然存在的；
 * 但详情页把整组图片摊平成一个数组展示，提示词又只显示第 1 条，
 * 结果就是"图能看到、但不知道哪张图是哪条提示词生成的"。
 *
 * 这里不做任何重新配对，只按 sopPromptIndex 顺序把父级 tasks 里的
 * prompt 与 outputImages 原样对应摆出来。
 */
export default function PromptPairModal({ tasks, title, onClose }: Props) {
  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true)
  const directions = useSopStore((s) => s.directions)

  // 只统计真正产出的图：失败或还在跑的任务也列出来，注明状态，避免"少了一张不知道去哪了"
  const rows = useMemo(() => buildPairRows(tasks, directions), [tasks, directions])

  const imageCount = rows.reduce((sum, row) => sum + row.images.length, 0)

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 px-5 py-3 dark:border-white/[0.06]">
          <h2 className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">
            图片与提示词对照
          </h2>
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            {rows.length} 条提示词 · {imageCount} 张图
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400">{title}</span>
          <button
            type="button"
            onClick={onClose}
            title="关闭（Esc）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!rows.length && (
            <p className="px-4 py-16 text-center text-sm text-gray-400">这张卡下还没有提示词</p>
          )}
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-1 gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-white/[0.06] sm:grid-cols-[minmax(0,1fr)_240px]"
            >
              {/* 左：提示词全文，按原文换行，不做截断 */}
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    row.variableMode
                      ? 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300'
                      : 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                  }`}>
                    第 {row.index} 条
                  </span>
                  {row.status === 'running' && (
                    <span className={`shrink-0 text-[11px] ${row.variableMode ? 'text-violet-500' : 'text-blue-500'}`}>
                      生成中
                    </span>
                  )}
                  {row.status === 'error' && (
                    <span className="shrink-0 text-[11px] text-red-500">失败</span>
                  )}
                  {row.images.length === 0 && row.status === 'done' && (
                    <span className="shrink-0 text-[11px] text-amber-500">没有出图</span>
                  )}
                  {row.direction && (
                    <span className="min-w-0 truncate text-[11px] text-gray-400">{row.direction}</span>
                  )}
                </div>

                {row.strategy && (
                  <div className="mb-1 text-[11px] text-violet-600 dark:text-violet-300">
                    策略：{row.strategy}
                  </div>
                )}

                <div className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-2.5 py-2 text-xs leading-relaxed text-gray-700 dark:bg-white/[0.04] dark:text-gray-300">
                  {row.prompt || '(空)'}
                </div>

                {/* 变量模式：把这几个变量取值标出来，一眼能看出相邻两条差在哪 */}
                {row.assignments && Object.keys(row.assignments).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {Object.entries(row.assignments).map(([name, value]) => (
                      <span
                        key={name}
                        className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
                      >
                        {name}：{value}
                      </span>
                    ))}
                  </div>
                )}

                {row.error && (
                  <div className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] leading-relaxed text-red-600 dark:bg-red-500/10 dark:text-red-300">
                    {row.error}
                  </div>
                )}
              </div>

              {/* 右：这一条提示词产出的图 */}
              <div className="flex gap-2 sm:justify-end">
                {row.images.length === 0 && (
                  <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-gray-200 text-[10px] text-gray-300 dark:border-white/10 dark:text-gray-600">
                    无图
                  </div>
                )}
                {row.images.map((imageId) => (
                  <PromptPairThumb key={imageId} imageId={imageId} index={row.index} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400 dark:border-white/[0.06]">
          每条提示词各自独立出图，所以这里是一一对应关系，不是事后猜测配对的。
        </div>
      </div>
    </div>
  )
}

/** 缩略图单独订阅，避免整表渲染时把几十张大图全拉进内存 */
function PromptPairThumb({ imageId, index }: { imageId: string; index: number }) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    let cancelled = false
    const apply = (thumbnail: { src: string }) => {
      if (!cancelled) setSrc(thumbnail.src)
    }
    const unsubscribe = subscribeImageThumbnail(imageId, apply)
    ensureImageThumbnailCached(imageId).then((thumbnail) => {
      if (thumbnail) apply(thumbnail)
    }).catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [imageId])

  return (
    <button
      type="button"
      onClick={() => useStore.getState().setLightboxImageId(imageId)}
      title={`第 ${index} 条提示词产出的图，点击放大`}
      className="block h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 transition-shadow hover:shadow-md dark:border-white/10 dark:bg-white/[0.04]"
    >
      {src
        ? <img src={src} alt={`第 ${index} 条`} loading="lazy" className="h-full w-full object-cover" />
        : <span className="flex h-full w-full items-center justify-center text-[10px] text-gray-300">加载中</span>}
    </button>
  )
}
