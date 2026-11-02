/**
 * Agent 卡的「按轮看」视图。
 *
 * 一张 Agent 卡 = 多轮对话，每轮写几条提示词、出几张图。详情页原本的
 * 「N 条提示词 · 看图」是按**条**展开的，同一轮 4 条会重复四遍同一句用户原话，
 * 看不出这张卡是怎么一步步改出来的。所以这里按**轮**展示：
 * 第几轮 · 你说了什么 · 我怎么理解 · 出了哪几张。
 *
 * 数据不重新配对：轮次与图的归属在创建时就写在任务上（agentTurn + outputImages）。
 */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TaskRecord } from '../types'
import { groupAgentTurns } from '../lib/agentCardPipeline'
import { useStore } from '../store'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../lib/imageCache'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon, CopyIcon } from './icons'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'

interface Props {
  /** 同一张卡（同一 sopJobId）下的全部任务 */
  tasks: TaskRecord[]
  /** 卡片名 */
  title: string
  onClose: () => void
}

export default function AgentTurnModal({ tasks, title, onClose }: Props) {
  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true)
  const showToast = useStore((s) => s.showToast)

  const turns = useMemo(() => groupAgentTurns(tasks), [tasks])
  // 放大后能左右翻的池子：这张卡的全部图，按轮次顺序
  const allImages = useMemo(() => turns.flatMap((group) => group.outputImages), [turns])

  const copyText = async (text: string, successText: string) => {
    if (!text.trim()) {
      showToast('这一轮没有可复制的内容', 'info')
      return
    }
    try {
      await copyTextToClipboard(text)
      showToast(successText, 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制失败', err), 'error')
    }
  }

  const modal = (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-100 px-4 py-2.5 dark:border-white/[0.06]">
          <h2 className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">这张卡的对话</h2>
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            {turns.length} 轮 · {allImages.length} 张
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

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!turns.length && (
            <p className="px-4 py-16 text-center text-sm text-gray-400">这张卡还没有对话记录</p>
          )}
          {turns.map((group) => (
            <div key={group.turn.index} className="border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-white/[0.06]">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
                  第 {group.turn.index} 轮
                </span>
                <span className="shrink-0 text-[11px] text-gray-400">{group.outputImages.length} 张</span>
                {group.turn.baseImageIds.length > 0 && (
                  <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
                    带了 {group.turn.baseImageIds.length} 张底图
                  </span>
                )}
                {group.tasks.some((task) => task.status === 'running') && (
                  <span className="shrink-0 text-[11px] text-emerald-500">生成中</span>
                )}
                {group.tasks.some((task) => task.status === 'error') && (
                  <span className="shrink-0 text-[11px] text-red-500">
                    {group.tasks.filter((task) => task.status === 'error').length} 条失败
                  </span>
                )}
              </div>

              {/* 你说的这句是这一轮的唯一依据，逐字保留 */}
              <div className="group/turn relative whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-2.5 py-2 pr-9 text-xs leading-relaxed text-gray-700 dark:bg-white/[0.04] dark:text-gray-300">
                {group.turn.userText}
                <button
                  type="button"
                  onClick={() => { void copyText(group.turn.userText, `已复制第 ${group.turn.index} 轮的原话`) }}
                  title="复制这句"
                  className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white hover:text-emerald-600 hover:shadow-sm dark:hover:bg-white/10 dark:hover:text-emerald-300"
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                </button>
              </div>

              {group.turn.reply.trim() && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                  理解：{group.turn.reply}
                </p>
              )}

              <div className="mt-2 flex flex-wrap gap-2">
                {group.outputImages.length === 0 && (
                  <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-gray-200 text-[10px] text-gray-300 dark:border-white/10 dark:text-gray-600">
                    无图
                  </div>
                )}
                {group.outputImages.map((imageId, index) => (
                  <AgentTurnThumb key={imageId} imageId={imageId} turnIndex={group.turn.index} index={index} list={allImages} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400 dark:border-white/[0.06]">
          每轮一句对话，图按轮次追加到这张卡；「带了 N 张底图」指那一轮自动沿用了上一版的图。
        </div>
      </div>
    </div>
  )

  // 详情页卡片带 backdrop-blur + overflow-hidden，fixed 子元素会被当成它的容器；
  // 挂到 body 上才是视口级弹层。
  return createPortal(modal, document.body)
}

/** 缩略图单独订阅：一轮十几张时不用把整张大图都拉进内存 */
function AgentTurnThumb({ imageId, turnIndex, index, list }: { imageId: string; turnIndex: number; index: number; list: string[] }) {
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
      onClick={() => useStore.getState().setLightboxImageId(imageId, list)}
      title={`第 ${turnIndex} 轮第 ${index + 1} 张，点击放大`}
      className="block h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 transition-shadow hover:shadow-md dark:border-white/10 dark:bg-white/[0.04]"
    >
      {src
        ? <img src={src} alt={`第 ${turnIndex} 轮第 ${index + 1} 张`} loading="lazy" className="h-full w-full object-cover" />
        : <span className="flex h-full w-full items-center justify-center text-[10px] text-gray-300">加载中</span>}
    </button>
  )
}
