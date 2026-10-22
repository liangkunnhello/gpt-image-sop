import { useRef } from 'react'
import { createPortal } from 'react-dom'

import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { DEFAULT_QC_MODEL } from '../lib/visionQc'
import { useInspectConfig, DEFAULT_INSPECT_CONFIG, LIMIT_MAX, LIMIT_MIN } from '../lib/inspectConfig'
import { Checkbox } from './Checkbox'
import { CloseIcon } from './icons'

interface InspectConfigModalProps {
  onClose: () => void
}

export default function InspectConfigModal({ onClose }: InspectConfigModalProps) {
  const config = useInspectConfig((s) => s.config)
  const setConfig = useInspectConfig((s) => s.setConfig)
  const resetConfig = useInspectConfig((s) => s.resetConfig)
  const scrollRef = useRef<HTMLDivElement>(null)

  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true, scrollRef)

  const anyQcCheck = config.checkViolation || config.checkText || config.checkOverlap
  const isDefault = JSON.stringify(config) === JSON.stringify(DEFAULT_INSPECT_CONFIG)

  const numberInput = (value: number, onChange: (next: number) => void, min: number, max: number, step = 1) => (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-16 rounded-lg border border-transparent bg-black/[0.04] px-2 py-1 text-right text-xs tabular-nums text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50"
    />
  )

  const toggle = (checked: boolean, onChange: (next: boolean) => void, disabled = false) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
    </button>
  )

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col rounded-3xl border border-white/50 bg-white/90 shadow-[0_8px_40px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-confirm-in dark:border-white/[0.08] dark:bg-gray-900/90 dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] dark:ring-white/10 sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 p-6 pb-2">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">质检与重复度设置</h3>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          <div data-selectable-text className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
            决定出图后自动检查什么、用哪个模型、重复度超过多少算重复。设置只存在本机。
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-2 custom-scrollbar">
          <section className="space-y-3">
            <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">自动检测</h4>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-gray-700 dark:text-gray-200">出图后自动质检</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">每张新图送视觉模型判违规、文字、压叠。</div>
              </div>
              {toggle(config.autoQc, (next) => setConfig({ autoQc: next }))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-gray-700 dark:text-gray-200">出图后自动算重复度</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">和同方向的历史图比一遍，标出太像的那些。</div>
              </div>
              {toggle(config.autoDuplicate, (next) => setConfig({ autoDuplicate: next }))}
            </div>
            {!config.autoQc && !config.autoDuplicate && (
              <div className="rounded-xl bg-black/[0.04] px-3 py-2 text-xs text-gray-500 dark:bg-white/[0.05] dark:text-gray-400">
                两项都关后不会自动跑，只能在批次验收和任务详情里手动检查。
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">质检</h4>
            <div>
              <div className="mb-1.5 text-sm text-gray-700 dark:text-gray-200">视觉模型</div>
              <input
                type="text"
                value={config.qcModel}
                onChange={(e) => setConfig({ qcModel: e.target.value })}
                placeholder={DEFAULT_QC_MODEL}
                className="w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50"
              />
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                用当前接口配置调用，留空则用 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_QC_MODEL}</code>。
              </div>
            </div>
            <div className="space-y-2.5">
              <div className="text-sm text-gray-700 dark:text-gray-200">检查项</div>
              <Checkbox
                checked={config.checkViolation}
                onChange={(next) => setConfig({ checkViolation: next })}
                label="违规内容（色情、暴力、政治敏感、医疗夸大等）"
              />
              <Checkbox
                checked={config.checkText}
                onChange={(next) => setConfig({ checkText: next })}
                label="文字一致性（错字、多字、少字、整条缺失）"
              />
              <Checkbox
                checked={config.checkOverlap}
                onChange={(next) => setConfig({ checkOverlap: next })}
                label="文字压叠（字压字、字压人物到读不清）"
              />
            </div>
            {!anyQcCheck && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                三项全关等于不做质检，自动质检也会跳过。
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-gray-700 dark:text-gray-200">质检并发</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">同时发几个模型请求，太高容易被限流。</div>
              </div>
              {numberInput(config.qcConcurrency, (next) => setConfig({ qcConcurrency: next }), 1, 8)}
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">重复度</h4>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-200">判定线</span>
                <span className="text-sm font-medium tabular-nums text-gray-700 dark:text-gray-200">
                  {Math.round(config.limit * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={LIMIT_MIN}
                max={LIMIT_MAX}
                step={0.01}
                value={config.limit}
                onChange={(e) => setConfig({ limit: Number(e.target.value) })}
                aria-label="重复度判定线"
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-black/[0.08] accent-blue-500 dark:bg-white/[0.12]"
              />
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                相似度超过 {Math.round(config.limit * 100)}% 判为重复；调低更严，调高更宽松。
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-gray-700 dark:text-gray-200">单次最多比对</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">一次最多送多少张图两两比较，越多越慢。</div>
              </div>
              <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                {numberInput(config.maxImages, (next) => setConfig({ maxImages: next }), 4, 60)}
                张
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-gray-700 dark:text-gray-200">每张参照历史图</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">单张图检查时带几张同方向旧图一起比。</div>
              </div>
              <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                {numberInput(config.peerLimit, (next) => setConfig({ peerLimit: next }), 1, 20)}
                张
              </span>
            </div>
          </section>
        </div>

        <div className="flex shrink-0 items-center gap-2 p-6 pt-4">
          <button
            type="button"
            disabled={isDefault}
            onClick={resetConfig}
            className="shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-2 text-sm text-gray-600 transition hover:bg-black/[0.07] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white/[0.06] dark:text-gray-400 dark:hover:bg-white/[0.1]"
          >
            恢复默认
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl bg-blue-500 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
          >
            完成
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
