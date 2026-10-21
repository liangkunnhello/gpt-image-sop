import { useMemo, useState } from 'react'
import { useSopStore } from '../lib/sopStore'
import { splitEven } from '../lib/sopPipeline'
import { collectAvoidZones } from '../lib/postReserve'
import { BUILTIN_VARIABLE_PROMPT } from '../lib/variablePipeline'
import { resolvePickedPreset } from './SopPresetPicker'
import { resolveVariablePrompt } from './VariablePromptPicker'

export interface VariableRunOptions {
  directionId: string
  /** 变量提示词正文（提取策略）；空则用内置策略 */
  variablePromptText: string
  variablePromptName: string
  copyText: string
  styleText: string
  groupCount: number
  fillsPerCard: number
  ignoreCompliance: boolean
  avoidCta: boolean
}

interface Props {
  imageCount: number
  onClose: () => void
  onConfirm: (options: VariableRunOptions) => void
}

type SplitMode = 'one' | 'perImage' | 'custom'

/**
 * 变量模式的参数弹窗：与 SOP 弹窗并行的一套，只问变量模式需要的项。
 * 与 SOP 的区别：没有「使用参考图中的卖点」这个开关（变量模式的文字来源始终是卖点库），
 * 张数叫「每张卡出几张」，实际条数会受变量组合池容量限制。
 */
export default function VariableRunModal({ imageCount, onClose, onConfirm }: Props) {
  const directions = useSopStore((s) => s.directions)
  const variablePrompts = useSopStore((s) => s.variablePrompts)
  const presets = useSopStore((s) => s.presets)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const ignoreCompliance = useSopStore((s) => s.ignoreCompliance)
  const setIgnoreCompliance = useSopStore((s) => s.setIgnoreCompliance)
  const avoidCtaDesign = useSopStore((s) => s.avoidCtaDesign)
  const setAvoidCtaDesign = useSopStore((s) => s.setAvoidCtaDesign)
  const avoidOverlay = useSopStore((s) => s.avoidOverlay)
  const setAvoidOverlay = useSopStore((s) => s.setAvoidOverlay)
  const postTemplates = useSopStore((s) => s.postTemplates)
  const variablesPerCard = useSopStore((s) => s.variablesPerCard)
  const setVariablesPerCard = useSopStore((s) => s.setVariablesPerCard)
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)

  const products = useMemo(() => directions.filter((node) => node.kind !== 'direction'), [directions])
  const activeNode = directions.find((node) => node.id === activeDirectionId)
  const [productId, setProductId] = useState(
    (activeNode?.kind === 'direction' ? activeNode.parentId : activeNode?.id) || products[0]?.id || '',
  )
  const productChildren = useMemo(
    () => directions.filter((node) => node.parentId === productId),
    [directions, productId],
  )
  const [directionId, setDirectionId] = useState(activeNode?.kind === 'direction' ? activeNode.id : '')
  const currentDirectionId = productChildren.some((n) => n.id === directionId)
    ? directionId
    : productChildren.find((n) => n.kind === 'direction')?.id || ''

  // 变量提示词、卖点、风格都在输入框上方选好了，这里只读当前值做确认
  const selectedPrompt = resolveVariablePrompt(variablePrompts, productId, currentDirectionId, lastPick, defaultPick)
  const pickedPoint = resolvePickedPreset(presets, currentDirectionId, productId, 'point', lastPick, defaultPick)
  const pickedStyle = resolvePickedPreset(presets, currentDirectionId, productId, 'style', lastPick, defaultPick)

  const [mode, setMode] = useState<SplitMode>('one')
  const [customCount, setCustomCount] = useState(String(Math.max(1, Math.min(4, imageCount))))

  const groupCount = mode === 'one'
    ? 1
    : mode === 'perImage'
      ? imageCount
      : Math.max(1, Math.min(Number(customCount) || 1, imageCount))

  const preview = splitEven(Array.from({ length: imageCount }, (_, i) => i + 1), groupCount)
    .map((group) => group.length)
    .join(' / ')

  const overlayInfo = useMemo(() => {
    const list = (postTemplates[productId] ?? []).filter((item) => item.enabled)
    const withZones = list.map((item) => collectAvoidZones(item).length).filter((count) => count > 0)
    return {
      templates: withZones.length,
      zones: withZones.length ? Math.max(...withZones) : 0,
    }
  }, [postTemplates, productId])

  const canRun = Boolean(currentDirectionId && imageCount > 0)
  const isBuiltin = selectedPrompt?.id === BUILTIN_VARIABLE_PROMPT.id

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">变量模式生图</h2>
          <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-600 dark:bg-violet-500/15 dark:text-violet-300">
            骨架 + 变量填词
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            参考图 {imageCount} 张
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            取消
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">产品 / 方向</div>
            <div className="flex gap-2">
              <select
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value)
                  setDirectionId('')
                }}
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              >
                {products.map((node) => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
              <select
                value={currentDirectionId}
                onChange={(e) => setDirectionId(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              >
                {productChildren.filter((n) => n.kind === 'direction').map((node) => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0">变量提示词</span>
              <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
                {selectedPrompt?.name ?? '不使用'}
                {isBuiltin && '（未建变量提示词，使用内置提取策略）'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0">卖点</span>
              <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{pickedPoint?.name ?? '不使用'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0">风格</span>
              <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">{pickedStyle?.name ?? '不使用'}</span>
            </div>
            <div className="pt-0.5 text-[11px] text-gray-400">以上三项在输入框上方切换</div>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">分成几个任务卡</div>
            <div className="flex flex-wrap gap-2">
              {([
                ['one', '1 张卡（共用一批策略）'],
                ['perImage', `每张参考图一张卡（${imageCount} 张）`],
                ['custom', '自定义'],
              ] as Array<[SplitMode, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    mode === value
                      ? 'border-violet-500 bg-violet-50 text-violet-600 dark:border-violet-500/50 dark:bg-violet-500/10 dark:text-violet-300'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                  }`}
                >
                  {label}
                </button>
              ))}
              {mode === 'custom' && (
                <input
                  type="number"
                  min={1}
                  max={imageCount}
                  value={customCount}
                  onChange={(e) => setCustomCount(e.target.value)}
                  className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                />
              )}
            </div>
            <div className="mt-1.5 text-[11px] text-gray-400">
              共 {groupCount} 张卡，参考图分配：{preview || '—'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">每张卡出几张图</span>
            <input
              type="number"
              min={1}
              max={30}
              value={String(variablesPerCard)}
              onChange={(e) => setVariablesPerCard(Number(e.target.value) || 1)}
              className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            />
            <span className="text-[11px] text-gray-400">按最远点采样挑组合，共约 {groupCount * variablesPerCard} 张</span>
          </div>

          <div className="rounded-lg border border-violet-100 bg-violet-50/50 px-3 py-2 text-[11px] leading-relaxed text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/[0.08] dark:text-violet-300">
            变量模式的提示词由「模型给骨架和变量选项 → 后端按最远点采样选组合 → 逐维填词」得到。
            采样保证选出的组合两两差异最大，因此同样张数下重图最少；组合池不够时会自动少出，不会重复填同一句。
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <input
              type="checkbox"
              checked={ignoreCompliance}
              onChange={(e) => setIgnoreCompliance(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-violet-500"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">不提取 logo 与合规文案</span>
              <span className="block text-[11px] leading-relaxed text-gray-400">
                开启后策略与变量选项都不含品牌 logo、免责声明、风险提示。
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <input
              type="checkbox"
              checked={avoidCtaDesign}
              onChange={(e) => setAvoidCtaDesign(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-violet-500"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">不要按钮 / 引导点击的设计</span>
              <span className="block text-[11px] leading-relaxed text-gray-400">
                默认开启：不提取按钮、悬浮球、进度条这类仿系统控件，也不写「立即领取」「点击查看」。
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <input
              type="checkbox"
              checked={avoidOverlay !== false}
              onChange={(e) => setAvoidOverlay(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-violet-500"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">提示词避开 Logo / 警示语位置</span>
              <span className="block text-[11px] leading-relaxed text-gray-400">
                把后处理模板的预留区写进提示词要求，出图后叠 Logo 和警示语就不会压住画面。
                {' '}
                {overlayInfo.templates
                  ? `当前产品 ${overlayInfo.templates} 套模板配了预留区，最多 ${overlayInfo.zones} 处。`
                  : '当前产品还没配后处理模板。'}
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">参考图只用于提取策略，不参与最终生图。</span>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => onConfirm({
              directionId: currentDirectionId,
              variablePromptText: selectedPrompt?.id === BUILTIN_VARIABLE_PROMPT.id ? '' : (selectedPrompt?.content ?? ''),
              variablePromptName: selectedPrompt?.name ?? '内置提取策略',
              copyText: pickedPoint?.content ?? '',
              styleText: pickedStyle?.content ?? '',
              groupCount,
              fillsPerCard: variablesPerCard,
              ignoreCompliance,
              avoidCta: avoidCtaDesign,
            })}
            className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.06]"
          >
            开始生成
          </button>
        </div>
      </div>
    </div>
  )
}
