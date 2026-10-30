import { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, showCodexCliPrompt, getCodexCliPromptKey, reapplyPostTemplate, retryTask, updateSopText, trashTask, trashOutputImage, trashOutputImages, deliverTaskNow, openDeliveryFolderForTask, resolveTaskDeliveryTarget } from '../store'
import type { TaskRecord } from '../types'
import SopEditorModal from './SopEditorModal'
import PromptPairModal from './PromptPairModal'
import { directionPath, useSopStore } from '../lib/sopStore'
import { productIdForDirection } from '../lib/applyPostTemplate'
import { channelLabel } from '../lib/channel'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useDeleteKey } from '../hooks/useDeleteKey'
import { nextIndexAfterDelete } from '../lib/lightboxNav'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { useTooltip } from '../hooks/useTooltip'
import { ensureImageCached, getCachedImage } from '../lib/imageCache'
import { formatImageRatio } from '../lib/size'
import { imageFidelityLabel } from '../lib/sopImages'
import { ActualValueBadge, DetailParamValue } from '../lib/paramDisplay'
import { copyImageSourceToClipboard, copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { downloadImageEntriesAsZip, downloadImageIds, downloadTaskImagesToFolder, downloadTaskImagesToWebFolder, getDownloadErrorMessage, getImageZipEntries, withSaveLocation } from '../lib/downloadImages'
import { isTauri } from '../lib/platform'
import { isAgentTaskPromptPending } from '../lib/taskPromptDisplay'
import { visibleOutputImages } from '../lib/taskState'
import { copyTaskIdToClipboard } from '../lib/copyTaskId'
import { getImageComments, getTaskPromptText, replaceImageMentionsForApi } from '../lib/promptImageMentions'
import { getApiProviderLabel } from '../lib/apiProfiles'
import { openImagesFolder, revealImageFile } from '../lib/openImagesFolder'
import { useClipStore } from '../lib/clipSimilarity'
import { inspectCard } from '../lib/manualInspect'
import {
  boxSelect,
  clickSelect,
  EMPTY_SELECTION,
  isSelected,
  primarySelectedId,
  pruneSelection,
  rectFromPoints,
  rectIntersects,
  selectAll,
  type SelectionState,
} from '../lib/gallerySelection'
import { filterGalleryIndexes, galleryFilterCounts, type GalleryFilter } from '../lib/galleryFilter'
import { resolveCardInputText } from '../lib/sopGroup'
import { mergeCardTasks } from '../lib/cardTasks'
import { usePostReapplyProgress } from '../lib/postProgress'
import ReapplyProgressBar from './ReapplyProgressBar'
import { DUPLICATE_SCOPE_LABEL, scopeTasksFor } from '../lib/duplicateScope'
import { useInspectConfig } from '../lib/inspectConfig'
import GalleryFilterBar from './GalleryFilterBar'
import { CloseIcon, CodeIcon, CopyIcon, DownloadIcon, EditIcon, LinkIcon, TrashIcon } from './icons'

import ViewportTooltip from './ViewportTooltip'
import { CommentBadge } from './CommentMarks'
import InspectConfigModal from './InspectConfigModal'
import SopSupplementModal from './SopSupplementModal'
import DispatchModal from './DispatchModal'

export default function DetailModal() {
  const tasks = useStore((s) => s.tasks)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const markTaskDetailViewed = useStore((s) => s.markTaskDetailViewed)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const lightboxImageList = useStore((s) => s.lightboxImageList)
  const lightboxPrompt = useStore((s) => s.lightboxCommentPrompt)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const openFavoritePicker = useStore((s) => s.openFavoritePicker)
  const settings = useStore((s) => s.settings)
  const dismissedCodexCliPrompts = useStore((s) => s.dismissedCodexCliPrompts)
  const streamPreviewSrc = useStore((s) => detailTaskId ? s.streamPreviews[detailTaskId] || '' : '')
  const streamPreviewSlots = useStore((s) => detailTaskId ? s.streamPreviewSlots[detailTaskId] : undefined)

  const [imageIndex, setImageIndex] = useState(0)
  /**
   * 画廊筛选：按质检标签（合格 / 待定 / 不合格）或重复度快速只看某一类。
   * 图多的时候翻一遍找坏图太慢，尤其一版 50 张。
   */
  const [galleryFilter, setGalleryFilter] = useState<GalleryFilter>('all')
  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})
  const [outputPreviewSrcs, setOutputPreviewSrcs] = useState<Record<string, string>>({})
  const [imageRatios, setImageRatios] = useState<Record<string, string>>({})
  const [imageSizes, setImageSizes] = useState<Record<string, string>>({})
  const [maskPreviewSrc, setMaskPreviewSrc] = useState('')
  const [sopEditing, setSopEditing] = useState(false)
  /** 图片 ↔ 提示词对照视图 */
  const [pairOpen, setPairOpen] = useState(false)
  /** 用 SOP 再补一批图的弹窗 */
  const [supplementOpen, setSupplementOpen] = useState(false)
  /** 派发弹窗：AI 原图套多个产品的水印 / Logo */
  const [dispatchOpen, setDispatchOpen] = useState(false)
  /** 缩略图缩放倍率：1 = 按目标列宽自适应，拖滑块可无级放大缩小 */
  const [galleryZoom, setGalleryZoom] = useState(1)
  /**
   * 画廊多选（照文件管理器）：单击单选、Ctrl 加选、Shift 连选、空白处拖动框选。
   * 多选后底部出现批量操作条。
   */
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  /** 框选进行中的矩形（像素，相对画廊滚动容器）；null 表示没在框选 */
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const galleryScrollRef = useRef<HTMLDivElement>(null)
  const marqueeStartRef = useRef<{ x: number; y: number; additive: boolean } | null>(null)
  /** 框选开始时已选的项：按住 Ctrl 框选要并进这些，而不是整段替换 */
  const marqueeBaseRef = useRef<string[]>([])
  const sopDirections = useSopStore((s) => s.directions)
  const addSavedSop = useSopStore((s) => s.addSavedSop)
  const [now, setNow] = useState(Date.now())
  const [showRawUrlsModal, setShowRawUrlsModal] = useState(false)
  const [showRawResponseModal, setShowRawResponseModal] = useState(false)
  /**
   * 上面是否有更上层的弹层（灯箱 / 对照表、派发、原图地址、原始响应）。
   * Ctrl+A 全选只在画廊这一层生效 —— 弹层开着时按 Ctrl+A 不该把背后的图全选上。
   */
  const overlayRef = useRef(false)
  const [streamPreviewLoaded, setStreamPreviewLoaded] = useState(false)
  /** 手动触发的检查是否在进行中（质检 + 重复度一起跑） */
  const [inspecting, setInspecting] = useState(false)
  const [showInspectConfig, setShowInspectConfig] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  /** 触屏双击检测：记录上一次点的是哪张、什么时候 */
  const lastThumbTapRef = useRef<{ id: string; at: number } | null>(null)
  const rawUrlsModalRef = useRef<HTMLDivElement>(null)
  const rawResponseModalRef = useRef<HTMLDivElement>(null)

  const rawUrlsBackdropPointerDownRef = useRef(false)
  const rawResponseBackdropPointerDownRef = useRef(false)

  const copyErrorTooltip = useTooltip()
  const copyRawUrlsTooltip = useTooltip()
  const viewRawResponseTooltip = useTooltip()
  const downloadPartialImagesTooltip = useTooltip()
  const retryTooltip = useTooltip()
  const retriedAtTooltip = useTooltip()
  const downloadImageTooltip = useTooltip()
  const downloadOriginalImageTooltip = useTooltip()
  const downloadAllTooltip = useTooltip()

  const clearTextSelection = () => {
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) selection.removeAllRanges()
  }

  const rawTask = useMemo(
    () => tasks.find((t) => t.id === detailTaskId) ?? null,
    [tasks, detailTaskId],
  )
  // SOP / 变量卡片代表的是整组任务，详情里要展示这份 SOP 下的全部图片
  const groupTasks = useMemo(() => {
    if (!rawTask?.sopJobId) return []
    return tasks
      .filter((item) => item.sopJobId === rawTask.sopJobId && !item.sopPlaceholder)
      .sort((a, b) => (a.sopPromptIndex ?? 0) - (b.sopPromptIndex ?? 0))
  }, [rawTask, tasks])
  /**
   * 「输入内容」显示输入框原文，不是模型生成的提示词。
   * SOP / 变量模式那条生成出来的长提示词（几十条）收进「每条提示词与它产出的图」入口。
   */
  const cardInputText = useMemo(() => {
    const group = groupTasks.length ? groupTasks : (rawTask ? [rawTask] : [])
    return resolveCardInputText(group)
  }, [groupTasks, rawTask])
  /**
   * 人工改判的质检结论。改判存在「真正持有这张图」的那条任务上，
   * 而详情页是把同一张卡的多条任务拼起来展示的，所以先摊平成一张 图id → 结论 的表。
   */
  const manualQcVerdicts = useMemo(() => {
    const map: Record<string, 'pass' | 'fail'> = {}
    const list = groupTasks.length ? groupTasks : (rawTask ? [rawTask] : [])
    for (const item of list) {
      for (const [id, verdict] of Object.entries(item.qcVerdicts ?? {})) map[id] = verdict
    }
    return map
  }, [groupTasks, rawTask])
  const task = useMemo(() => {
    if (!rawTask) return null
    if (!rawTask.sopJobId) return rawTask
    if (groupTasks.length <= 1) return rawTask
    // 摊平逻辑集中在 mergeCardTasks：回收站标记、人工改判这些「按图的字段」必须一起合并
    return mergeCardTasks(groupTasks)
  }, [rawTask, groupTasks])

  /**
   * 详情页开着的时候结果才回来：用户其实已经看到了，
   * 这里补一次已读，避免关掉弹窗后卡片又冒出红点。
   */
  useEffect(() => {
    if (!detailTaskId || task?.status !== 'done') return
    markTaskDetailViewed(detailTaskId)
  }, [detailTaskId, task?.status, task?.finishedAt, task?.outputImages.length, markTaskDetailViewed])

  const streamPreviewItems = useMemo(() => {
    const slotEntries = streamPreviewSlots
      ? Object.entries(streamPreviewSlots)
          .filter(([, src]) => Boolean(src))
          .sort(([a], [b]) => Number(a) - Number(b))
      : []
    const count = Math.max(
      task?.status === 'running' ? task.params.n : 0,
      slotEntries.length ? Math.max(...slotEntries.map(([key]) => Number(key) + 1)) : 0,
      streamPreviewSrc ? 1 : 0,
    )
    const byIndex = new Map(slotEntries.map(([key, src]) => [Number(key), src]))

    return Array.from({ length: count }, (_, index) => ({
      key: String(index),
      src: byIndex.get(index) ?? (index === 0 ? streamPreviewSrc : ''),
    }))
  }, [task?.params.n, task?.status, streamPreviewSlots, streamPreviewSrc])
  const activeStreamPreviewSrc = streamPreviewItems[imageIndex]?.src || ''

  useEffect(() => {
    setStreamPreviewLoaded(false)
  }, [activeStreamPreviewSrc, detailTaskId, imageIndex])

  useEffect(() => {
    // 回收的图不占位，完成态按「可见成品数」收口，否则删掉最后一张后会停在空槽上
    const visibleCount = task ? visibleOutputImages(task).length : 0
    const count = task?.status === 'running'
      ? streamPreviewItems.length
      : task
      ? (task.outputErrors?.length ? Math.max(task.params.n, visibleCount + task.outputErrors.length) : visibleCount)
      : 0
    if (count > 0 && imageIndex >= count) setImageIndex(count - 1)
  }, [imageIndex, streamPreviewItems.length, task, task?.status])

  /**
   * Esc：有多选时先清空选择，再按一次才关闭详情页。
   * 和文件管理器一致（在那里 Esc 也是先取消选择），也不会「取消选择」时把面板一起关掉。
   */
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  useCloseOnEscape(Boolean(task), () => {
    if (selectionRef.current.ids.length) {
      setSelection(EMPTY_SELECTION)
      return
    }
    setDetailTaskId(null)
  })
  /**
   * 详情页开着时按 Delete / Backspace 把当前图移入回收站。
   * 注册必须在这里（提前 return 之前）：hook 数量变化会直接白屏。
   * 具体动作放 ref 里，等下面的 handler 定义完再赋值。
   */
  const deleteKeyHandlerRef = useRef<() => void>(() => {})
  useDeleteKey(Boolean(task), () => deleteKeyHandlerRef.current())

  usePreventBackgroundScroll(Boolean(task), [modalRef, rawUrlsModalRef, rawResponseModalRef])

  /**
   * Ctrl / ⌘ + A 全选画廊里的图。
   *
   * 只在这个详情页开着、且焦点不在输入框里时生效 —— 否则会和「全选文字」打架。
   * 用 ref 拿最新的可见顺序，避免每次筛选变化都重挂监听。
   */
  const selectAllOrderRef = useRef<string[]>([])
  useEffect(() => {
    if (!task) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'a' && event.key !== 'A') return
      if (!(event.ctrlKey || event.metaKey)) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      // 在输入框里 Ctrl+A 应该是全选文字
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      // 有别的弹层盖在上面时不抢这个快捷键（灯箱、对照表、派发、确认框）
      if (overlayRef.current) return
      event.preventDefault()
      setSelection(selectAll(selectAllOrderRef.current))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [task])

  // Reset index when task changes
  useEffect(() => {
    setImageIndex(0)
  }, [detailTaskId])

  useEffect(() => {
    if (task?.status !== 'running' && !(task?.status === 'error' && (task.falRecoverable || task.customRecoverable))) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => window.clearInterval(id)
  }, [task?.customRecoverable, task?.falRecoverable, task?.status])

  // 加载所有相关图片
  useEffect(() => {
    if (!task) {
      setImageSrcs({})
      setOutputPreviewSrcs({})
      setImageRatios({})
      setImageSizes({})
      return
    }

    let cancelled = false
    const ids = [...new Set([
      ...(task.inputImageIds || []),
      ...(task.maskImageId ? [task.maskImageId] : []),
    ])]
    const initial: Record<string, string> = {}
    for (const id of ids) {
      const cached = getCachedImage(id)
      if (cached) initial[id] = cached
    }
    setImageSrcs(initial)
    for (const id of ids) {
      if (initial[id]) continue
      ensureImageCached(id).then((url) => {
        if (!cancelled && url) setImageSrcs((prev) => ({ ...prev, [id]: url }))
      })
    }

    return () => {
      cancelled = true
    }
  }, [task])

  const maskTargetId = task?.maskTargetImageId || null
  const maskTargetSrc = maskTargetId ? imageSrcs[maskTargetId] || '' : ''
  const maskSrc = task?.maskImageId ? imageSrcs[task.maskImageId] || '' : ''
  const allInputImageIds = task?.inputImageIds ?? []
  const outputSlots = useMemo(() => {
    if (!task) return []
    // 已进图片回收站的图仍留在 outputImages 里（下标被 sourceImages 等字段依赖），
    // 只在展示层打标记排除，不能真删元素
    const trashHidden = new Set(task.trashedOutputImages ?? [])
    const outputErrors = task.outputErrors ?? []
    if (outputErrors.length === 0) {
      return task.outputImages.map((imageId, outputImageIndex) => ({
        requestIndex: outputImageIndex,
        outputImageIndex,
        imageId,
        error: '',
        trashed: trashHidden.has(imageId),
      }))
    }

    const errorsByIndex = new Map(outputErrors.map((item) => [item.requestIndex, item.error]))
    const requestedCount = Math.max(task.params.n, task.outputImages.length + outputErrors.length)
    let outputImageIndex = 0
    return Array.from({ length: requestedCount }, (_, requestIndex) => {
      const error = errorsByIndex.get(requestIndex)
      if (error) return { requestIndex, outputImageIndex: -1, imageId: '', error, trashed: false }
      const imageId = task.outputImages[outputImageIndex] ?? ''
      const slot = { requestIndex, outputImageIndex, imageId, error: '', trashed: trashHidden.has(imageId) }
      outputImageIndex += 1
      return slot
    })
  }, [task])
  /**
   * 详情页真正展示的槽位：排掉图片回收站里的图。
   * 下标在这里重排成「第几张可见图」，outputImageIndex 仍是 outputImages 的下标，
   * 供原图 / 实际参数这类按原下标对齐的字段使用。
   */
  const visibleOutputSlots = useMemo(
    () => outputSlots.filter((slot) => !slot.trashed),
    [outputSlots],
  )
  // 瀑布流：只给「目标列宽」，列数与每列实际宽度交给浏览器按可用空间连续计算
  const galleryTile = useMemo(() => {
    const sizes = (task?.outputImages ?? []).map((id) => imageSizes[id]).filter(Boolean)
    const ratios = sizes
      .map((size) => {
        const [w, h] = size.split('×').map(Number)
        return w > 0 && h > 0 ? w / h : 0
      })
      .filter((ratio) => ratio > 0)
    const average = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1
    // 竖图给窄的目标宽度（列更多），横图给宽的目标宽度，保证视觉大小均衡
    return average > 1.4 ? 200 : average > 1.05 ? 158 : 132
  }, [task, imageSizes])
  /** 实际目标列宽 = 自适应基准 × 缩放倍率 */
  const galleryTileSize = Math.max(48, Math.round(galleryTile * galleryZoom))

  const currentOutputSlot = visibleOutputSlots[imageIndex]
  /**
   * 「当前这张」：多选时按最后选中的那张走（后点的算主），
   * 单选时就是点中那一张 —— 右侧参数、工具条都看着它。
   *
   * 选择为空（比如 Ctrl 点掉了唯一一张）时退回 imageIndex 那张：
   * 右侧参数区不至于整片变成「没选中」，和改造前一致。
   */
  // 每次渲染都刷新：这些弹层状态一变，Ctrl+A 的判定要立刻跟着变
  overlayRef.current = Boolean(
    lightboxImageId || pairOpen || dispatchOpen || supplementOpen || showRawUrlsModal || showRawResponseModal || sopEditing,
  )

  const selectedPrimaryId = primarySelectedId(selection)
  const currentOutputImageId = selectedPrimaryId || currentOutputSlot?.imageId || ''
  const currentOutputImageIndex = currentOutputSlot?.outputImageIndex ?? -1
  const currentOutputError = currentOutputSlot?.error || ''
  // 「原图」按钮的取图顺序：透明背景任务取扣底前那张（用户眼里的原图），
  // 否则取 AI 直出、套模板之前的那张（套过模板 / 压过体积的卡都会单独留一份）
  const originalSourceImageId = currentOutputImageIndex >= 0
    ? task?.sourceImages?.[currentOutputImageIndex] || ''
    : ''
  const currentOriginalOutputImageId = currentOutputImageIndex >= 0
    ? task?.transparentOriginalImages?.[currentOutputImageIndex]
      || (originalSourceImageId && originalSourceImageId !== currentOutputImageId ? originalSourceImageId : '')
      || ''
    : ''

  useEffect(() => {
    const outputImageIds = task?.outputImages ?? []
    if (outputImageIds.length === 0) {
      setOutputPreviewSrcs({})
      return
    }

    let cancelled = false
    const setOutputImage = (imageId: string, dataUrl: string) => {
      if (!cancelled) setOutputPreviewSrcs((prev) => ({ ...prev, [imageId]: dataUrl }))
    }

    for (const imageId of outputImageIds) {
      const cached = getCachedImage(imageId)
      if (cached) {
        setOutputImage(imageId, cached)
      } else {
        ensureImageCached(imageId)
          .then((dataUrl) => {
            if (dataUrl) setOutputImage(imageId, dataUrl)
          })
          .catch(() => {})
      }
    }

    return () => {
      cancelled = true
    }
  }, [task?.outputImages])

  useEffect(() => {
    let cancelled = false
    setMaskPreviewSrc('')
    if (!maskTargetSrc || !maskSrc) return

    createMaskPreviewDataUrl(maskTargetSrc, maskSrc)
      .then((url) => {
        if (!cancelled) setMaskPreviewSrc(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewSrc('')
      })

    return () => {
      cancelled = true
    }
  }, [maskTargetSrc, maskSrc])

  // 这几个 Hook 必须在下面的 `if (!task) return null` 之前调用：
  // 否则详情关闭时少调用、打开时多调用，Hook 数量变化会让 React 直接报错并卸载整棵树（表现为点开详情变空白）
  const [reapplying, setReapplying] = useState(false)
  /** 立即交付进行中 */
  const [delivering, setDelivering] = useState(false)
  /** 这张卡最终会交付到哪（配置地址或兜底的默认保存地址），没配则为 null */
  const [deliveryTarget, setDeliveryTarget] = useState<{ ownerId: string; path: string } | null>(null)
  const deliveryDirs = useSopStore((s) => s.deliveryDirs)

  // 交付地址可能在任何一次配置 / 切换任务后变化，依赖里的 deliveryDirs 保证改完就重算
  useEffect(() => {
    if (!task || !isTauri) {
      setDeliveryTarget(null)
      return
    }
    let cancelled = false
    void resolveTaskDeliveryTarget(task).then((resolved) => {
      if (!cancelled) setDeliveryTarget(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [task, deliveryDirs])
  const clipScores = useClipStore((s) => s.scores)
  const clipQc = useClipStore((s) => s.qc)
  const clipLimit = useClipStore((s) => s.limit)
  /** 重复度按哪种口径比：同一张任务卡 / 同产品-方向 */
  const duplicateScope = useInspectConfig((s) => s.config.duplicateScope)
  const setInspectConfig = useInspectConfig((s) => s.setConfig)

  const clipEngine = useClipStore((s) => s.engine)
  const ensureClip = useClipStore((s) => s.ensure)

  /**
   * 某张图的最终质检结论：人工改判优先于自动质检。
   * 自动结论只存在内存里，改判跟着任务落库，所以两处都要看。
   */
  const verdictOf = useCallback((imageId: string): {
    verdict: 'pass' | 'fail' | 'unsure'
    reason: string
    /** 自定义检查项的结论，只有自动质检才带 */
    custom?: Array<{ name: string; pass: boolean; note: string }>
    /** 压叠/遮挡位置：哪个字被什么盖住 */
    spots?: string[]
    /** 具体问题清单：缺哪句 / 错哪个字 / 多哪句 */
    details?: { missing?: string[]; wrong?: string[]; extra?: string[] }
  } | null => {
    const manual = manualQcVerdicts[imageId]
    if (manual) return { verdict: manual, reason: '人工改判', custom: undefined, spots: undefined, details: undefined }
    const auto = clipQc[imageId]
    return auto
      ? { verdict: auto.verdict, reason: auto.reason, custom: auto.custom, spots: auto.spots, details: auto.details }
      : null
  }, [manualQcVerdicts, clipQc])

  /** 每张图的重复度，筛选用 */
  const duplicateOf = useCallback(
    (imageId: string) => clipScores[imageId]?.max ?? 0,
    [clipScores],
  )
  /** 每类有多少张，给筛选条上的数字用；没有质检结论的图不计入任何标签 */
  const filterCounts = useMemo(
    () => galleryFilterCounts(visibleOutputSlots.map((slot) => slot.imageId), verdictOf, duplicateOf, clipLimit),
    [visibleOutputSlots, verdictOf, duplicateOf, clipLimit],
  )

  /**
   * 实际渲染的槽位：筛选时带上它在 visibleOutputSlots 里的原始下标，
   * 选中态、图片编号、灯箱翻页都还按原来的顺序走，筛完不会错位。
   */
  const filteredOutputSlots = useMemo(
    () => filterGalleryIndexes(visibleOutputSlots.map((slot) => slot.imageId), galleryFilter, verdictOf, duplicateOf, clipLimit)
      .map((index) => ({ slot: visibleOutputSlots[index]!, index })),
    [visibleOutputSlots, galleryFilter, verdictOf, duplicateOf, clipLimit],
  )

  /** 多选用的顺序：屏幕上实际看得见的那批（筛选后），连选与框选都按它算 */
  const selectionOrder = useMemo(
    () => filteredOutputSlots.map((item) => item.slot.imageId).filter(Boolean),
    [filteredOutputSlots],
  )

  /**
   * 当前选中的图，按界面顺序排；批量操作都以它为作用域。
   * 用普通计算而不是 useMemo：依赖就是本渲染的两个局部变量，memo 没有收益。
   */
  const selectedImageIds = selectionOrder.filter((id) => selection.ids.includes(id))

  // Ctrl+A 全选用的是「屏幕上这批」的顺序，这里同步给键盘监听（它挂得早，拿不到最新的 memo）
  selectAllOrderRef.current = selectionOrder

  // 筛选变化、图片被移入回收站后，选择里可能残留已不存在的 id：收敛掉，
  // 否则批量操作会作用到用户以为没选的东西上
  useEffect(() => {
    setSelection((prev) => pruneSelection(prev, selectionOrder))
  }, [selectionOrder])

  // 换了筛选条件后，当前选中的那张可能已经不在列表里，自动跳到第一张
  useEffect(() => {
    if (galleryFilter === 'all') return
    if (filteredOutputSlots.some((item) => item.index === imageIndex)) return
    const first = filteredOutputSlots[0]
    if (first) setImageIndex(first.index)
  }, [galleryFilter, filteredOutputSlots, imageIndex])

  /**
   * 按 Delete 把图移入回收站后，画廊会少一张：索引若越界就贴到末尾。
   *
   * 不处理的话右侧参数、工具条会全部变成「没选中」，看着像操作失败了；
   * 贴到末尾等于自动选中「同一位置的那一张」（被删那张的下一张顺位补上来）。
   */
  useEffect(() => {
    if (!visibleOutputSlots.length) return
    if (imageIndex <= visibleOutputSlots.length - 1) return
    setImageIndex(visibleOutputSlots.length - 1)
  }, [visibleOutputSlots.length, imageIndex])

  useEffect(() => {
    if (!task) return
    // 按用户选的口径取范围：同一张卡 / 同产品-方向 / 全部历史图。
    // 全库口径不看任务分组，只把「这张卡的图」交给 ensure —— 它会跟向量库比
    const scopeTasks = duplicateScope === 'library' ? groupTasks : scopeTasksFor(tasks, task, duplicateScope)
    ensureClip(scopeTasks, duplicateScope)
  }, [task?.id, ensureClip, tasks, duplicateScope])

  if (!task) return null

  const isAgentTask = task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)


  /** 不合格的图（只算还在画廊里的，已回收的不用再清） */
  const failedImageIds = visibleOutputImages(task).filter((id) => verdictOf(id)?.verdict === 'fail')

  // 检查面板用的聚合结果：质检取最差的一张，重复度取最高的一个
  const inspectQcList = visibleOutputImages(task)
    .map((id) => verdictOf(id))
    .filter((item): item is {
      verdict: 'pass' | 'fail' | 'unsure'
      reason: string
      custom?: Array<{ name: string; pass: boolean; note: string }>
      spots?: string[]
      details?: { missing?: string[]; wrong?: string[]; extra?: string[] }
    } => Boolean(item))
  const inspectQc = inspectQcList.find((item) => item.verdict === 'fail')
    ?? inspectQcList.find((item) => item.verdict === 'unsure')
    ?? inspectQcList[0]
    ?? null
  const inspectScoreValues = visibleOutputImages(task).map((id) => clipScores[id]?.max).filter((v): v is number => typeof v === 'number')
  const inspectScore = inspectScoreValues.length ? Math.max(...inspectScoreValues) : null
  /** 全库比对时，当前这张图是跟多少张历史图比的（来自分数的 libraryCount） */
  const currentScoreLibraryCount = currentOutputImageId
    ? (clipScores[currentOutputImageId]?.scope === 'library' ? clipScores[currentOutputImageId]?.libraryCount : undefined)
    : undefined
  const showPendingPrompt = isAgentTaskPromptPending(task)
  const isAgentEditTool = task.status === 'done' && String(task.agentToolAction ?? '').toLowerCase() === 'edit'
  const showReferenceSection = allInputImageIds.length > 0 || isAgentEditTool

  const outputLen = visibleOutputSlots.length
  // 只有保留过 AI 原图、且不是透明背景的任务才能重跑后处理。
  // 对齐判断用 outputImages 全量：重做是按原图整批重来的，与展示上隐藏了几张无关
  const canReapplyPost = Boolean(
    isTauri
    && task.outputImages.length > 0
    && task?.sourceImages?.length === task.outputImages.length
    && task.sourceImages.every(Boolean)
    && !task.transparentOutput,
  )
  const handleReapplyPost = async () => {
    if (!task) return
    const taskId = task.id
    setReapplying(true)
    // 进度放在独立 store：详情页可能有几百张缩略图，跟着刷新几百次会卡
    usePostReapplyProgress.getState().begin(taskId)
    // 先让出一帧再干重活：套模板是同步的 CPU 密集操作，不让出这一帧的话
    // 点下去会先卡住一段，看起来就是「点了没反应」
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    try {
      await reapplyPostTemplate(taskId, (progress) => {
        usePostReapplyProgress.getState().update(taskId, progress)
      })
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      usePostReapplyProgress.getState().finish(taskId)
      setReapplying(false)
    }
  }
  const currentImageRatio = currentOutputImageId ? imageRatios[currentOutputImageId] : ''
  const currentImageSize = currentOutputImageId ? imageSizes[currentOutputImageId] : ''
  const baseActualParams = currentOutputImageId
    ? task.actualParamsByImage?.[currentOutputImageId] ?? task.actualParams
    : task.actualParams
  const currentActualParams = (baseActualParams?.size || !currentImageSize)
    ? baseActualParams
    : { ...(baseActualParams ?? {}), size: currentImageSize.replace('×', 'x') }
  const currentRevisedPrompt = currentOutputImageId ? task.revisedPromptByImage?.[currentOutputImageId]?.trim() : ''
  // 将 @图N 等 mention 标记和透明背景追加提示词都按实际请求内容比较，
  // 避免仅由本地请求预处理导致的不一致被当作“API 改写”。
  const requestPrompt = task.transparentOutput && task.transparentPrompt
    ? task.transparentPrompt
    : task.prompt
  const promptSentToApi = replaceImageMentionsForApi(requestPrompt, task.inputImageIds.length).trim()
  const showRevisedPrompt = Boolean(currentRevisedPrompt && currentRevisedPrompt !== promptSentToApi)
  const codexCliPromptKey = getCodexCliPromptKey(settings)
  const hasHandledPromptWarning = settings.codexCli || dismissedCodexCliPrompts.includes(codexCliPromptKey)
  const taskProvider = task.apiProvider
  const isOpenAiTask = (taskProvider ?? 'openai') === 'openai'
  // 整卡（多条提示词拼起来的）没法拿一段文字跟单张图的 revised_prompt 比，别误报「已被改写」
  const showPromptWarning = Boolean(
    groupTasks.length <= 1
    && isOpenAiTask
    && task.apiMode === 'responses'
    && currentOutputImageId
    && (!currentRevisedPrompt || showRevisedPrompt)
    && !hasHandledPromptWarning,
  )
  const taskProviderName = taskProvider ? getApiProviderLabel(settings, taskProvider) : '未知'
  const taskProfileName = task.apiProfileName || '未知'
  const taskModel = task.apiModel || '未知'
  const showSourceInfo = Boolean(task.apiProvider || task.apiProfileName || task.apiModel)
  const isFalReconnecting = task.status === 'error' && task.falRecoverable
  const isCustomReconnecting = task.status === 'error' && task.customRecoverable
  const rawImageUrls = task.rawImageUrls ?? []
  const streamPreviewLen = streamPreviewItems.length
  const currentStreamPreviewSrc = activeStreamPreviewSrc
  const streamPartialImageIds = task.streamPartialImageIds ?? []
  const supportsTransparentOutput = task.params.output_format === 'png' || task.params.output_format === 'webp'
  const transparentOutputText = task.transparentOutput || task.params.transparent_output ? 'true' : 'false'
  const currentTransparentOutputFailed = Boolean(currentOutputImageId && task.transparentOutput && task.transparentOriginalImages?.[currentOutputImageIndex] === '')
  const outputCompressionText = task.params.output_compression == null ? '未设置' : String(task.params.output_compression)

  const formatTime = (ts: number | null) => {
    if (!ts) return ''
    return new Date(ts).toLocaleString('zh-CN')
  }

  const formatDuration = () => {
    if (task.status === 'running' || isFalReconnecting || isCustomReconnecting) {
      const seconds = Math.max(0, Math.floor((now - (task.startedAt ?? task.createdAt)) / 1000))
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      return `${mm}:${ss}`
    }
    if (task.elapsed == null) return null
    const seconds = Math.floor(task.elapsed / 1000)
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  /**
   * 手动重跑检查：本任务的图连同同方向历史图一起送后端，一次拿回质检结论和重复度。
   * 具体逻辑在 lib/manualInspect —— 任务卡上的「质检」走同一份，别在这里再写一遍。
   */
  const handleInspect = async () => {
    if (inspecting) return
    setInspecting(true)
    try {
      const result = await inspectCard({ task, tasks, scope: duplicateScope })
      if (!result.ok) showToast(`检查失败：${result.error ?? '未知原因'}`, 'error')
    } finally {
      setInspecting(false)
    }
  }

  const handleReuse = () => {
    reuseConfig(task)
    setDetailTaskId(null)
  }

  const handleEdit = () => {
    editOutputs(task)
    setDetailTaskId(null)
  }

  const handleOpenFolder = async (dir: 'finished' | 'images') => {
    const result = await openImagesFolder(dir)
    if (result.ok) return
    if (result.webOnly) {
      showToast('网页版的图片存在浏览器里，没有本地文件夹；要用这个按钮请用桌面客户端', 'info')
      return
    }
    showToast(`打开文件夹失败：${result.error || '未知原因'}${result.path ? `（路径 ${result.path}）` : ''}`, 'error')
  }

  /**
   * 「打开文件所在位置」：在资源管理器里选中当前这一张图本身。
   *
   * 图片按内容 hash 分桶存在 data/images/<前两位>/<hash>.ext，并没有「一张卡一个文件夹」，
   * 所以以前那种「打开 data 目录」的做法对用户没意义。这里定位到文件；
   * 文件被清理过、或网页版没有本地文件时，退回打开所在文件夹。
   */
  const handleRevealCurrentImage = async (variant: 'output' | 'original') => {
    const imageId = variant === 'original'
      ? currentOriginalOutputImageId || currentOutputImageId
      : currentOutputImageId
    if (imageId) {
      const result = await revealImageFile(imageId)
      if (result.ok) return
      if (!result.webOnly && result.error) {
        // 文件已被清理：还是要给用户一个能进去的地方
        await handleOpenFolder(variant === 'original' ? 'images' : 'finished')
        showToast(result.error, 'info')
        return
      }
      if (result.webOnly) {
        showToast('网页版的图片存在浏览器里，没有本地文件；要用这个按钮请用桌面客户端', 'info')
        return
      }
    }
    // 没有对应图片（比如这一格是失败项）时，退回打开所在文件夹
    await handleOpenFolder(variant === 'original' ? 'images' : 'finished')
  }

  /**
   * 「打开交付文件夹」：打开这张卡的交付位置（交付地址 + 卡文件夹）。
   *
   * 卡文件夹只有交付过才存在，没交付过时退回打开交付地址本身，
   * 并明确告诉用户「还没交付」，免得误以为已经交付过。
   */
  const handleOpenDeliveryFolder = async () => {
    if (!task) return
    const result = await openDeliveryFolderForTask(task.id)
    if (result.ok) {
      if (result.opened === 'root') {
        showToast(`这张卡还没交付过，已打开交付地址：${result.path ?? ''}`, 'info')
      }
      return
    }
    if (result.webOnly) {
      showToast('网页版没有本地交付目录；要用这个按钮请用桌面客户端', 'info')
      return
    }
    if (result.noTarget) {
      showToast('这张卡还没配置交付地址，先在左侧「产品-方向」右键配置', 'info')
      return
    }
    showToast(`打开交付文件夹失败：${result.error || '未知原因'}${result.path ? `（路径 ${result.path}）` : ''}`, 'error')
  }

  /**
   * 把这张卡的 SOP 存进库。
   *
   * 按「这张卡所属产品」存（跟系统提示词同粒度），这样这个产品下所有方向都能选到；
   * 反过来，任务没归属方向就没有产品可挂，这时提示用户先归属而不是存成孤儿数据。
   */
  const handleSaveSopToLibrary = () => {
    const content = (task?.sopText ?? '').trim()
    if (!task || !content) return
    const productId = productIdForDirection(sopDirections, task.sopDirectionId)
    if (!productId) {
      showToast('这张卡还没归属方向，先指定「产品-方向」再存 SOP', 'error')
      return
    }
    const fallbackName = (task.sopName || '生图 SOP').slice(0, 40)
    const name = window.prompt('存进 SOP 库的名字', fallbackName)?.trim()
    if (!name) return
    addSavedSop(productId, name.slice(0, 60), content)
    const productName = sopDirections.find((node) => node.id === productId)?.name ?? '该产品'
    showToast(`已存进「${productName}」的 SOP 库：${name}`, 'success')
  }

  const handleDelete = () => {
    setDetailTaskId(null)
    setConfirmDialog({
      title: '移入回收站',
      message: '确定要删除这个任务吗？会先放进回收站，可以在「回收站」里恢复，清空回收站才真正删除图片。',
      action: () => trashTask(task),
    })
  }

  const handleDeliverNow = async () => {
    if (!task || delivering) return
    setDelivering(true)
    try {
      await deliverTaskNow(task.id)
    } finally {
      setDelivering(false)
    }
  }

  const handleToggleFavorite = () => {
    openFavoritePicker([task.id])
  }

  const handleCopyError = async () => {
    const errorText = task.error || '生成失败'
    try {
      await copyTextToClipboard(errorText)
      showToast('完整报错已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制报错失败', err), 'error')
    }
  }

  /**
   * 框选：在画廊空白处按下并拖动，把矩形碰到的图都选中。
   *
   * 和文件管理器一致：不按 Ctrl 时框选替换掉原来的选择，按住 Ctrl 则并进去。
   * 用 pointer events 而不是 mousedown，触屏 / 触控板也能用。
   */
  const marqueePoint = (event: React.PointerEvent) => {
    const container = galleryScrollRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return {
      // 转成相对滚动容器的内容坐标，滚动时才不会错位
      x: event.clientX - rect.left + container.scrollLeft,
      y: event.clientY - rect.top + container.scrollTop,
    }
  }

  const handleMarqueeDown = (event: React.PointerEvent) => {
    // 只认左键；点在图片上时交给缩略图自己的点击处理
    if (event.button !== 0) return
    const point = marqueePoint(event)
    if (!point) return
    const additive = event.ctrlKey || event.metaKey
    marqueeStartRef.current = { ...point, additive }
    marqueeBaseRef.current = additive ? selection.ids : []
    setMarquee({ left: point.x, top: point.y, width: 0, height: 0 })
    // 捕获指针：手指/鼠标滑出滚动容器也能继续框（否则一拖快就断了）
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handleMarqueeMove = (event: React.PointerEvent) => {
    const start = marqueeStartRef.current
    const container = galleryScrollRef.current
    if (!start || !container) return
    const point = marqueePoint(event)
    if (!point) return
    const rect = rectFromPoints(start.x, start.y, point.x, point.y)
    setMarquee(rect)

    // 逐块比对：每个缩略图的位置换成同一套内容坐标，再和矩形求交
    const hit: string[] = []
    for (const tile of container.querySelectorAll<HTMLElement>('[data-gallery-image-id]')) {
      const imageId = tile.dataset.galleryImageId
      if (!imageId) continue
      const tileRect = tile.getBoundingClientRect()
      const box = {
        left: tileRect.left - container.getBoundingClientRect().left + container.scrollLeft,
        top: tileRect.top - container.getBoundingClientRect().top + container.scrollTop,
        width: tileRect.width,
        height: tileRect.height,
      }
      if (rectIntersects(rect, box) && !hit.includes(imageId)) hit.push(imageId)
    }
    setSelection(boxSelect(start.additive ? marqueeBaseRef.current : [], hit))
  }

  const handleMarqueeUp = () => {
    if (!marqueeStartRef.current) return
    marqueeStartRef.current = null
    marqueeBaseRef.current = []
    setMarquee(null)
  }

  /**
 * 移入图片回收站（工具栏按钮与 Delete 键共用）。
   *
   * 灯箱开着时不能因为这张图从画廊消失就退出去：
   * 图片本体还在库里，把「目前看着的那张」留在灯箱列表里，用户能继续看图、继续按 →
   * 跳下一张，只是画廊里不再显示它。关掉灯箱后再回到画廊，它就已经在回收站了。
   */
  const doTrashImage = (imageId: string) => {
    if (!imageId || !task) return
    void trashOutputImage(task.id, imageId)
  }

  const handleTrashConfirm = (imageId: string) => {
    if (!imageId) return
    setConfirmDialog({
      title: '移入图片回收站',
      message: '这张图会从画廊和交付里移除，原图仍保留，可在「回收站」里还原。',
      action: () => doTrashImage(imageId),
    })
  }

  /**
   * Delete / Backspace 把「当前正在看的那张」移入回收站。
   *
   * 为什么不用确认弹窗：键盘删除是「快速清理」动作，一张张弹确认等于没法用。
   * 移进回收站是可还原的，比直接删安全得多，所以这里直接执行并给一条 toast。
   *
   * 灯箱开着时清的是灯箱那张（而不是画廊里选中的那张）—— 用户眼睛看的是哪个就该删哪个。
   */
  const handleDeleteKey = () => {
    if (!task || reapplying) return
    // 多选时 Delete 删掉选中的所有图（和文件管理器一致），单张逻辑保持不变
    if (selectionRef.current.ids.length > 1) {
      const ids = selectionRef.current.ids.filter((id) => !(task.trashedOutputImages ?? []).includes(id))
      if (!ids.length) return
      void trashOutputImages(task.id, ids)
      setSelection(EMPTY_SELECTION)
      return
    }
    const target = lightboxImageId || currentOutputImageId
    if (!target) return
    // 已经进了回收站就不再重复处理
    if ((task.trashedOutputImages ?? []).includes(target)) return

    // 灯箱开着时先把视图挪到下一张，再执行回收：
    // 这样画面不会停在「一张已经不存在的图」上，也不会因为列表变化而退出
    if (lightboxImageId && lightboxImageList.length > 1) {
      const nextIndex = nextIndexAfterDelete(lightboxImageList, lightboxImageId)
      const nextId = nextIndex >= 0 ? lightboxImageList[nextIndex] : null
      // 注意：列表里保留被删的那张（见 lightboxNav.pinnedNavList），所以这里只是切换，
      // 灯箱不会被关掉，用户可以接着按 Delete 继续清理
      if (nextId && nextId !== lightboxImageId) {
        setLightboxImageId(nextId, lightboxImageList, lightboxPrompt)
      }
    }
    doTrashImage(target)
  }

  deleteKeyHandlerRef.current = handleDeleteKey

  const handleCopyPrompt = async () => {
    if (!cardInputText.text) return
    try {
      await copyTextToClipboard(getTaskPromptText(cardInputText.text, task.inputImageIds.length))
      showToast('提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制提示词失败', err), 'error')
    }
  }

  const handleShowPromptWarning = () => {
    showCodexCliPrompt(
      true,
      currentRevisedPrompt ? '接口返回的提示词已被改写' : '接口没有返回官方 API 会返回的部分信息',
    )
  }

  const handleCopyInputImage = async () => {
    const imgId = allInputImageIds[0]
    const src = imgId ? imageSrcs[imgId] : ''
    if (!src) return
    try {
      await copyImageSourceToClipboard(src)
      showToast('参考图已复制', 'success')
    } catch (err) {
      console.error(err)
      showToast(getClipboardFailureMessage('复制参考图失败', err), 'error')
    }
  }

  const handleDownloadCurrentOutput = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentOutputImageId || !task) return

    try {
      const result = await downloadImageIds([currentOutputImageId], `task-${task.id}`)
      if (result.canceled) return
      if (result.successCount === 0) {
        showToast(getDownloadErrorMessage(result.error), 'error')
      } else {
        showToast(withSaveLocation('下载成功', result.location), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(getDownloadErrorMessage(err), 'error')
    }
  }

  const handleDownloadCurrentOriginalOutput = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentOriginalOutputImageId || !task) return

    try {
      const result = await downloadImageIds([currentOriginalOutputImageId], `task-${task.id}-orig`)
      if (result.canceled) return
      if (result.successCount === 0) {
        showToast(getDownloadErrorMessage(result.error), 'error')
      } else {
        showToast(withSaveLocation('原图下载成功', result.location), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(getDownloadErrorMessage(err), 'error')
    }
  }

  const handleDownloadAllOutputs = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!task) return
    // 「下载全部」只下还在画廊里的图：回收站里的不参与，否则用户删了又出现在压缩包里
    const visible = visibleOutputImages(task)
    if (!visible.length) return
    const downloadTask = { ...task, outputImages: visible }

    try {
      const fileNameBase = `task-${task.id}`
      // 客户端默认按「一张卡一个同名文件夹」保存，网页版没有文件夹，退回单张下载
      const directionNode = task.sopDirectionId ? sopDirections.find((node) => node.id === task.sopDirectionId) : undefined
      const productNode = directionNode
        ? sopDirections.find((node) => node.id === directionNode.parentId && node.kind === 'product')
        : undefined
      const folderOptions = {
        template: settings.taskFolderTemplate,
        custom: settings.taskFolderCustom,
        product: productNode?.name,
        direction: directionNode?.name,
      }
      let result: Awaited<ReturnType<typeof downloadImageIds>>
      if (settings.zipDownloadRoutes.includes('task-detail-all')) {
        result = await downloadImageEntriesAsZip(getImageZipEntries(visible, fileNameBase), fileNameBase)
      } else if (isTauri) {
        result = await downloadTaskImagesToFolder(downloadTask, folderOptions)
      } else {
        // 网页端用浏览器的目录权限建文件夹，不支持的浏览器退回单张下载
        const folderResult = await downloadTaskImagesToWebFolder(downloadTask, folderOptions)
        result = folderResult.webUnsupported ? await downloadImageIds(visible, fileNameBase) : folderResult
      }
      if (result.canceled) return
      if (result.successCount === 0) {
        showToast(getDownloadErrorMessage(result.error), 'error')
      } else if (result.failCount > 0) {
        showToast(`部分下载失败：成功 ${result.successCount}，失败 ${result.failCount}`, 'error')
      } else {
        showToast(withSaveLocation(result.successCount > 1 ? `下载成功：${result.successCount} 张图片` : '下载成功', result.location), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(getDownloadErrorMessage(err), 'error')
    }
  }


  /** 批量移入回收站：和单张一样可还原，只是不弹确认（回收站本身就是安全网） */
  const handleTrashSelected = () => {
    if (!task || !selectedImageIds.length) return
    setConfirmDialog({
      title: `移入图片回收站（${selectedImageIds.length} 张）`,
      message: '这些图会从画廊和交付里移除，原图仍保留，可在「回收站」里还原。',
      action: () => { void trashOutputImages(task.id, selectedImageIds) },
    })
  }

  /** 批量下载：和「下载全部」同一条链路，只是范围换成选中的那几张 */
  const handleDownloadSelected = async () => {
    if (!task || !selectedImageIds.length) return
    try {
      const fileNameBase = `task-${task.id}`
      const directionNode = task.sopDirectionId ? sopDirections.find((node) => node.id === task.sopDirectionId) : undefined
      const productNode = directionNode
        ? sopDirections.find((node) => node.id === directionNode.parentId && node.kind === 'product')
        : undefined
      const folderOptions = {
        template: settings.taskFolderTemplate,
        custom: settings.taskFolderCustom,
        product: productNode?.name,
        direction: directionNode?.name,
      }
      let result: Awaited<ReturnType<typeof downloadImageIds>>
      if (selectedImageIds.length === 1) {
        result = await downloadImageIds(selectedImageIds, fileNameBase)
      } else if (settings.zipDownloadRoutes.includes('task-detail-all')) {
        result = await downloadImageEntriesAsZip(getImageZipEntries(selectedImageIds, fileNameBase), fileNameBase)
      } else if (isTauri) {
        result = await downloadTaskImagesToFolder({ ...task, outputImages: selectedImageIds }, folderOptions)
      } else {
        const folderResult = await downloadTaskImagesToWebFolder({ ...task, outputImages: selectedImageIds }, folderOptions)
        result = folderResult.webUnsupported ? await downloadImageIds(selectedImageIds, fileNameBase) : folderResult
      }
      if (result.canceled) return
      if (result.successCount === 0) {
        showToast(getDownloadErrorMessage(result.error), 'error')
      } else if (result.failCount > 0) {
        showToast(`部分下载失败：成功 ${result.successCount}，失败 ${result.failCount}`, 'error')
      } else {
        showToast(withSaveLocation(`下载成功：${result.successCount} 张图片`, result.location), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(getDownloadErrorMessage(err), 'error')
    }
  }

  /**
   * 批量交付：只交选中的那几张。
   *
   * 交付本身是按整卡走的，所以这里反过来做 —— 把「没选的」作为排除项传进去。
   * 这样文件名序号、文件夹归属、质检排除都沿用原有逻辑，不必另写一套。
   */
  const handleDeliverSelected = async () => {
    if (!task || !selectedImageIds.length || delivering) return
    if (!isTauri) {
      showToast('网页版请用「批量下载」', 'info')
      return
    }
    setDelivering(true)
    try {
      await deliverTaskNow(task.id, selectedImageIds)
    } finally {
      setDelivering(false)
    }
  }

  /** 批量重新检查：只把选中的图送去质检，不动其它图 */
  const handleInspectSelected = async () => {
    if (!task || !selectedImageIds.length || inspecting) return
    setInspecting(true)
    try {
      const result = await inspectCard({ task, tasks, scope: duplicateScope, imageIds: selectedImageIds })
      if (!result.ok) showToast(`检查失败：${result.error ?? '未知原因'}`, 'error')
    } finally {
      setInspecting(false)
    }
  }

  const handleDownloadPartialImages = async () => {
    if (!task || !streamPartialImageIds.length) return

    try {
      const fileNameBase = `task-${task.id}-partial`
      const result = settings.zipDownloadRoutes.includes('task-detail-partial')
        ? await downloadImageEntriesAsZip(getImageZipEntries(streamPartialImageIds, fileNameBase), fileNameBase)
        : await downloadImageIds(streamPartialImageIds, fileNameBase)
      if (result.canceled) return
      if (result.successCount === 0) {
        showToast(getDownloadErrorMessage(result.error), 'error')
      } else if (result.failCount > 0) {
        showToast(`部分下载失败：成功 ${result.successCount}，失败 ${result.failCount}`, 'error')
      } else {
        showToast(withSaveLocation(`下载成功：${result.successCount} 张中间步骤图`, result.location), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(getDownloadErrorMessage(err), 'error')
    }
  }

  const handleRetry = () => {
    retryTask(task)
    setDetailTaskId(null)
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => setDetailTaskId(null)}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        ref={modalRef}
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] w-full max-w-[92rem] max-h-[92vh] overflow-hidden flex flex-col md:flex-row z-10 ring-1 ring-black/5 dark:ring-white/10 animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 items-center justify-end px-4 md:hidden">
          <button
            onClick={() => setDetailTaskId(null)}
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400"
            aria-label="关闭"
          >
            <CloseIcon className="w-6 h-6" />
          </button>
        </div>

        {/* 左侧：图片 */}
        <div className="md:w-[56%] md:min-w-0 w-full h-64 md:h-auto bg-gray-100 dark:bg-black/20 relative flex items-center justify-center flex-shrink-0 min-h-[16rem]">
          {task.status === 'done' && outputLen > 0 && (
            <div className="absolute right-3 top-[15px] z-20 flex items-center gap-1.5">
              {currentOutputImageId && (
                <div className="relative group flex">
                  <button
                    type="button"
                    {...downloadImageTooltip.handlers}
                    onClick={(e) => {
                      downloadImageTooltip.handlers.onClick()
                      handleDownloadCurrentOutput(e)
                    }}
                      className="flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label="下载图片"
                  >
                    <DownloadIcon className="h-4 w-4" />
                  </button>
                  <ViewportTooltip visible={downloadImageTooltip.visible} className="whitespace-nowrap">
                    下载图片
                  </ViewportTooltip>
                </div>
              )}
              {currentOutputImageId && (
                <div className="relative group flex">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleTrashConfirm(currentOutputImageId)
                    }}
                    className="flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-red-500/80 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label="放入回收站"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                  <ViewportTooltip visible={false} className="whitespace-nowrap">
                    放入回收站
                  </ViewportTooltip>
                </div>
              )}
              {outputLen > 1 && (
                <div className="relative group flex">
                  <button
                    type="button"
                    {...downloadAllTooltip.handlers}
                    onClick={(e) => {
                      downloadAllTooltip.handlers.onClick()
                      handleDownloadAllOutputs(e)
                    }}
                    className="flex items-center justify-center pl-1.5 pr-2 py-0.5 gap-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label="下载全部"
                  >
                    <DownloadIcon className="h-4 w-4" />
                    <span className="text-[9px] font-bold leading-none mt-[1px]">ALL</span>
                  </button>
                  <ViewportTooltip visible={downloadAllTooltip.visible} className="whitespace-nowrap">
                    下载全部
                  </ViewportTooltip>
                </div>
              )}
            </div>
          )}
          {task.status === 'done' && outputLen > 0 && (
            <>
              <div
                ref={galleryScrollRef}
                className="absolute inset-0 overflow-y-auto px-3 pb-12 pt-12"
                onPointerDown={(event) => {
                  // 点在缩略图上不框选（那是选图/放大），只从空白处开始拖
                  if ((event.target as HTMLElement).closest('[data-gallery-image-id]')) return
                  handleMarqueeDown(event)
                }}
                onPointerMove={handleMarqueeMove}
                onPointerUp={handleMarqueeUp}
                onPointerLeave={handleMarqueeUp}
                onPointerCancel={handleMarqueeUp}
              >
                {/* 框选矩形：绝对定位在滚动容器的内容坐标上（容器是 absolute，直接作基准），跟着滚动走 */}
                {marquee && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute z-10 rounded border border-blue-400/70 bg-blue-400/20"
                    style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
                  />
                )}
                {/* 行优先：先从左到右排满一行再换行。CSS 多列是列优先，读起来是纵向跳的 */}
                <div className="flex flex-wrap items-start gap-2">
                  {filteredOutputSlots.map(({ slot, index }) => {
                    if (slot.error) {
                      return (
                        <div
                          key={`slot-error-${slot.requestIndex}`}
                          style={{ width: galleryTileSize }}
                          className="flex h-20 shrink-0 items-center justify-center rounded-lg bg-black/5 text-xs text-red-500 dark:bg-white/[0.04]"
                        >
                          第 {index + 1} 张失败
                        </div>
                      )
                    }
                    const src = slot.imageId ? outputPreviewSrcs[slot.imageId] || '' : ''
                    if (!src) return null
                    return (
                      <button
                        key={slot.imageId}
                        type="button"
                        onClick={(event) => {
                          // 照文件管理器：单击单选，Ctrl 加选 / 取消，Shift 连选
                          setImageIndex(index)
                          setSelection((prev) => clickSelect(prev, selectionOrder, slot.imageId, {
                            toggle: event.ctrlKey || event.metaKey,
                            range: event.shiftKey,
                          }))
                        }}
                        onDoubleClick={() => {
                          // 双击才是看大图；筛选中时只在这类图里翻页
                          const ids = galleryFilter === 'all'
                            ? visibleOutputImages(task)
                            : filteredOutputSlots.map((item) => item.slot.imageId).filter(Boolean)
                          setLightboxImageId(slot.imageId, ids)
                        }}
                        onTouchEnd={(e) => {
                          // 触屏没有 dblclick：两次点击间隔 < 300ms 当双击处理
                          const now = Date.now()
                          const last = lastThumbTapRef.current
                          lastThumbTapRef.current = { id: slot.imageId, at: now }
                          if (last && last.id === slot.imageId && now - last.at < 300) {
                            e.preventDefault()
                            lastThumbTapRef.current = null
                            const ids = galleryFilter === 'all'
                              ? visibleOutputImages(task)
                              : filteredOutputSlots.map((item) => item.slot.imageId).filter(Boolean)
                            setLightboxImageId(slot.imageId, ids)
                          }
                        }}
                        data-gallery-image-id={slot.imageId}
                        title="单击选中 · Ctrl 单击加选 · Shift 单击连选 · 双击看大图"
                        style={{ width: galleryTileSize }}
                        className={`group relative block shrink-0 overflow-hidden rounded-lg transition-shadow ${
                          isSelected(selection, slot.imageId) ? 'ring-2 ring-blue-500' : ''
                        }`}
                      >
                        <img
                          src={src}
                          data-image-id={slot.imageId}
                          className="saveable-image w-full h-auto object-contain"
                          onLoad={(e) => {
                            const image = e.currentTarget
                            if (slot.imageId && image.naturalWidth > 0 && image.naturalHeight > 0) {
                              setImageRatios((prev) => ({
                                ...prev,
                                [slot.imageId]: formatImageRatio(image.naturalWidth, image.naturalHeight),
                              }))
                              setImageSizes((prev) => ({
                                ...prev,
                                [slot.imageId]: `${image.naturalWidth}×${image.naturalHeight}`,
                              }))
                            }
                          }}
                          alt=""
                        />
                        <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1 py-0.5 font-mono text-[9px] leading-none text-white">
                          {index + 1}
                        </span>
                        {/* 多选时左上角打勾：一眼看出哪些会被批量操作命中 */}
                        {selection.ids.length > 1 && (
                          <span
                            className={`absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none ${
                              isSelected(selection, slot.imageId)
                                ? 'bg-blue-500 text-white'
                                : 'border border-white/70 bg-black/25 text-transparent'
                            }`}
                          >
                            ✓
                          </span>
                        )}
                        {(verdictOf(slot.imageId) || clipScores[slot.imageId]) && (
                          <div className="absolute bottom-1 left-1 flex items-center gap-1">
                            {verdictOf(slot.imageId) && (
                              <span
                                className={`rounded px-1 py-0.5 text-[9px] font-medium leading-none text-white ${
                                  verdictOf(slot.imageId)!.verdict === 'fail'
                                    ? 'bg-red-500/85'
                                    : verdictOf(slot.imageId)!.verdict === 'unsure'
                                      ? 'bg-amber-500/85'
                                      : 'bg-emerald-600/85'
                                }`}
                                title={verdictOf(slot.imageId)!.reason || '质检结论'}
                              >
                                {verdictOf(slot.imageId)!.verdict === 'fail' ? '不合格' : verdictOf(slot.imageId)!.verdict === 'unsure' ? '待定' : '合格'}
                                {manualQcVerdicts[slot.imageId] ? '·人工' : ''}
                              </span>
                            )}
                            {clipScores[slot.imageId] && (
                              <span
                                className={`rounded px-1 py-0.5 text-[9px] font-medium leading-none text-white ${
                                  clipScores[slot.imageId].max > clipLimit ? 'bg-red-500/85' : 'bg-black/55'
                                }`}
                                title={`与最像的一张重复度 ${Math.round(clipScores[slot.imageId].max * 100)}%，同批平均 ${Math.round(clipScores[slot.imageId].mean * 100)}%`}
                              >
                                重复 {Math.round(clipScores[slot.imageId].max * 100)}%
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
              {/*
                底部浮层：总数和缩放条并排放在同一行。
                以前「共 N 张」自己绝对居中、缩放条也绝对居中，两块同 z-index 的浮层
                叠在同一个位置，互相遮挡。合成一行后谁也不会压住谁。
                左右留白相等，内容才是真居中；留白宽度取 20 是为了让开右下角的「下载原图」。
                窄到排不下时 flex-wrap 自动堆成两行，也不会互相压住。
              */}
              <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex flex-wrap items-center justify-center gap-2 px-20">
                {outputLen > 1 && (
                  <span className="rounded-full bg-black/50 px-2 py-1 text-xs text-white shadow-sm backdrop-blur-sm">
                    {galleryFilter === 'all'
                      ? `共 ${outputLen} 张`
                      : `筛出 ${filteredOutputSlots.length} / ${outputLen} 张`}
                  </span>
                )}
                {/* 按质检标签筛：图多时不用一张张翻着找坏图 */}
                <GalleryFilterBar
                  filter={galleryFilter}
                  onChange={setGalleryFilter}
                  counts={filterCounts}
                  total={outputLen}
                  limit={clipLimit}
                />
                <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-white shadow-sm backdrop-blur-sm">
                  <button
                    type="button"
                    aria-label="缩小"
                    onClick={() => setGalleryZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))}
                    className="flex h-4 w-4 items-center justify-center rounded-full transition hover:bg-white/20"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M5 12h14" />
                    </svg>
                  </button>
                  <input
                    type="range"
                    min={0.5}
                    max={3}
                    step={0.02}
                    value={galleryZoom}
                    onChange={(e) => setGalleryZoom(Number(e.target.value))}
                    aria-label="缩略图缩放"
                    className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/30 accent-white"
                  />
                  <button
                    type="button"
                    aria-label="放大"
                    onClick={() => setGalleryZoom((value) => Math.min(3, Number((value + 0.1).toFixed(2))))}
                    className="flex h-4 w-4 items-center justify-center rounded-full transition hover:bg-white/20"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setGalleryZoom(1)}
                    title="恢复自适应"
                    className="min-w-[32px] text-[10px] tabular-nums text-white/90 transition hover:text-white"
                  >
                    {Math.round(galleryZoom * 100)}%
                  </button>
                </div>
              </div>
              {/*
                批量操作条：多选（2 张以上）才出现。
                单独占底部一行，不挤进「张数 / 筛选 / 缩放」那一排 —— 那排已经很满了。
              */}
              {selection.ids.length > 1 && (
                <div className="pointer-events-none absolute inset-x-0 bottom-12 z-20 flex justify-center px-4">
                  <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-full bg-black/65 px-3 py-1.5 text-white shadow-lg backdrop-blur-sm">
                    <span className="text-xs font-medium tabular-nums">已选 {selectedImageIds.length} 张</span>
                    <span className="h-3 w-px bg-white/25" />
                    <button
                      type="button"
                      onClick={handleDownloadSelected}
                      className="rounded-full px-2 py-0.5 text-xs transition hover:bg-white/20"
                    >
                      下载
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleDeliverSelected() }}
                      disabled={delivering || !isTauri}
                      title={isTauri ? '把选中的图交付到交付文件夹' : '网页版没有交付文件夹，请用下载'}
                      className="rounded-full px-2 py-0.5 text-xs transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {delivering ? '交付中…' : '交付'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleInspectSelected() }}
                      disabled={inspecting}
                      className="rounded-full px-2 py-0.5 text-xs transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {inspecting ? '检查中…' : '重新检查'}
                    </button>
                    <button
                      type="button"
                      onClick={handleTrashSelected}
                      className="rounded-full px-2 py-0.5 text-xs text-red-200 transition hover:bg-red-500/40"
                    >
                      删入回收站
                    </button>
                    <span className="h-3 w-px bg-white/25" />
                    <button
                      type="button"
                      onClick={() => setSelection(EMPTY_SELECTION)}
                      title="取消选择（Esc）"
                      className="rounded-full px-2 py-0.5 text-xs text-white/70 transition hover:bg-white/20 hover:text-white"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              <div data-selectable-text className="absolute left-4 top-[15px] flex items-center gap-1.5">
                {currentImageRatio && currentImageSize ? (
                  <>
                    <span className="bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      {currentImageRatio}
                    </span>
                    <span className="bg-black/50 text-white/90 text-xs px-2 py-0.5 rounded backdrop-blur-sm font-medium">
                      {currentImageSize}
                    </span>
                  </>
                ) : (
                  formatDuration() && (
                    <span className="flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {formatDuration()}
                    </span>
                  )
                )}
                {/*
                 * 打开成品图位置 / 打开原图位置 / 收藏：原本占底部操作区一整排，
                 * 但这三个是「对着当前这张图」的动作，跟左下角的尺寸信息是同一件事，
                 * 放一起看更顺手，底部那排就只留任务级的操作。
                 * 底图可能是深色成品图，浅色底会糊掉，这里统一用黑底半透明。
                 */}
                {/*
                 * 打开交付文件夹：交付目录 + 卡文件夹。原来是「打开成品图内部存储位置」，
                 * 但图片按 hash 分桶存在 data/images 下，那个位置对用户没意义，
                 * 看成品图的入口统一交给右边的「下载」以及任务卡本身。
                 */}
                <button
                  type="button"
                  onClick={() => void handleOpenDeliveryFolder()}
                  className="flex h-7 w-7 items-center justify-center rounded bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/70 focus:outline-none focus:ring-1 focus:ring-white/50"
                  title={deliveryTarget ? `打开交付文件夹（${deliveryTarget.path}）` : '打开交付文件夹（还没配置交付地址）'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => void handleRevealCurrentImage('original')}
                  className="flex h-7 w-7 items-center justify-center rounded bg-black/50 text-white backdrop-blur-sm transition hover:bg-black/70 focus:outline-none focus:ring-1 focus:ring-white/50"
                  title="打开文件所在位置（当前这张原图）"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <circle cx="8.5" cy="9.5" r="1.5" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 16l-5-5-4 4-2-2-4 4" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={handleToggleFavorite}
                  className={`flex h-7 w-7 items-center justify-center rounded backdrop-blur-sm transition focus:outline-none focus:ring-1 focus:ring-white/50 ${
                    task.isFavorite
                      ? 'bg-yellow-500/80 text-white hover:bg-yellow-500'
                      : 'bg-black/50 text-white hover:bg-black/70'
                  }`}
                  title={task.isFavorite ? '编辑收藏夹' : '收藏任务'}
                >
                  <svg className="w-4 h-4" fill={task.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                  </svg>
                </button>
              </div>
              {currentOriginalOutputImageId && (
                <div className="absolute bottom-4 right-4 z-20 flex">
                  <button
                    type="button"
                    {...downloadOriginalImageTooltip.handlers}
                    onClick={(e) => {
                      downloadOriginalImageTooltip.handlers.onClick()
                      handleDownloadCurrentOriginalOutput(e)
                    }}
                    className="flex items-center justify-center gap-0.5 rounded bg-black/50 py-0.5 pl-1.5 pr-2 text-white backdrop-blur-sm transition hover:bg-black/70 focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label="下载原图"
                  >
                    <DownloadIcon className="h-4 w-4" />
                    <span className="text-[9px] font-bold leading-none mt-[1px] uppercase">orig</span>
                  </button>
                  <ViewportTooltip visible={downloadOriginalImageTooltip.visible} className="whitespace-nowrap">
                    下载原图
                  </ViewportTooltip>
                </div>
              )}
            </>
          )}
          {task.status === 'done' && outputLen > 0 && currentOutputError && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-red-500">第 {currentOutputSlot.requestIndex + 1} 张生成失败</p>
              <p
                className="mt-2 overflow-hidden whitespace-pre-line text-sm leading-6 text-red-500 break-words"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 8,
                }}
              >
                {currentOutputError}
              </p>
              {outputLen > 1 && (
                <>
                  <button
                    onClick={() => setImageIndex((imageIndex - 1 + outputLen) % outputLen)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setImageIndex((imageIndex + 1) % outputLen)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                    {imageIndex + 1} / {outputLen}
                  </span>
                  {/* 整组图片是摊平展示的，这里给个直达逐条对照的入口 */}
                  {groupTasks.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPairOpen(true)}
                      title="查看每条提示词与它产出的图"
                      className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white transition hover:bg-black/70"
                    >
                      图 ↔ 提示词
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {(task.status === 'running' || isFalReconnecting) && (
            <>
              <div className="absolute left-4 top-4 flex items-center gap-1 bg-black/50 text-white text-xs px-2 py-0.5 rounded backdrop-blur-sm font-mono">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {formatDuration()}
              </div>
              {task.status === 'running' && streamPreviewLen > 0 && (
                <>
                  {currentStreamPreviewSrc ? (
                    <img
                      src={currentStreamPreviewSrc}
                      className={`max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] object-contain ${streamPreviewLoaded ? '' : 'hidden'}`}
                      alt=""
                      onLoad={() => setStreamPreviewLoaded(true)}
                      onError={() => setStreamPreviewLoaded(false)}
                    />
                  ) : null}
                  {(!currentStreamPreviewSrc || !streamPreviewLoaded) && (
                    <svg className="w-10 h-10 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {streamPreviewLoaded && (
                    <span className="absolute top-4 right-4 flex items-center gap-1 rounded bg-blue-500 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
                      流式预览
                    </span>
                  )}
                  {streamPreviewLen > 1 && (
                    <>
                      <button
                        onClick={() => setImageIndex((imageIndex - 1 + streamPreviewLen) % streamPreviewLen)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setImageIndex((imageIndex + 1) % streamPreviewLen)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-black/30 text-white hover:bg-black/50 transition"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
                        {imageIndex + 1} / {streamPreviewLen}
                      </span>
                    </>
                  )}
                </>
              )}
              {task.status === 'running' && streamPreviewLen === 0 && (
                <svg className="w-10 h-10 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
            </>
          )}
          {task.status === 'error' && isFalReconnecting && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-yellow-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <p className="text-sm font-medium text-yellow-500">重连中</p>
            </div>
          )}
          {task.status === 'error' && !isFalReconnecting && (
            <div className="w-full max-w-md px-4 text-center">
              <svg className="w-10 h-10 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p
                className="overflow-hidden whitespace-pre-line text-sm leading-6 text-red-500 break-words"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 10,
                }}
              >
                {task.error || '生成失败'}
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <div className="relative group">
                  <button
                    type="button"
                    {...copyErrorTooltip.handlers}
                    onClick={() => {
                      copyErrorTooltip.handlers.onClick()
                      handleCopyError()
                    }}
                    className="inline-flex items-center justify-center rounded-full border border-red-200/80 bg-white/80 px-3 py-1.5 text-red-500 transition hover:bg-red-500/[0.1] dark:border-red-400/20 dark:bg-white/[0.04] dark:hover:bg-red-500/[0.16]"
                    aria-label="复制完整报错"
                  >
                    <CopyIcon className="h-4 w-4" />
                  </button>
                  <ViewportTooltip visible={copyErrorTooltip.visible} className="whitespace-nowrap">
                    复制完整报错
                  </ViewportTooltip>
                </div>
                {task.rawResponsePayload && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...viewRawResponseTooltip.handlers}
                      onClick={() => {
                        dismissAllTooltips()
                        setShowRawResponseModal(true)
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-purple-200/80 bg-purple-50 px-3 py-1.5 text-purple-600 transition hover:bg-purple-100 dark:border-purple-500/20 dark:bg-purple-500/10 dark:text-purple-400 dark:hover:bg-purple-500/20"
                      aria-label="查看原始响应"
                    >
                      <CodeIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={viewRawResponseTooltip.visible} className="whitespace-nowrap">
                      查看原始响应
                    </ViewportTooltip>
                  </div>
                )}
                {task.rawImageUrls && task.rawImageUrls.length > 0 && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...copyRawUrlsTooltip.handlers}
                      onClick={async () => {
                        if (task.rawImageUrls!.length === 1) {
                          copyRawUrlsTooltip.handlers.onClick()
                          try {
                            await copyTextToClipboard(task.rawImageUrls![0])
                            showToast('图片链接已复制', 'success')
                          } catch (err) {
                            showToast(getClipboardFailureMessage('复制链接失败', err), 'error')
                          }
                        } else {
                          dismissAllTooltips()
                          setShowRawUrlsModal(true)
                        }
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-green-200/80 bg-green-50 px-3 py-1.5 text-green-600 transition hover:bg-green-100 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20"
                      aria-label="复制图片链接"
                    >
                      <LinkIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={copyRawUrlsTooltip.visible} className="whitespace-nowrap">
                      复制图片链接
                    </ViewportTooltip>
                  </div>
                )}
                {streamPartialImageIds.length > 0 && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...downloadPartialImagesTooltip.handlers}
                      onClick={() => {
                        downloadPartialImagesTooltip.handlers.onClick()
                        void handleDownloadPartialImages()
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-amber-200/80 bg-amber-50 px-3 py-1.5 text-amber-600 transition hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/20"
                      aria-label="下载中间步骤图"
                    >
                      <DownloadIcon className="h-4 w-4" />
                    </button>
                    <ViewportTooltip visible={downloadPartialImagesTooltip.visible} className="whitespace-nowrap">
                      下载中间步骤图
                    </ViewportTooltip>
                  </div>
                )}
                {!isCustomReconnecting && (
                  <div className="relative group">
                    <button
                      type="button"
                      {...retryTooltip.handlers}
                      onClick={() => {
                        retryTooltip.handlers.onClick()
                        handleRetry()
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-blue-200/80 bg-white/80 px-3 py-1.5 text-blue-500 transition hover:bg-blue-50 dark:border-blue-400/20 dark:bg-white/[0.04] dark:hover:bg-blue-500/10"
                      aria-label="重试任务"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                    <ViewportTooltip visible={retryTooltip.visible} className="whitespace-nowrap">
                      重试任务
                    </ViewportTooltip>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右侧：信息 */}
        <div className="md:w-[44%] md:min-w-0 w-full p-5 overflow-y-auto overflow-x-hidden overscroll-contain flex flex-col">
          <button
            onClick={() => setDetailTaskId(null)}
            className="absolute top-3 right-3 hidden p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400 z-10 md:block"
            aria-label="关闭"
          >
            <CloseIcon className="w-5 h-5" />
          </button>

          <div data-selectable-text className="flex-1">
            <div className="flex items-center gap-1.5 mb-2">
              <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                输入内容
              </h3>
              {/* 生成出来的提示词与对应图收进一个入口：详情页只显示「输入内容」，不再铺一片文字墙 */}
              {groupTasks.length > 1 && (
                <button
                  type="button"
                  onClick={() => setPairOpen(true)}
                  title="查看每条提示词与它产出的图"
                  className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 transition-colors hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.12]"
                >
                  {groupTasks.length} 条提示词 · 看图
                </button>
              )}
              {cardInputText.text && !showPendingPrompt && (
                <button
                  onClick={handleCopyPrompt}
                  className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                  title="复制提示词"
                >
                  <CopyIcon className="h-4 w-4" />
                </button>
              )}
              {showPromptWarning && (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    className="p-1 rounded text-amber-500 hover:bg-amber-50 dark:text-yellow-300 dark:hover:bg-yellow-500/10 transition"
                    onClick={handleShowPromptWarning}
                    aria-label="提示词已被改写"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
            {showPendingPrompt ? (
              <div className="mb-4 leading-relaxed">
                <p className="text-sm text-gray-700 dark:text-gray-300">正在生成……</p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">输入内容将在响应完成时接收</p>
              </div>
            ) : cardInputText.text ? (
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap mb-4">
                {getTaskPromptText(cardInputText.text, task.inputImageIds.length)}
              </p>
            ) : (
              <p className="mb-4 text-sm leading-relaxed text-gray-400 dark:text-gray-500">
                输入框没有填写内容
                {groupTasks.length > 1 && (
                  <span className="ml-1 text-xs">
                    （这 {groupTasks.length} 条提示词由 SOP / 变量提示词生成，点上方「{groupTasks.length} 条提示词 · 看图」逐条看）
                  </span>
                )}
              </p>
            )}
            {/* 渠道独立展示：不依赖有没有 SOP 正文，普通任务也要能看到 */}
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
              <span>
                归属：{task.sopDirectionId ? (directionPath(sopDirections, task.sopDirectionId) || '未归属') : '未归属'}
              </span>
              <span className="text-gray-300 dark:text-gray-600">·</span>
              <span>
                渠道：
                <span className={task.channel ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-gray-400'}>
                  {channelLabel(task.channel)}
                </span>
              </span>
              {/* 直接用库里 SOP 出图时，来源记在 sopLibraryName 上，不走系统提示词 */}
              {task.sopLibraryName && (
                <>
                  <span className="text-gray-300 dark:text-gray-600">·</span>
                  <span>
                    生图 SOP：<span className="font-medium text-teal-600 dark:text-teal-400">{task.sopLibraryName}</span>
                  </span>
                </>
              )}
              {/* 用了哪份系统提示词：只在记录的是名字时才显示，老任务存的是提示词正文首行，跳过 */}
              {!task.sopLibraryName && task.sopSystemPrompt && !/^[>#]/.test(task.sopSystemPrompt) && (
                <>
                  <span className="text-gray-300 dark:text-gray-600">·</span>
                  <span>
                    {task.variableMode ? '变量提示词' : '系统提示词'}：
                    <span className="font-medium text-gray-500 dark:text-gray-400">{task.sopSystemPrompt}</span>
                  </span>
                </>
              )}
            </div>
            {task.sopText && (
              <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 dark:border-white/[0.08]">
                <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 dark:bg-white/[0.04]">
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {task.variableMode ? '变量策略' : '生图 SOP'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-gray-700 dark:text-gray-300">{task.sopName || ''}</span>
                  {/* 图生图：让人一眼看出这批是带底图出的，以及底图的保真档 */}
                  {!task.variableMode && task.imageFidelity && task.inputImageIds.length > 0 && (
                    <span
                      className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                      title="这批是带底图出的；档位决定底图里哪些元素必须保留"
                    >
                      底图 · {imageFidelityLabel(task.imageFidelity)}
                    </span>
                  )}
                  {/* 一组提示词对应一组图，这里给一个逐条对照的入口 */}
                  {groupTasks.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPairOpen(true)}
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                        task.variableMode
                          ? 'border-gray-200 text-gray-600 hover:border-violet-300 hover:text-violet-600 dark:border-white/10 dark:text-gray-300 dark:hover:border-violet-500/40 dark:hover:text-violet-300'
                          : 'border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-300 dark:hover:border-blue-500/40 dark:hover:text-blue-300'
                      }`}
                    >
                      图 ↔ 提示词（{groupTasks.length}）
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSopEditing(true)}
                    className={`shrink-0 text-xs hover:underline ${
                      task.variableMode
                        ? 'text-violet-600 dark:text-violet-400'
                        : 'text-blue-600 dark:text-blue-400'
                    }`}
                  >
                    编辑
                  </button>
                  {/* 反推出来的好 SOP 直接存进库，下次在输入框选它就能免反推出图 */}
                  {!task.variableMode && (
                    <button
                      type="button"
                      onClick={handleSaveSopToLibrary}
                      className="shrink-0 text-xs text-teal-600 hover:underline dark:text-teal-400"
                      title="把这份 SOP 存进 SOP 库（按这张卡所属产品共享）"
                    >
                      存入库
                    </button>
                  )}
                </div>
                {/* 变量模式：先亮出这一条填进去的具体取值，再看整份策略 */}
                {task.variableMode && task.variableAssignments && (
                  <div className="border-b border-gray-100 px-3 py-2 dark:border-white/[0.06]">
                    <div className="mb-1 text-[11px] font-medium text-violet-600 dark:text-violet-300">
                      本次填入的变量
                      {task.variableSkeleton ? ` · ${task.variableSkeleton}` : ''}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(task.variableAssignments).map(([name, value]) => (
                        <span
                          key={name}
                          className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-500/15 dark:text-violet-200"
                        >
                          {name}：{value}
                        </span>
                      ))}
                    </div>
                    {task.variableAssignments && Object.keys(task.variableAssignments).length === 0 && (
                      <span className="text-[11px] text-gray-400">这一条没有可替换变量</span>
                    )}
                    {task.variableImageId && (
                      <div className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                        图生图：固定图 {task.variableFixedImageIds?.length ?? 0} 张每条都带 · 这一条用的变量图
                        {' '}
                        <span className="font-mono text-gray-500 dark:text-gray-400">{task.variableImageId.slice(0, 8)}</span>
                      </div>
                    )}
                  </div>
                )}
                <div
                  onDoubleClick={() => setSopEditing(true)}
                  title="双击编辑"
                  className="max-h-40 cursor-text overflow-auto whitespace-pre-wrap px-3 py-2 text-xs leading-relaxed text-gray-600 dark:text-gray-400"
                >
                  {task.sopText}
                </div>
                <div className="border-t border-gray-100 px-3 py-1.5 text-[11px] text-gray-400 dark:border-white/[0.06]">
                  {task.sopLibraryName
                    ? `SOP 库：${task.sopLibraryName}`
                    : `${task.variableMode ? '变量提示词' : '系统提示词'}：${task.sopSystemPrompt || '(未记录)'}`}
                  {' · '}第 {task.sopPromptIndex ?? 1} 条提示词
                  {task.sopDirectionId && ` · 归属：${directionPath(sopDirections, task.sopDirectionId) || '未归属'}`}
                </div>
              </div>
            )}
            {sopEditing && task.sopJobId && (
              <SopEditorModal
                title={task.sopName || '生图 SOP'}
                value={task.sopText || ''}
                onClose={() => setSopEditing(false)}
                onSave={(next) => {
                  updateSopText(task.sopJobId as string, task.sopName || '生图 SOP', next)
                  setSopEditing(false)
                }}
              />
            )}
            {pairOpen && groupTasks.length > 1 && (
              <PromptPairModal
                tasks={groupTasks}
                title={task.sopName || '图片与提示词对照'}
                onClose={() => setPairOpen(false)}
              />
            )}
            {showRevisedPrompt && currentRevisedPrompt && (
              <div className="mb-4">
                <ActualValueBadge
                  value={currentRevisedPrompt}
                  className="max-w-full rounded px-2 py-1 text-left text-xs leading-relaxed whitespace-pre-wrap"
                />
              </div>
            )}

            {/* 参考图 */}
            {showReferenceSection && (
              <div className="mb-4">
                <div className="flex items-center gap-1.5 mb-2">
                  <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                    参考图
                  </h3>
                  {allInputImageIds.length > 0 && (
                    <button
                      onClick={handleCopyInputImage}
                      className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:text-gray-500 dark:hover:bg-white/[0.06] transition"
                      title="复制参考图"
                    >
                      <CopyIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {allInputImageIds.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {allInputImageIds.map((imgId, idx) => {
                      const isMaskTarget = imgId === maskTargetId
                      const commentCount = getImageComments(task.prompt, idx).length
                      const displaySrc = (isMaskTarget && maskPreviewSrc) ? maskPreviewSrc : (imageSrcs[imgId] || '')
                      return (
                        <div key={imgId} className="relative group inline-block">
                          <div
                            className={`relative w-16 h-16 rounded-lg overflow-hidden border cursor-pointer hover:opacity-80 transition ${
                              isMaskTarget || commentCount > 0 ? 'border-blue-500 border-2 shadow-sm' : 'border-gray-200 dark:border-white/[0.08]'
                            }`}
                            onClick={() => setLightboxImageId(imgId, allInputImageIds, task.prompt)}
                          >
                            {displaySrc && (
                              <img
                                src={displaySrc}
                                data-image-id={imgId}
                                className="w-full h-full object-cover"
                                alt=""
                              />
                            )}
                            {isMaskTarget && (
                              <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
                                MASK
                              </span>
                            )}
                            {commentCount > 0 && <CommentBadge count={commentCount} className={isMaskTarget ? 'left-1 top-[18px]' : 'left-1 top-1'} />}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {isAgentTask && (
                  <div className={`${allInputImageIds.length > 0 ? 'mt-2 ' : ''}text-xs text-gray-500 dark:text-gray-400`}>
                    {allInputImageIds.length > 0 ? '由模型自主选择，可能包含其他图片' : '由模型自主选择'}
                  </div>
                )}
              </div>
            )}

            {/* 检查：质检与重复度一次跑完，结果统一展示 */}
            {task.status === 'done' && outputLen > 0 && (
              <>
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
                  检查
                </h3>
                <div className="mb-4 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.03]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-gray-400 dark:text-gray-500">质检 + 重复度</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setShowInspectConfig(true)}
                        className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-500 transition hover:bg-gray-100 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/10"
                      >
                        设置
                      </button>
                      <button
                        type="button"
                        onClick={handleInspect}
                        disabled={inspecting}
                        className="rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 transition hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                      >
                        {inspecting ? '检查中…' : '重新检查'}
                      </button>
                    </span>
                  </div>
                  {inspectQc || inspectScore != null ? (
                    <div className="mt-1.5 space-y-1">
                      <div className="flex items-start gap-1.5">
                        <span className="shrink-0 text-gray-400 dark:text-gray-500">质检</span>
                        {inspectQc ? (
                          <span
                            className={`rounded px-1 py-0.5 text-[10px] font-medium text-white ${
                              inspectQc.verdict === 'fail'
                                ? 'bg-red-500/85'
                                : inspectQc.verdict === 'unsure'
                                ? 'bg-amber-500/85'
                                : 'bg-emerald-600/85'
                            }`}
                          >
                            {inspectQc.verdict === 'fail' ? '不合格' : inspectQc.verdict === 'unsure' ? '待定' : '合格'}
                          </span>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">未检查</span>
                        )}
                        {inspectQc?.reason && (
                          <span className="min-w-0 flex-1 text-gray-500 dark:text-gray-400">{inspectQc.reason}</span>
                        )}
                      </div>
                      {/* 自定义检查项：只列没过的，过了的不用占版面 */}
                      {(inspectQc?.custom ?? []).filter((item) => !item.pass).map((item) => (
                        <div key={item.name} className="flex items-start gap-1.5 pl-8 text-[11px] text-red-600 dark:text-red-400">
                          <span className="shrink-0">未通过：{item.name}</span>
                          {item.note && <span className="min-w-0 flex-1 text-red-500/80 dark:text-red-300/80">{item.note}</span>}
                        </div>
                      ))}
                      {/* 具体问题：缺哪句 / 错哪个字 / 多哪句。只给一句概括时，每张图的理由看起来都一样 */}
                      {inspectQc?.details && (
                        <>
                          {(inspectQc.details.missing ?? []).map((item) => (
                            <div key={`missing-${item}`} className="flex items-start gap-1.5 pl-8 text-[11px] text-red-600 dark:text-red-400">
                              <span className="shrink-0">缺少文案</span>
                              <span className="min-w-0 flex-1">{item}</span>
                            </div>
                          ))}
                          {(inspectQc.details.wrong ?? []).map((item) => (
                            <div key={`wrong-${item}`} className="flex items-start gap-1.5 pl-8 text-[11px] text-red-600 dark:text-red-400">
                              <span className="shrink-0">文字有误</span>
                              <span className="min-w-0 flex-1">{item}</span>
                            </div>
                          ))}
                          {(inspectQc.details.extra ?? []).map((item) => (
                            <div key={`extra-${item}`} className="flex items-start gap-1.5 pl-8 text-[11px] text-amber-600 dark:text-amber-400">
                              <span className="shrink-0">多出文案</span>
                              <span className="min-w-0 flex-1">{item}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {/* 压叠/遮挡位置：模型指出「哪个字被什么盖住」，只列位置不给结论就没法排查 */}
                      {(inspectQc?.spots ?? []).map((spot) => (
                        <div key={spot} className="flex items-start gap-1.5 pl-8 text-[11px] text-red-600 dark:text-red-400">
                          <span className="shrink-0">遮挡</span>
                          <span className="min-w-0 flex-1">{spot}</span>
                        </div>
                      ))}
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 text-gray-400 dark:text-gray-500">重复度</span>
                        {inspectScore != null ? (
                          <span className={inspectScore > clipLimit ? 'font-medium text-red-600 dark:text-red-400' : 'font-medium text-gray-700 dark:text-gray-200'}>
                            {Math.round(inspectScore * 100)}%
                          </span>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">
                            {duplicateScope === 'card'
                              ? '这张卡至少要有两张图'
                              : duplicateScope === 'library'
                                ? '向量库里还没有这批图的向量，稍后自动补算'
                                : '需要至少两张同方向的图'}
                          </span>
                        )}
                        {inspectScore != null && (
                          <span className="text-gray-400 dark:text-gray-500">超过 {Math.round(clipLimit * 100)}% 判为重复</span>
                        )}
                        {duplicateScope === 'library' && currentScoreLibraryCount != null && (
                          <span className="text-gray-400 dark:text-gray-500">· 和 {currentScoreLibraryCount} 张历史图比</span>
                        )}
                        {/* 比对范围：点一下换口径，已算的重复度会按新口径重算 */}
                        <span className="ml-auto flex shrink-0 items-center gap-0.5">
                          <span className="text-gray-400 dark:text-gray-500">比对</span>
                          {(['card', 'direction', 'library'] as const).map((value) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setInspectConfig({ duplicateScope: value })}
                              title={value === 'card'
                                ? '只和这张卡里的其它图比'
                                : value === 'direction'
                                  ? '和同产品-方向下的所有成品比'
                                  : '和本机向量库里的全部历史图比（跨批次、跨方向）'}
                              className={`rounded px-1 py-0.5 text-[10px] transition-colors ${
                                duplicateScope === value
                                  ? 'bg-blue-500 text-white'
                                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10'
                              }`}
                            >
                              {value === 'card' ? '卡内' : value === 'direction' ? '同方向' : '全库'}
                            </button>
                          ))}
                        </span>
                        {inspectScore != null && clipEngine === 'phash' && (
                          <span className="text-gray-400 dark:text-gray-500" title="当前环境没有本地 CLIP 服务，改按画面结构（感知哈希）比对，口径与 CLIP 不同">
                            · 画面近似度
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1.5 text-gray-400 dark:text-gray-500">
                      {inspecting ? '正在检查…' : '还没检查过，点「重新检查」跑一次'}
                    </div>
                  )}
                  {/* 一键清理不合格：图多的时候一张张点回收站太慢 */}
                  {failedImageIds.length > 0 && (
                    <div className="mt-2 flex items-center gap-2 border-t border-gray-200/70 pt-2 dark:border-white/[0.06]">
                      <span className="min-w-0 flex-1 text-[11px] text-gray-500 dark:text-gray-400">
                        {failedImageIds.length} 张判为不合格，交付时会跳过
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmDialog({
                          title: '清理不合格图片',
                          message: `把这 ${failedImageIds.length} 张不合格的图移入图片回收站？交付和画廊里都不再出现，需要时可以还原。`,
                          tone: 'danger',
                          confirmText: '移入回收站',
                          action: () => { void trashOutputImages(task.id, failedImageIds) },
                        })}
                        className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-600 transition hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                      >
                        清理不合格（{failedImageIds.length}）
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* 参数 */}
            <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
              参数配置
            </h3>
            {showSourceInfo && (
              <div className="mb-2 min-w-0 overflow-hidden rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.03]">
                <span className="text-gray-400 dark:text-gray-500">来源</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <span className="font-medium text-gray-700 dark:text-gray-200">{taskProviderName}</span>
                  <span className="text-gray-400 dark:text-gray-500"> · {taskProfileName} · {taskModel}</span>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs mb-4 min-w-0">
              {/* 任务 ID：详情页显示完整值，沟通时直接念 / 复制 */}
              <div className="col-span-2 bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">任务 ID</span>
                <br />
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono font-medium text-gray-700 dark:text-gray-200" title={task.id}>
                    {task.id}
                  </span>
                  <button
                    type="button"
                    onClick={() => { void copyTaskIdToClipboard(task.id) }}
                    className="shrink-0 rounded border border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 transition hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/10"
                  >
                    复制
                  </button>
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">尺寸</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="size" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">质量</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="quality" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">格式</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="output_format" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              {supportsTransparentOutput && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                  <span className="text-gray-400 dark:text-gray-500">透明背景</span>
                  <br />
                  <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{transparentOutputText}</span>
                    {currentTransparentOutputFailed && (
                      <span className="ml-1.5 rounded bg-red-50 px-1 py-0.5 text-[10px] font-medium uppercase leading-none text-red-600 dark:bg-red-500/10 dark:text-red-400">
                        failed
                      </span>
                    )}
                  </div>
                </div>
              )}
              {task.params.output_format !== 'png' && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                  <span className="text-gray-400 dark:text-gray-500">压缩率</span>
                  <br />
                  <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                    <span className="font-medium text-gray-700 dark:text-gray-300">{outputCompressionText}</span>
                  </div>
                </div>
              )}
              <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                <span className="text-gray-400 dark:text-gray-500">审核</span>
                <br />
                <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                  <DetailParamValue task={task} paramKey="moderation" className="font-medium" actualParams={currentActualParams} />
                </div>
              </div>
              {!isAgentTask && (
                <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0 overflow-hidden">
                  <span className="text-gray-400 dark:text-gray-500">数量</span>
                  <br />
                  <div className="mt-0.5 overflow-x-auto hide-scrollbar whitespace-nowrap mask-edge-r pr-2">
                    <DetailParamValue task={task} paramKey="n" className="font-medium" />
                  </div>
                </div>
              )}
            </div>

            {/* 时间 */}
            <div className="text-xs text-gray-400 dark:text-gray-500 mb-4">
              <span>创建于 {formatTime(task.createdAt)}</span>
              {task.startedAt != null && task.startedAt > task.createdAt && (
                <span className="relative ml-1 inline-flex align-middle">
                  <button
                    type="button"
                    {...retriedAtTooltip.handlers}
                    className="inline-flex text-gray-400 transition hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                    aria-label="查看重试时间"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </button>
                  <ViewportTooltip visible={retriedAtTooltip.visible} className="whitespace-nowrap">
                    重试于 {formatTime(task.startedAt)}
                  </ViewportTooltip>
                </span>
              )}
              {formatDuration() && <span> · 耗时 {formatDuration()}</span>}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex flex-wrap gap-2 pt-4 border-t border-gray-100 dark:border-white/[0.08]">
            <button
              onClick={handleReuse}
              className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-xl min-w-[8.5rem] bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              复用配置
            </button>
            {/* 只有 SOP 卡才有「再补一批图」的语义：普通卡没有 SOP 可依据 */}
            {task.sopJobId && task.sopText && (
              <button
                onClick={() => setSupplementOpen(true)}
                title="用这张卡的 SOP（或库里另一份）再生成一批图：可以补到这张卡下面，也可以另起一张新卡"
                className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-xl min-w-[8.5rem] bg-teal-50 dark:bg-teal-500/10 text-teal-600 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-500/20 transition text-sm font-medium whitespace-nowrap"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
                </svg>
                再次生成图片
              </button>
            )}
            <button
              onClick={handleEdit}
              disabled={!outputLen}
              className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-xl min-w-[8.5rem] bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
            >
              <EditIcon className="w-4 h-4 flex-shrink-0" />
              编辑输出
            </button>
            <button
              onClick={() => void handleReapplyPost()}
              disabled={!canReapplyPost || reapplying}
              title={canReapplyPost
                ? '用 AI 原图按当前模板重新后处理，覆盖这次的结果（不重新生图）'
                : '这个任务没有保留 AI 原图，或开了透明背景，无法再次后处理'}
              className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-xl min-w-[8.5rem] bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 10A8 8 0 006.3 6.3L4 8.5M4 14a8 8 0 0013.7 3.7L20 15.5" />
              </svg>
              {reapplying ? '后处理中…' : '再次后处理'}
            </button>
            {/*
             * 派发：同一批 AI 原图复制多份，各套一个目标的水印 / Logo。
             * 和「再次后处理」的区别是它不改这张卡 —— 原卡保持原样，目标各新增一张卡。
             */}
            <button
              onClick={() => setDispatchOpen(true)}
              disabled={!outputLen || task.status !== 'done'}
              title="用这批 AI 原图套其他产品 / 方向的水印、Logo，每个目标新增一张卡并写进它的交付地址"
              className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-xl min-w-[8.5rem] bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 11.5l15-7-4 15.5-4-5.5-7-3z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.5 14.5l8-10" />
              </svg>
              派发
            </button>
            <button
              onClick={handleDelete}
              className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-xl min-w-[8.5rem] bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              <TrashIcon className="w-4 h-4 flex-shrink-0" />
              删除任务
            </button>
            {isTauri && (
              <button
                onClick={handleDeliverNow}
                disabled={delivering || !outputLen}
                title={deliveryTarget
                  ? `交付到 ${deliveryTarget.path}（同卡所有提示词的图会写到同一个文件夹）`
                  : '还没配置交付地址，先在左侧「产品-方向」右键配置'}
                className="flex flex-1 items-center justify-center gap-1.5 px-3 py-2 rounded-xl min-w-[8.5rem] bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm font-medium whitespace-nowrap"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v6m0 0l-2.5-2.5M12 17l2.5-2.5" />
                </svg>
                {delivering ? '交付中…' : '立即交付'}
              </button>
            )}
            {/* 进度条自己订阅进度 store，详情页不会因为进度变化而重渲染 */}
            <ReapplyProgressBar />
          </div>
        </div>
      </div>

      {supplementOpen && task && (
        <SopSupplementModal
          task={task}
          existingCount={groupTasks.reduce((max, item) => Math.max(max, item.sopPromptIndex ?? 0), 0)}
          onClose={() => setSupplementOpen(false)}
        />
      )}

      {dispatchOpen && task && (
        <DispatchModal task={task} onClose={() => setDispatchOpen(false)} />
      )}

      {showRawUrlsModal && rawImageUrls.length > 0 && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6"
          onPointerDown={(e) => {
            rawUrlsBackdropPointerDownRef.current = e.target === e.currentTarget
          }}
          onClick={(e) => {
            e.stopPropagation()
            if (rawUrlsBackdropPointerDownRef.current && e.target === e.currentTarget) setShowRawUrlsModal(false)
            rawUrlsBackdropPointerDownRef.current = false
          }}
        >
          <div ref={rawUrlsModalRef} className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-[#1c1c1e]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-white/[0.08] shrink-0">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">原始图片链接 ({rawImageUrls.length})</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(rawImageUrls.join('\n'))
                      showToast('复制成功', 'success')
                    } catch (err) {
                      showToast(getClipboardFailureMessage('复制失败', err), 'error')
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-xs font-medium"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  全部复制
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawUrlsModal(false)}
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300 transition-colors"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5 bg-gray-50/50 dark:bg-black/20 overscroll-contain">
              <div className="space-y-2.5">
                {rawImageUrls.map((url, i) => (
                  <div key={i} className="group flex items-center gap-3 p-3 sm:p-4 rounded-xl bg-white dark:bg-[#1c1c1e] border border-gray-100 dark:border-white/[0.06] shadow-sm hover:shadow-md transition-all">
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <div className="text-xs font-medium text-gray-400 dark:text-gray-500">
                        图片 {i + 1}
                      </div>
                      <div className="text-sm text-gray-700 dark:text-gray-300 truncate select-text" title={url}>
                        {url}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await copyTextToClipboard(url)
                          showToast('复制成功', 'success')
                        } catch (err) {
                          showToast(getClipboardFailureMessage('复制失败', err), 'error')
                        }
                      }}
                      className="flex-shrink-0 p-2 sm:px-3 sm:py-1.5 flex items-center justify-center gap-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-xs font-medium border border-transparent dark:border-white/[0.04]"
                      title="复制链接"
                    >
                      <CopyIcon className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                      <span className="hidden sm:inline">复制</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showRawResponseModal && task?.rawResponsePayload && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-6"
          onPointerDown={(e) => {
            rawResponseBackdropPointerDownRef.current = e.target === e.currentTarget
          }}
          onClick={(e) => {
            e.stopPropagation()
            if (rawResponseBackdropPointerDownRef.current && e.target === e.currentTarget) setShowRawResponseModal(false)
            rawResponseBackdropPointerDownRef.current = false
          }}
        >
          <div
            ref={rawResponseModalRef}
            className="flex w-full max-w-3xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-[#1c1c1e]"
            onPointerDown={(e) => {
              if (!(e.target as Element).closest('[data-selectable-text]')) clearTextSelection()
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-white/[0.08] shrink-0">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">原始响应数据</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(task.rawResponsePayload!)
                      showToast('复制成功', 'success')
                    } catch (err) {
                      showToast(getClipboardFailureMessage('复制失败', err), 'error')
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors text-xs font-medium"
                >
                  <CopyIcon className="w-3.5 h-3.5" />
                  全部复制
                </button>
                <button
                  type="button"
                  onClick={() => setShowRawResponseModal(false)}
                  className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300 transition-colors"
                >
                  <CloseIcon className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 bg-gray-50/50 dark:bg-black/20 overscroll-contain">
              <pre data-selectable-text className="text-[11px] sm:text-xs text-gray-600 dark:text-gray-300 font-mono whitespace-pre-wrap break-all select-text">
                {task.rawResponsePayload.replace(/"(b64_json|base64|data)":\s*"[^"]+"/g, '"$1": "<base64_data>"')}
              </pre>
            </div>
          </div>
        </div>
      )}
      {showInspectConfig && <InspectConfigModal onClose={() => setShowInspectConfig(false)} />}
    </div>
  )
}
