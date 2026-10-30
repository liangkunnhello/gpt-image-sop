import { useMemo, useState } from 'react'
import type { ImageFidelity } from '../types'
import { useSopStore } from '../lib/sopStore'
import { splitReferenceGroups } from '../lib/sopPipeline'
import { collectAvoidZones, pickAvoidTemplate } from '../lib/postReserve'
import { resolveSystemPrompt } from './SopSystemPromptPicker'
import { resolveSavedSop } from '../lib/savedSop'
import { nearestScopeId, scopeChain } from '../lib/sopScope'
import { effectiveNodeKind } from '../lib/directionTree'
import { resolvePostTemplates } from '../lib/applyPostTemplate'
import { MAX_PROMPTS_PER_RUN, PROMPTS_PER_BATCH } from '../lib/promptLimits'
import { resolveExtraIds } from '../lib/extraRequirements'
import { ExtraChecklist } from './ExtraRequirementsModal'
import { IMAGE_FIDELITY_OPTIONS } from '../lib/sopImages'

export interface SopRunOptions {
  directionId: string
  systemPromptText: string
  /** 选中的系统提示词名称；选「不使用」时为空，任务上用来追溯用了哪份 */
  systemPromptName?: string
  /** 已选好的生图 SOP 全文：有值就跳过反推，直接照它写提示词 */
  sopText?: string
  /** 这份 SOP 在库里的名字，写进任务卡供详情页追溯 */
  savedSopName?: string
  groupCount: number
  promptsPerGroup: number
  /** 图生图的底图保真档；没有固定图 / 变量图时无意义，可不传 */
  imageFidelity?: ImageFidelity
}

interface Props {
  imageCount: number
  /** 固定图数量：整批共用，每条提示词都带 */
  fixedCount: number
  /** 变量图数量：每条轮换一张，跨卡接着轮 */
  variableCount: number
  onClose: () => void
  onConfirm: (options: SopRunOptions) => void
}

type SplitMode = 'one' | 'perImage' | 'custom'

export default function SopSplitModal({ imageCount, fixedCount, variableCount, onClose, onConfirm }: Props) {
  const hasBaseImages = fixedCount > 0 || variableCount > 0
  const imageFidelity = useSopStore((s) => s.imageFidelity)
  const setImageFidelity = useSopStore((s) => s.setImageFidelity)
  const directions = useSopStore((s) => s.directions)
  const systemPrompts = useSopStore((s) => s.systemPrompts)

  const extraPick = useSopStore((s) => s.extraPick)
  const setExtraPick = useSopStore((s) => s.setExtraPick)
  const setExtraOpen = useSopStore((s) => s.setExtraOpen)
  const postTemplates = useSopStore((s) => s.postTemplates)

  // 产品下拉按层级判断，不信可能写错的 kind：只有第三层及更深的才算方向
  const products = useMemo(
    () => directions.filter((node) => effectiveNodeKind(directions, node.id) !== 'direction'),
    [directions],
  )
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const [productId, setProductId] = useState(
    // 归属为空 = 未归属：默认就停在这，不替用户挑第一个产品。
    // 否则点完「全部任务」打开弹窗，会看到某个方向被预选，跟侧栏归属对不上。
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
  /** 当前方向勾选的额外要求：弹窗里就能勾，改措辞去「管理 / 新增」 */
  const pickedExtras = resolveExtraIds(extraPick, currentDirectionId)

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

  const savedSops = useSopStore((s) => s.savedSops)
  /** SOP 模式下选了库里的 SOP：不反推，直接拿它写提示词 */
  const pickedSop = resolveSavedSop(
    savedSops,
    scopeChain(directions, currentDirectionId || productId),
    currentDirectionId || productId,
    lastPick,
    defaultPick,
  )

  const [mode, setMode] = useState<SplitMode>('one')
  const [customCount, setCustomCount] = useState(String(Math.max(1, Math.min(4, imageCount))))
  // SOP 模式下「出几张图」只由这个值决定，跟输入框的数量不再是两个数
  const promptsPerGroup = useSopStore((s) => s.promptsPerGroup)
  const setPromptsPerGroup = useSopStore((s) => s.setPromptsPerGroup)

  const hasImages = imageCount > 0
  const groupCount = pickedSop
    ? 1
    : !hasImages
    ? 1
    : mode === 'one'
      ? 1
      : mode === 'perImage'
        ? imageCount
        : Math.max(1, Math.min(Number(customCount) || 1, imageCount))

  // 参考图只用于反推、不进生图接口，分组只按用户选的卡数均分，不再自动多分卡
  const referenceGroups = splitReferenceGroups(
    Array.from({ length: imageCount }, (_, i) => i + 1),
    groupCount,
  )
  const actualCardCount = referenceGroups.length
  const preview = referenceGroups.map((group) => group.length).join(' / ')

  // 后处理预留区：这个方向实际生效的模板里有几处要避开
  // （方向专属优先，没配才看产品模板，和出图时的取法一致）
  const overlayInfo = useMemo(() => {
    const list = resolvePostTemplates(postTemplates, directions, currentDirectionId || productId).templates
      .filter((item) => item.enabled)
    const withZones = list.map((item) => collectAvoidZones(item).length).filter((count) => count > 0)
    return {
      templates: withZones.length,
      zones: withZones.length ? Math.max(...withZones) : 0,
    }
  }, [postTemplates, directions, currentDirectionId, productId])

  // 系统提示词在外面选，这里不再拦截；参考图可以没有（纯卖点生图）。
  // 未归属（productId 为空）也能跑：不挂方向、不继承提示词，靠内置规则反推 SOP；
  // 选了产品就必须落到具体方向，避免「看着选了产品其实没归到任何方向」。
  // 选中的 SOP 是空的（新建后还没填正文）时不能开始：否则会静默退回「按参考图反推」，
  // 用户以为在用这份 SOP，实际出来的是另一套东西
  const sopReady = !pickedSop || Boolean(pickedSop.content.trim())
  const canRun = sopReady && (!productId || Boolean(currentDirectionId))

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
                {/* 未归属是合法选择：不继承任何方向的提示词/模板，出图直接进「未归属」 */}
                <option value="">未归属</option>
                {products.map((node) => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
              <select
                value={currentDirectionId}
                onChange={(e) => {
                  setDirectionId(e.target.value)
                }}
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

          {pickedSop ? (
            <div className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50/70 px-3 py-2 text-xs text-teal-700 dark:border-teal-500/30 dark:bg-teal-500/10 dark:text-teal-300">
              <span className="shrink-0">生图 SOP</span>
              <span className="min-w-0 flex-1 truncate font-medium">{pickedSop.name}</span>
              <span className="shrink-0 text-[11px] opacity-80">
                {sopReady ? '直接用这份 SOP，跳过反推' : '这份 SOP 还是空的'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
              <span className="shrink-0">系统提示词</span>
              <span className="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-200">
                {selectedPrompt?.name ?? '未使用'}
              </span>
              <span className="shrink-0 text-[11px] text-gray-400">
                {productId ? '在输入框上方切换' : '未归属不继承方向提示词'}
              </span>
            </div>
          )}

          {pickedSop ? (
            <div className={`rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
              sopReady
                ? 'bg-gray-50 text-gray-500 dark:bg-white/[0.04] dark:text-gray-400'
                : 'border border-red-200 bg-red-50 text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
            }`}>
              {sopReady
                ? '已有 SOP，参考图不参与本次出图（也不会送去反推），本次出 1 张卡。'
                : '这份 SOP 还没有正文：打开提示词库把内容填进去，或改用「反推」再出图。'}
            </div>
          ) : hasImages ? (
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
                共 {actualCardCount} 张卡，参考图分配：{preview || '—'}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              没有参考图：将只依据系统提示词与卖点反推一份文字版 SOP，再按它写提示词。只能出 1 张卡。
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">每张卡出几张图</span>
            <input
              type="number"
              min={1}
              max={MAX_PROMPTS_PER_RUN}
              value={String(promptsPerGroup)}
              onChange={(e) => setPromptsPerGroup(Number(e.target.value) || 1)}
              className="w-20 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            />
            <span className="text-[11px] text-gray-400">每条提示词出一张，共约 {actualCardCount * promptsPerGroup} 张</span>
          </div>
          {promptsPerGroup > PROMPTS_PER_BATCH && (
            <p className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
              单卡超过 {PROMPTS_PER_BATCH} 张会分批写提示词，卡上会显示进度；张数越多耗时越长。
            </p>
          )}

          {/* 图生图：只有固定图 / 变量图存在时才需要选保真档 */}
          {hasBaseImages && (
            <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-xs font-medium text-gray-700 dark:text-gray-200">底图怎么用</span>
                <span className="text-[11px] text-gray-400">
                  固定图 {fixedCount} 张 · 变量图 {variableCount} 张
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {IMAGE_FIDELITY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setImageFidelity(option.value)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      imageFidelity === option.value
                        ? 'border-blue-500 bg-blue-50 text-blue-600 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-blue-300'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
                {IMAGE_FIDELITY_OPTIONS.find((item) => item.value === imageFidelity)?.hint}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                你填的文案与额外要求优先级最高：和底图冲突时以你的要求为准。
              </p>
            </div>
          )}

          {/* 额外要求：不再是写死的勾选，条目在「额外要求」弹窗里能改名 / 改内容 / 增删 */}
          <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-white/10">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-200">额外要求</span>
              <button
                type="button"
                onClick={() => setExtraOpen(true)}
                className="text-[11px] text-blue-600 transition-colors hover:underline dark:text-blue-400"
              >
                管理 / 新增
              </button>
            </div>
            <p className="mb-1.5 text-[11px] leading-relaxed text-gray-400">
              选中的会作为硬性约束写进提示词。想改措辞或加自己的规则，点「管理 / 新增」。
            </p>
            <ExtraChecklist
              value={pickedExtras}
              onChange={(ids) => currentDirectionId && setExtraPick(currentDirectionId, ids)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">
            {pickedSop
              ? '按选中的 SOP 直接写提示词，参考图不参与。'
              : hasImages
                ? (hasBaseImages
                  ? '参考图只用于反推 SOP；出图带固定图与变量图底图。'
                  : '参考图只用于反推 SOP，不参与最终生图。')
                : (hasBaseImages ? '无参考图：按系统提示词反推 SOP，出图带底图。' : '无参考图：只靠系统提示词与卖点反推 SOP。')}
          </span>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => onConfirm({
              directionId: currentDirectionId,
              // 有存档 SOP 时系统提示词不参与出图，留空避免被当成实际依据
              systemPromptText: pickedSop ? '' : systemPromptText.trim(),
              systemPromptName: pickedSop ? '不使用' : selectedPrompt?.name ?? '不使用',
              sopText: pickedSop?.content,
              savedSopName: pickedSop?.name,
              groupCount,
              promptsPerGroup,
              imageFidelity,

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
