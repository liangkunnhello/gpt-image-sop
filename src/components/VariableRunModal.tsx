import { useMemo, useState } from 'react'
import { useSopStore } from '../lib/sopStore'
import { resolveExtraIds } from '../lib/extraRequirements'
import { ExtraChecklist } from './ExtraRequirementsModal'
import { splitReferenceGroups } from '../lib/sopPipeline'
import { collectAvoidZones } from '../lib/postReserve'
import { BUILTIN_VARIABLE_PROMPT } from '../lib/variablePipeline'
import { resolvePickedPreset } from './SopPresetPicker'
import { resolveVariablePrompt } from './VariablePromptPicker'
import { nearestScopeId, scopeChain } from '../lib/sopScope'
import { effectiveNodeKind } from '../lib/directionTree'
import { resolvePostTemplates } from '../lib/applyPostTemplate'
import { MAX_PROMPTS_PER_RUN } from '../lib/promptLimits'

export interface VariableRunOptions {
  directionId: string
  /** 变量提示词正文（提取策略）；空则用内置策略 */
  variablePromptText: string
  variablePromptName: string
  copyText: string
  styleText: string
  groupCount: number
  fillsPerCard: number
  /**
   * 直出：不调模型，直接把变量提示词解析成「骨架 + 可变项」。
   * 不再让用户勾，由「有没有参考图」自动决定：没参考图就没法提取。
   */
  skipExtract: boolean
}

interface Props {
  /** 参考图张数：只用于提取策略，不进生图接口 */
  imageCount: number
  /** 固定图张数：每条提示词都带 */
  fixedCount?: number
  /** 变量图张数：每条提示词轮换取 */
  variableCount?: number
  onClose: () => void
  onConfirm: (options: VariableRunOptions) => void
}

type SplitMode = 'one' | 'perImage' | 'custom'

/**
 * 变量模式的参数弹窗：与 SOP 弹窗并行的一套，只问变量模式需要的项。
 * 与 SOP 的区别：没有「使用参考图中的卖点」这个开关（变量模式的文字来源始终是卖点库），
 * 张数叫「每张卡出几张」，实际条数会受变量组合池容量限制。
 */
export default function VariableRunModal({ imageCount, fixedCount = 0, variableCount = 0, onClose, onConfirm }: Props) {
  const directions = useSopStore((s) => s.directions)
  const variablePrompts = useSopStore((s) => s.variablePrompts)
  const presets = useSopStore((s) => s.presets)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const extraPick = useSopStore((s) => s.extraPick)
  const setExtraPick = useSopStore((s) => s.setExtraPick)
  const setExtraOpen = useSopStore((s) => s.setExtraOpen)
  const postTemplates = useSopStore((s) => s.postTemplates)
  const variablesPerCard = useSopStore((s) => s.variablesPerCard)
  const setVariablesPerCard = useSopStore((s) => s.setVariablesPerCard)
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)

  // 产品下拉按层级判断，不信可能写错的 kind：只有第三层及更深的才算方向
  const products = useMemo(
    () => directions.filter((node) => effectiveNodeKind(directions, node.id) !== 'direction'),
    [directions],
  )
  const [productId, setProductId] = useState(
    // 归属为空 = 未归属：默认就停在这，不替用户挑第一个产品
    activeDirectionId ? nearestScopeId(directions, activeDirectionId) || products[0]?.id || '' : '',
  )
  const productChildren = useMemo(
    () => directions.filter((node) => node.parentId === productId),
    [directions, productId],
  )
  const [directionId, setDirectionId] = useState(activeDirectionId ?? '')
  const currentDirectionId = productChildren.some((n) => n.id === directionId)
    ? directionId
    : productChildren[0]?.id || ''
  /** 当前方向勾选的额外要求（与 SOP 模式同一份库） */
  const pickedExtras = resolveExtraIds(extraPick, currentDirectionId)

  // 变量提示词、卖点、风格都在输入框上方选好了，这里只读当前值做确认；方向为空则就近继承产品
  const scopeIds = scopeChain(directions, productId)
  const selectedPrompt = resolveVariablePrompt(variablePrompts, scopeIds, currentDirectionId, lastPick, defaultPick)
  const pickedPoint = resolvePickedPreset(presets, currentDirectionId, scopeIds, 'point', lastPick, defaultPick)
  const pickedStyle = resolvePickedPreset(presets, currentDirectionId, scopeIds, 'style', lastPick, defaultPick)

  const [mode, setMode] = useState<SplitMode>('one')
  const [customCount, setCustomCount] = useState(String(Math.max(1, Math.min(4, imageCount))))

  // 没有参考图时只能 1 张卡：没有可分析的图，也就没有按图分卡的意义
  const groupCount = !imageCount
    ? 1
    : mode === 'one'
      ? 1
      : mode === 'perImage'
        ? imageCount
        : Math.max(1, Math.min(Number(customCount) || 1, imageCount))

  // 参考图只用于反推、不进生图接口，分组只按用户选的卡数均分，不再自动多分卡
  const referenceGroups = imageCount
    ? splitReferenceGroups(Array.from({ length: imageCount }, (_, i) => i + 1), groupCount)
    : [[]]
  const actualCardCount = referenceGroups.length
  const preview = referenceGroups.map((group) => group.length).join(' / ')

  const overlayInfo = useMemo(() => {
    // 方向专属模板优先，没配才看产品模板（与出图时的取法一致）
    const list = resolvePostTemplates(postTemplates, directions, currentDirectionId || productId).templates
      .filter((item) => item.enabled)
    const withZones = list.map((item) => collectAvoidZones(item).length).filter((count) => count > 0)
    return {
      templates: withZones.length,
      zones: withZones.length ? Math.max(...withZones) : 0,
    }
  }, [postTemplates, directions, currentDirectionId, productId])

  // 未归属（productId 为空）也能跑：不挂方向，变量提示词退回内置提取策略；
  // 选了产品就必须落到具体方向，避免「看着选了产品其实没归到任何方向」
  const hasSourceImages = imageCount > 0 || fixedCount > 0 || variableCount > 0
  const isBuiltin = selectedPrompt?.id === BUILTIN_VARIABLE_PROMPT.id
  /**
   * 提取策略必须看参考图，所以「有没有参考图」就是唯一的通道判定：
   * 有参考图 → 调模型提取（变量提示词当提取指令）；没参考图 → 直接把变量提示词当生图提示词。
   * 这样用户不用记开关：拖了图就是反推，只填提示词 + 变量图就是直出。
   */
  const willExtract = imageCount > 0
  const skipExtract = !willExtract
  // 直出模式必须有一份自己写的变量提示词：内置那份是「让模型去提取」的指令，
  // 拿来当生图提示词发出去只会得到一堆关于「如何提炼策略」的文字
  const canRun = (!productId || Boolean(currentDirectionId))
    && hasSourceImages
    && (willExtract || !isBuiltin)

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
          {(fixedCount > 0 || variableCount > 0) && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              图生图 · 固定 {fixedCount} / 变量 {variableCount}
            </span>
          )}
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
                {/* 未归属是合法选择：不继承方向的变量提示词，出图直接进「未归属」 */}
                <option value="">未归属</option>
                {products.map((node) => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
              <select
                value={currentDirectionId}
                onChange={(e) => setDirectionId(e.target.value)}
                disabled={!productId}
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm disabled:opacity-50 dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              >
                {/* 产品下的子节点就是可选归属，按层级算，不依赖可能写错的 kind */}
                {productId
                  ? productChildren.map((node) => (
                    <option key={node.id} value={node.id}>{node.name}</option>
                  ))
                  : <option value="">—</option>}
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

          {/* 通道不再让用户勾：提取策略必须有参考图，所以按「有没有参考图」自动决定 */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-relaxed dark:border-white/10 dark:bg-white/[0.04]">
            <div className="flex items-center gap-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                willExtract
                  ? 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'
                  : 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
              }`}>
                {willExtract ? '提取策略' : '直接出图'}
              </span>
              <span className="min-w-0 text-gray-600 dark:text-gray-300">
                {willExtract
                  ? `参考图 ${imageCount} 张 → 先调模型提取策略`
                  : '没有参考图 → 不调模型，直接用变量提示词'}
              </span>
            </div>
            <div className="mt-1 text-gray-400 dark:text-gray-500">
              {willExtract
                ? '变量提示词这次当「提取指令」用：模型看完参考图产出骨架与可变项，再按最远点采样填词。想直接拿自己写的提示词生图，把参考图去掉。'
                : `变量提示词里的提示词正文与「可变项」原样拿来填词，按最远点采样挑差异最大的组合；没有 {'{{'}变量{'}}'} 时按设置条数复制，差异全来自变量图。`}
            </div>
          </div>
          {!willExtract && isBuiltin && (
            <p className="text-[11px] leading-relaxed text-red-500">
              提取策略需要参考图，而现在没有参考图。拖入参考图反推，
              或先在输入框上方选一份自己写的变量提示词（骨架 + 可变项）。
            </p>
          )}

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
                  disabled={!imageCount}
                  onClick={() => setMode(value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
              {imageCount
                ? `共 ${actualCardCount} 张卡，参考图分配：${preview}`
                : '没有参考图：直接用你写的变量提示词出图，固定图与变量图按条分配'}
            </div>
          </div>

          {(fixedCount > 0 || variableCount > 0) && (
            <div className="space-y-1 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2 text-[11px] leading-relaxed text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/[0.08] dark:text-emerald-300">
              <div>
                图生图：<span className="font-medium">固定图 {fixedCount} 张</span>每条提示词都会带上（产品外观、包装、骨架以它为准）；
                <span className="font-medium">变量图 {variableCount} 张</span>每条轮换取一张，用来制造场景 / 机位 / 光影差异。
              </div>
              {variableCount > 0 && (
                <div className="text-emerald-600/80 dark:text-emerald-300/70">
                  约 {actualCardCount * variablesPerCard} 条提示词会在 {variableCount} 张变量图之间循环分配。
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">每张卡出几张图</span>
            <input
              type="number"
              min={1}
              max={MAX_PROMPTS_PER_RUN}
              value={String(variablesPerCard)}
              onChange={(e) => setVariablesPerCard(Number(e.target.value) || 1)}
              className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            />
            <span className="text-[11px] text-gray-400">
              按最远点采样挑组合，共约 {actualCardCount * variablesPerCard} 张
              {variableCount > 0 && '；组合不够时循环复出，靠变量图区分'}
              ，上限 {MAX_PROMPTS_PER_RUN}（防误填）
            </span>
          </div>

          <div className="rounded-lg border border-violet-100 bg-violet-50/50 px-3 py-2 text-[11px] leading-relaxed text-violet-700 dark:border-violet-500/20 dark:bg-violet-500/[0.08] dark:text-violet-300">
            变量模式的提示词由「模型给骨架和变量选项 → 后端按最远点采样选组合 → 逐维填词」得到。
            采样保证选出的组合两两差异最大，因此同样张数下重图最少；组合池不够时会自动少出，不会重复填同一句。
          </div>

          {/* 额外要求：和 SOP 模式同一份库，能改名 / 改内容 / 增删 */}
          <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-200">额外要求</span>
              <button
                type="button"
                onClick={() => setExtraOpen(true)}
                className="text-[11px] text-violet-600 transition-colors hover:underline dark:text-violet-400"
              >
                管理 / 新增
              </button>
            </div>
            <p className="mb-1.5 text-[11px] leading-relaxed text-gray-400">
              选中的会写进策略提取与提示词。想改措辞或加自己的规则，点「管理 / 新增」。
            </p>
            <ExtraChecklist
              value={pickedExtras}
              onChange={(ids) => currentDirectionId && setExtraPick(currentDirectionId, ids)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">
            参考图只用于提取策略，不参与最终生图。
            {(fixedCount > 0 || variableCount > 0) && '固定图 / 变量图才是发给接口的输入图。'}
          </span>
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
              skipExtract,
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
