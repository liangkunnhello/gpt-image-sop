import { useEffect, useState, useMemo, useRef } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, showCodexCliPrompt, getCodexCliPromptKey, reapplyPostTemplate, retryTask, updateSopText, trashTask, trashOutputImage, deliverTaskNow, openDeliveryFolderForTask, resolveTaskDeliveryTarget } from '../store'
import type { TaskRecord } from '../types'
import SopEditorModal from './SopEditorModal'
import PromptPairModal from './PromptPairModal'
import { directionPath, useSopStore } from '../lib/sopStore'
import { productIdForDirection } from '../lib/applyPostTemplate'
import { channelLabel } from '../lib/channel'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { useTooltip } from '../hooks/useTooltip'
import { ensureImageCached, getCachedImage } from '../lib/imageCache'
import { formatImageRatio } from '../lib/size'
import { ActualValueBadge, DetailParamValue } from '../lib/paramDisplay'
import { copyImageSourceToClipboard, copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { downloadImageEntriesAsZip, downloadImageIds, downloadTaskImagesToFolder, downloadTaskImagesToWebFolder, getDownloadErrorMessage, getImageZipEntries, withSaveLocation } from '../lib/downloadImages'
import { isTauri } from '../lib/platform'
import { isAgentTaskPromptPending } from '../lib/taskPromptDisplay'
import { visibleOutputImages } from '../lib/taskState'
import { getImageComments, getTaskPromptText, replaceImageMentionsForApi } from '../lib/promptImageMentions'
import { getApiProviderLabel } from '../lib/apiProfiles'
import { openImagesFolder, revealImageFile } from '../lib/openImagesFolder'
import { inspectImages, useClipStore } from '../lib/clipSimilarity'
import { expectFromPrompt } from '../lib/batchCheck'
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
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const openFavoritePicker = useStore((s) => s.openFavoritePicker)
  const settings = useStore((s) => s.settings)
  const dismissedCodexCliPrompts = useStore((s) => s.dismissedCodexCliPrompts)
  const streamPreviewSrc = useStore((s) => detailTaskId ? s.streamPreviews[detailTaskId] || '' : '')
  const streamPreviewSlots = useStore((s) => detailTaskId ? s.streamPreviewSlots[detailTaskId] : undefined)

  const [imageIndex, setImageIndex] = useState(0)
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
  const sopDirections = useSopStore((s) => s.directions)
  const addSavedSop = useSopStore((s) => s.addSavedSop)
  const [now, setNow] = useState(Date.now())
  const [showRawUrlsModal, setShowRawUrlsModal] = useState(false)
  const [showRawResponseModal, setShowRawResponseModal] = useState(false)
  const [streamPreviewLoaded, setStreamPreviewLoaded] = useState(false)
  /** 手动触发的检查是否在进行中（质检 + 重复度一起跑） */
  const [inspecting, setInspecting] = useState(false)
  const [showInspectConfig, setShowInspectConfig] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
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
  const task = useMemo(() => {
    if (!rawTask) return null
    if (!rawTask.sopJobId) return rawTask
    const group = groupTasks
    if (group.length <= 1) return rawTask
    const leader = group[0]
    const anyRunning = group.some((item) => item.status === 'running')
    const allError = group.every((item) => item.status === 'error')
    return {
      ...leader,
      // 普通模式的批量 / 融图没有 SOP 正文，标题按「张图」算
      prompt: leader.sopText
        ? `${leader.sopName || 'SOP'} · ${group.length} 条提示词`
        : `${leader.sopName || '批量'} · ${group.length} 张图`,
      outputImages: group.flatMap((item) => item.outputImages),
      // 原图也按同顺序摊平：否则「下载原图」永远只指向第一条提示词那张，
      // 后面的图会拿错源。老任务没有这个字段时补空串占位，保持下标对齐。
      sourceImages: group.flatMap((item) => item.outputImages.map((_, index) => item.sourceImages?.[index] || '')),
      transparentOriginalImages: group.flatMap((item) => (
        item.outputImages.map((_, index) => item.transparentOriginalImages?.[index] || '')
      )),
      status: anyRunning ? 'running' : allError ? 'error' : 'done',
      elapsed: group.reduce((sum, item) => sum + (item.elapsed ?? 0), 0),
    } as TaskRecord
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

  useCloseOnEscape(Boolean(task), () => setDetailTaskId(null))
  usePreventBackgroundScroll(Boolean(task), [modalRef, rawUrlsModalRef, rawResponseModalRef])

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
  const currentOutputImageId = currentOutputSlot?.imageId || ''
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
  const clipEngine = useClipStore((s) => s.engine)
  const ensureClip = useClipStore((s) => s.ensure)

  useEffect(() => {
    if (!task) return
    // 同方向的图放一起比才有意义，数量不够就退到全部成品
    const sameDirection = tasks.filter((item) => item.status === 'done' && item.sopDirectionId === task.sopDirectionId)
    const scope = sameDirection.length >= 2 ? sameDirection : tasks.filter((item) => item.status === 'done')
    ensureClip(scope)
  }, [task?.id, ensureClip, tasks])

  if (!task) return null

  const isAgentTask = task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)

  // 检查面板用的聚合结果：质检取最差的一张，重复度取最高的一个
  const inspectQcList = visibleOutputImages(task).map((id) => clipQc[id]).filter(Boolean)
  const inspectQc = inspectQcList.find((item) => item.verdict === 'fail')
    ?? inspectQcList.find((item) => item.verdict === 'unsure')
    ?? inspectQcList[0]
    ?? null
  const inspectScoreValues = visibleOutputImages(task).map((id) => clipScores[id]?.max).filter((v): v is number => typeof v === 'number')
  const inspectScore = inspectScoreValues.length ? Math.max(...inspectScoreValues) : null
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
    setReapplying(true)
    try {
      await reapplyPostTemplate(task.id)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
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
  const showPromptWarning = Boolean(isOpenAiTask && task.apiMode === 'responses' && currentOutputImageId && (!currentRevisedPrompt || showRevisedPrompt) && !hasHandledPromptWarning)
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

  /** 手动重跑检查：本任务的图连同同方向历史图一起送后端，一次拿回质检结论和重复度 */
  const handleInspect = async () => {
    if (inspecting) return
    setInspecting(true)
    try {
      const entries: Array<{ imageId: string; dataUrl: string }> = []
      for (const id of visibleOutputImages(task)) {
        const dataUrl = await ensureImageCached(id)
        if (dataUrl) entries.push({ imageId: id, dataUrl })
      }
      // 重复度要有同方向的图一起比，凑不够两张时后端只回质检
      for (const peer of tasks) {
        if (peer.id === task.id || peer.status !== 'done') continue
        if (peer.sopDirectionId !== task.sopDirectionId) continue
        for (const id of visibleOutputImages(peer).slice(0, 2)) {
          const dataUrl = await ensureImageCached(id)
          if (dataUrl) entries.push({ imageId: id, dataUrl })
        }
        if (entries.length >= 12) break
      }
      await inspectImages(entries, { expect: expectFromPrompt(task.prompt), manual: true })
    } catch (err) {
      showToast(`检查失败：${err instanceof Error ? err.message : '未知原因'}`, 'error')
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

  const handleCopyPrompt = async () => {
    if (!task.prompt) return
    try {
      await copyTextToClipboard(getTaskPromptText(task.prompt, task.inputImageIds.length))
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
                      setConfirmDialog({
                        title: '移入图片回收站',
                        message: '这张图会从画廊和交付里移除，原图仍保留，可在「回收站」里还原。',
                        action: () => trashOutputImage(task.id, currentOutputImageId),
                      })
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
              <div className="absolute inset-0 overflow-y-auto px-3 pb-12 pt-12">
                <div style={{ columnWidth: `${galleryTileSize}px`, columnCount: 8, columnGap: '8px' }}>
                  {visibleOutputSlots.map((slot, index) => {
                    if (slot.error) {
                      return (
                        <div
                          key={`slot-error-${slot.requestIndex}`}
                          style={{ breakInside: 'avoid', marginBottom: '8px' }}
                          className="flex h-20 items-center justify-center rounded-lg bg-black/5 text-xs text-red-500 dark:bg-white/[0.04]"
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
                        onClick={() => {
                          setImageIndex(index)
                          setLightboxImageId(slot.imageId, visibleOutputImages(task))
                        }}
                        style={{ breakInside: 'avoid', marginBottom: '8px' }}
                        className={`group relative block w-full overflow-hidden rounded-lg transition-shadow ${index === imageIndex ? 'ring-2 ring-blue-500' : ''}`}
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
                        {(clipQc[slot.imageId] || clipScores[slot.imageId]) && (
                          <div className="absolute bottom-1 left-1 flex items-center gap-1">
                            {clipQc[slot.imageId] && (
                              <span
                                className={`rounded px-1 py-0.5 text-[9px] font-medium leading-none text-white ${
                                  clipQc[slot.imageId].verdict === 'fail'
                                    ? 'bg-red-500/85'
                                    : clipQc[slot.imageId].verdict === 'unsure'
                                      ? 'bg-amber-500/85'
                                      : 'bg-emerald-600/85'
                                }`}
                                title={clipQc[slot.imageId].reason || '质检结论'}
                              >
                                {clipQc[slot.imageId].verdict === 'fail' ? '不合格' : clipQc[slot.imageId].verdict === 'unsure' ? '待定' : '合格'}
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
                    共 {outputLen} 张
                  </span>
                )}
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
              {task.prompt && !showPendingPrompt && (
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
            ) : (
              <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap mb-4">
                {getTaskPromptText(task.prompt, task.inputImageIds.length) || '(无提示词)'}
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
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 text-gray-400 dark:text-gray-500">重复度</span>
                        {inspectScore != null ? (
                          <span className={inspectScore > clipLimit ? 'font-medium text-red-600 dark:text-red-400' : 'font-medium text-gray-700 dark:text-gray-200'}>
                            {Math.round(inspectScore * 100)}%
                          </span>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">需要至少两张同方向的图</span>
                        )}
                        {inspectScore != null && (
                          <span className="text-gray-400 dark:text-gray-500">超过 {Math.round(clipLimit * 100)}% 判为重复</span>
                        )}
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
                title="用这张卡的 SOP（或库里另一份）再写几条提示词，新图补到这张卡下面"
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
