import { useMemo, useState } from 'react'
import { useSopStore } from '../lib/sopStore'
import { splitEven } from '../lib/sopPipeline'
import { collectAvoidZones, pickAvoidTemplate } from '../lib/postReserve'
import { resolveSystemPrompt } from './SopSystemPromptPicker'
import { nearestScopeId, scopeChain } from '../lib/sopScope'
import { effectiveNodeKind } from '../lib/directionTree'

export interface SopRunOptions {
  directionId: string
  systemPromptText: string
  /** 选中的系统提示词名称；选「不使用」时为空，任务上用来追溯用了哪份 */
  systemPromptName?: string
  groupCount: number
  promptsPerGroup: number
  ignoreCompliance: boolean
  useImageSellingPoints: boolean
  /** 避免按钮、悬浮球这类引导点击的仿系统界面设计 */
  avoidCta: boolean
}

interface Props {
  imageCount: number
  onClose: () => void
  onConfirm: (options: SopRunOptions) => void
}

type SplitMode = 'one' | 'perImage' | 'custom'

export default function SopSplitModal({ imageCount, onClose, onConfirm }: Props) {
  const directions = useSopStore((s) => s.directions)
  const systemPrompts = useSopStore((s) => s.systemPrompts)
  const ignoreCompliance = useSopStore((s) => s.ignoreCompliance)
  const setIgnoreCompliance = useSopStore((s) => s.setIgnoreCompliance)
  const useImageSellingPoints = useSopStore((s) => s.useImageSellingPoints)
  const setUseImageSellingPoints = useSopStore((s) => s.setUseImageSellingPoints)
  const avoidCtaDesign = useSopStore((s) => s.avoidCtaDesign)
  const setAvoidCtaDesign = useSopStore((s) => s.setAvoidCtaDesign)
  const avoidOverlay = useSopStore((s) => s.avoidOverlay)
  const setAvoidOverlay = useSopStore((s) => s.setAvoidOverlay)
  const postTemplates = useSopStore((s) => s.postTemplates)

  // 产品下拉按层级判断，不信可能写错的 kind：只有第三层及更深的才算方向
  const products = useMemo(
    () => directions.filter((node) => effectiveNodeKind(directions, node.id) !== 'direction'),
    [directions],
  )
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const activeNode = directions.find((node) => node.id === activeDirectionId)
  const [productId, setProductId] = useState(
    (activeDirectionId ? nearestScopeId(directions, activeDirectionId) : activeNode?.id) || products[0]?.id || '',
  )
  const productChildren = useMemo(
    () => directions.filter((node) => node.parentId === productId),
    [directions, productId],
  )
  const [directionId, setDirectionId] = useState(activeDirectionId ?? '')
  const currentDirectionId = productChildren.some((n) => n.id === directionId)
    ? directionId
    : productChildren[0]?.id || ''

  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  // 系统提示词统一在输入框上方的选择器里维护，这里只负责取当前选中的那份
  const selectedPrompt = resolveSystemPrompt(
    systemPrompts,
    scopeChain(directions, productId),
    currentDirectionId,
    lastPick,
    defaultPick,
  )
  const systemPromptText = selectedPrompt?.content || ''

  const [mode, setMode] = useState<SplitMode>('one')
  const [customCount, setCustomCount] = useState(String(Math.max(1, Math.min(4, imageCount))))
  // SOP 模式下「出几张图」只由这个值决定，跟输入框的数量不再是两个数
  const promptsPerGroup = useSopStore((s) => s.promptsPerGroup)
  const setPromptsPerGroup = useSopStore((s) => s.setPromptsPerGroup)

  const groupCount = mode === 'one'
    ? 1
    : mode === 'perImage'
      ? imageCount
      : Math.max(1, Math.min(Number(customCount) || 1, imageCount))

  const preview = splitEven(Array.from({ length: imageCount }, (_, i) => i + 1), groupCount)
    .map((group) => group.length)
    .join(' / ')

  // 后处理预留区：这个产品下启用的模板里有几处要避开
  const overlayInfo = useMemo(() => {
    const list = (postTemplates[productId] ?? []).filter((item) => item.enabled)
    const withZones = list.map((item) => collectAvoidZones(item).length).filter((count) => count > 0)
    return {
      templates: withZones.length,
      zones: withZones.length ? Math.max(...withZones) : 0,
    }
  }, [postTemplates, productId])

  // 系统提示词在外面选，这里不再拦截；有方向有图就能跑
  const canRun = Boolean(currentDirectionId && imageCount > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">SOP 生图</h2>
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
                onChange={(e) => {
                  setDirectionId(e.target.value)
                }}
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              >
                {/* 产品下的子节点就是可选归属，按层级算，不依赖可能写错的 kind */}
                {productChildren.map((node) => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
            <span className="shrink-0">系统提示词</span>
            <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
              {selectedPrompt?.name ?? '未使用'}
            </span>
            <span className="shrink-0 text-[11px] text-gray-400">在输入框上方切换</span>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">分成几个任务卡</div>
            <div className="flex flex-wrap gap-2">
              {([
                ['one', '1 张卡（共用一份 SOP）'],
                ['perImage', `每张参考图一张卡（${imageCount} 张）`],
                ['custom', '自定义'],
              ] as Array<[SplitMode, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    mode === value
                      ? 'border-blue-500 bg-blue-50 text-blue-600 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-blue-300'
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
              value={String(promptsPerGroup)}
              onChange={(e) => setPromptsPerGroup(Number(e.target.value) || 1)}
              className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            />
            <span className="text-[11px] text-gray-400">每条提示词出一张，共约 {groupCount * promptsPerGroup} 张</span>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <input
              type="checkbox"
              checked={ignoreCompliance}
              onChange={(e) => setIgnoreCompliance(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">不参考 logo 与合规文案</span>
              <span className="block text-[11px] leading-relaxed text-gray-400">
                开启后生成的图不带品牌 logo、免责声明、风险提示；关掉则按参考图原样保留。
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <input
              type="checkbox"
              checked={avoidCtaDesign}
              onChange={(e) => setAvoidCtaDesign(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">不要按钮 / 引导点击的设计</span>
              <span className="block text-[11px] leading-relaxed text-gray-400">
                默认开启：画面不出现按钮、悬浮球、进度条、返回箭头这类仿系统控件，也不写「立即领取」「点击查看」「滑动解锁」这类引导点击的文案。取消勾选则允许参考图上的按钮样式。
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <input
              type="checkbox"
              checked={useImageSellingPoints}
              onChange={(e) => setUseImageSellingPoints(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">使用参考图上的卖点文案</span>
              <span className="block text-[11px] leading-relaxed text-gray-400">
                默认关闭，卖点以上方选择器为准；打开后模型会从参考图文字里提炼卖点。
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <input
              type="checkbox"
              checked={avoidOverlay !== false}
              onChange={(e) => setAvoidOverlay(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">提示词避开 Logo / 警示语位置</span>
              <span className="block text-[11px] leading-relaxed text-gray-400">
                开启后写提示词会带上后处理模板里的预留区（位置、大小），主体和文字会避开这些区域，出图后再叠 Logo 和警示语就不会压住画面内容。
                {' '}
                {overlayInfo.templates
                  ? `当前产品 ${overlayInfo.templates} 套模板配了预留区，最多 ${overlayInfo.zones} 处。`
                  : '当前产品还没配后处理模板，可在方向树里给产品打开后处理模板设置。'}
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">参考图只用于反推 SOP，不参与最终生图。</span>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => onConfirm({
              directionId: currentDirectionId,
              systemPromptText: systemPromptText.trim(),
              systemPromptName: selectedPrompt?.name ?? '不使用',
              groupCount,
              promptsPerGroup,
              ignoreCompliance,
              useImageSellingPoints,
              avoidCta: avoidCtaDesign,
            })}
            className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.06]"
          >
            开始生成
          </button>
        </div>
      </div>
    </div>
  )
}
