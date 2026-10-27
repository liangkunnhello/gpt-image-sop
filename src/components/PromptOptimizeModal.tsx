import { useState } from 'react'
import type { ApiProfile, InputImage } from '../types'
import { shrinkToDataUrl } from '../lib/sopPipeline'
import {
  DEFAULT_OPTIMIZE_REQUIREMENT,
  PROMPT_OPTIMIZE_PRESETS,
  optimizePrompt,
} from '../lib/promptOptimize'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

interface Props {
  /** 输入框里现在的提示词 */
  prompt: string
  /** 参考图：带上能让改写更贴合画面，默认带上，用户可以取消 */
  images: InputImage[]
  profile: ApiProfile
  /** 用户点「应用并覆盖」后回写输入框 */
  onApply: (text: string) => void
  onClose: () => void
}

/** 送模型前最多带几张参考图：再多收益很小，反而拖慢改写 */
const MAX_OPTIMIZE_IMAGES = 3

/**
 * 优化提示词弹窗。
 *
 * 流程刻意分成两步：改完先给用户看结果，点「应用并覆盖」才写回输入框。
 * 覆盖是不可撤销的，直接替换掉用户手写的提示词风险太大。
 */
export default function PromptOptimizeModal({ prompt, images, profile, onApply, onClose }: Props) {
  const [requirement, setRequirement] = useState('')
  const [useImages, setUseImages] = useState(images.length > 0)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true)

  const canRun = prompt.trim().length > 0 && !running

  const run = async () => {
    if (!canRun) return
    setRunning(true)
    setError('')
    try {
      const refs = useImages ? images.slice(0, MAX_OPTIMIZE_IMAGES) : []
      const imageDataUrls: string[] = []
      for (const image of refs) {
        try {
          imageDataUrls.push(await shrinkToDataUrl(image.dataUrl, 1024))
        } catch {
          // 单张缩图失败就不带它，不影响改写本身
        }
      }
      const next = await optimizePrompt({
        profile,
        prompt,
        requirement: requirement.trim() || DEFAULT_OPTIMIZE_REQUIREMENT,
        imageDataUrls,
      })
      setResult(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const apply = () => {
    if (!result.trim()) return
    onApply(result.trim())
    onClose()
  }

  const charDiff = result ? `${prompt.trim().length} 字 → ${result.length} 字` : ''

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">优化提示词</h2>
          <span className="text-[11px] text-gray-400">写一句要求，模型按它改写输入框里的提示词</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            title="关闭（Esc）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">原提示词</div>
          <div className="mb-4 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
            {prompt.trim() || '(空)'}
          </div>

          <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">优化要求</div>
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void run()
              }
            }}
            rows={3}
            autoFocus
            maxLength={500}
            placeholder={`例如：补上光线、镜头和画幅，控制在 80 字内；留空则按「${DEFAULT_OPTIMIZE_REQUIREMENT}」`}
            className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs leading-relaxed text-gray-700 outline-none transition focus:border-blue-300 focus:ring-1 focus:ring-blue-200 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50 dark:focus:ring-blue-500/20"
          />

          <div className="mt-2 flex flex-wrap gap-1.5">
            {PROMPT_OPTIMIZE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setRequirement((prev) => (prev.trim() ? `${prev.trim()}；${preset.text}` : preset.text))}
                title={preset.text}
                className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 dark:border-white/10 dark:text-gray-400 dark:hover:border-blue-500/40 dark:hover:bg-blue-500/10 dark:hover:text-blue-400"
              >
                {preset.label}
              </button>
            ))}
          </div>

          {images.length > 0 && (
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
              <input
                type="checkbox"
                checked={useImages}
                onChange={(e) => setUseImages(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
              />
              <span>
                带上 {Math.min(images.length, MAX_OPTIMIZE_IMAGES)} 张参考图一起看
                {images.length > MAX_OPTIMIZE_IMAGES ? `（共 ${images.length} 张，最多带 ${MAX_OPTIMIZE_IMAGES} 张）` : ''}
                —— 改写时能把主体、排版、色彩描述得更贴合画面
              </span>
            </label>
          )}

          {error && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-600 dark:bg-red-500/10 dark:text-red-400">
              {error}
            </p>
          )}

          {result && (
            <div className="mt-4">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">优化后</span>
                <span className="text-[10px] text-gray-400">{charDiff}</span>
              </div>
              <div className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs leading-relaxed text-gray-700 dark:border-blue-500/20 dark:bg-blue-500/[0.08] dark:text-gray-200">
                {result}
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[10px] text-gray-400">Ctrl/⌘ + Enter 开始优化</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10"
          >
            取消
          </button>
          {result ? (
            <>
              <button
                type="button"
                onClick={() => { void run() }}
                disabled={running}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
              >
                {running ? '优化中…' : '重新优化'}
              </button>
              <button
                type="button"
                onClick={apply}
                className="rounded-lg bg-blue-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-600"
              >
                应用并覆盖输入框
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => { void run() }}
              disabled={!canRun}
              className="rounded-lg bg-blue-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? '优化中…' : '开始优化'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
