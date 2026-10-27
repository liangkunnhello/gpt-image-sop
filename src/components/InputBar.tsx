import { useRef, useEffect, useCallback, useState, useMemo, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { deleteFavoriteCollection, useStore, submitTask, submitAgentMessage, stopAgentResponse, stopBatchPrompts, addImagesFromFiles, createInputImageFromFile, removeMultipleTasks, assignTasksDirection, assignTasksChannel, taskMatchesFilterStatus, taskMatchesSearchQuery, submitSopTasks } from '../store'
import { DEFAULT_PARAMS, MAX_INPUT_IMAGES, type TaskRecord } from '../types'
import { getActiveAgentRounds } from '../lib/agentConversationState'
import { getActiveApiProfile, getAgentImageApiProfile, normalizeSettings, resolveApiProfileModel, splitModelList } from '../lib/apiProfiles'
import { getImageGenerationModel, isGptImage25Model } from '../lib/imageModels'
import { ensureImageCached, getCachedImage } from '../lib/imageCache'
import { splitBatchPrompts } from '../lib/batchPrompts'
import { DEFAULT_FAL_IMAGE_SIZE, getChangedParams, normalizeParamsForSettings, resolveOutputImageLimit } from '../lib/paramCompatibility'
import { getAtImageQuery, getImageComments, getImageMentionLabel, getPromptIndexFromVisibleIndex, getPromptMentionParts, imageMentionMatches, insertImageMentionAtVisibleRange, insertTextMentionAtVisibleRange, isCursorInSelectedImageMention, stripImageMentionMarkers } from '../lib/promptImageMentions'
import { normalizeCodexCliImageSize, normalizeImageSize } from '../lib/size'
import { planGenerationSize } from '../lib/sizeCapability'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { getSafeBoundingClientRect } from '../lib/domRect'
import { suppressGlobalClicks } from '../lib/clickSuppression'
import { collectAgentRoundOutputImageSlots } from '../lib/agentImageReferences'
import { ALL_FAVORITES_COLLECTION_ID, getTaskFavoriteCollectionIds } from '../lib/favoriteState'
import { getContentEditableCursor, getContentEditablePlainText, getContentEditableSelection, getMentionTagHtml, setContentEditableCursor, setContentEditableSelection, syncMentionTagSelection } from '../lib/contentEditableMentions'
import { useHintTooltip } from '../hooks/useHintTooltip'
import { downloadImageEntriesAsZip, downloadImageIds, downloadTaskCardsToFolders, downloadTaskCardsToWebFolders, formatExportFileTime, getDownloadErrorMessage, getTaskOutputImageZipEntries, withSaveLocation } from '../lib/downloadImages'
import { pickSaveDir } from '../lib/saveFile'
import { isTauri } from '../lib/platform'
import SizePickerModal from './SizePickerModal'
import AssignDirectionModal from './AssignDirectionModal'
import SopSplitModal, { type SopRunOptions } from './SopSplitModal'
import VariableRunModal, { type VariableRunOptions } from './VariableRunModal'
import SopPresetPicker, { resolvePickedPreset } from './SopPresetPicker'
import SopSystemPromptPicker from './SopSystemPromptPicker'
import SopLibraryPicker from './SopLibraryPicker'
import VariablePromptPicker from './VariablePromptPicker'
import PlainImageModeSwitch from './PlainImageModeSwitch'
import { useInputImageLimit } from '../hooks/useInputImageLimit'
import { useSopStore } from '../lib/sopStore'
import { resolveSavedSop } from '../lib/savedSop'
import { scopeChain } from '../lib/sopScope'
import { resolvePostTemplates } from '../lib/applyPostTemplate'
import { parseSizeLimitKb } from '../lib/outputFileSize'
import { buildPromptBundle } from '../lib/promptBundle'
import { taskMatchesChannel } from '../lib/channel'
import { enqueueSopJobs, splitReferenceGroups } from '../lib/sopPipeline'
import { enqueueVariableJobs } from '../lib/variablePipeline'
import { CloseIcon, CollapseIcon, ExpandIcon, SketchIcon } from './icons'
import { CommentBadge } from './CommentMarks'
import ButtonTooltip from './input/buttonTooltip'
import DragUploadOverlay from './input/dragUploadOverlay'
import VariableImageSlots from './input/VariableImageSlots'
import InputThumbImage from './input/inputThumbImage'
import InputBatchBars from './input/inputBatchBars'
import InputParamsPanel from './input/inputParamsPanel'

function getFavoriteCollectionTasksForBatch(collectionId: string, tasks: TaskRecord[], defaultFavoriteCollectionId: string | null) {
  const favoriteTasks = tasks.filter((task) => task.isFavorite)
  if (collectionId === ALL_FAVORITES_COLLECTION_ID) return favoriteTasks
  return favoriteTasks.filter((task) => getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId).includes(collectionId))
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

type AtImageOption =
  | { type: 'input'; key: string; label: string; imageId: string; dataUrl: string; imageIndex: number }
  | { type: 'agent-output'; key: string; label: string; imageId: string; insertText: string }

function agentImageMentionMatches(query: string, label: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const normalizedLabel = label.toLowerCase()
  return normalizedLabel.includes(normalized) || normalizedLabel.replace(/^@/, '').includes(normalized)
}

function AtImageOptionThumb({ option }: { option: AtImageOption }) {
  const [src, setSrc] = useState(option.type === 'input' ? option.dataUrl : getCachedImage(option.imageId) || '')

  useEffect(() => {
    if (option.type === 'input') {
      setSrc(option.dataUrl)
      return
    }

    let cancelled = false
    setSrc(getCachedImage(option.imageId) || '')
    ensureImageCached(option.imageId).then((url) => {
      if (!cancelled && url) setSrc(url)
    })
    return () => {
      cancelled = true
    }
  }, [option])

  return (
    <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-gray-200/70 bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04]">
      {src && <img src={src} className="h-full w-full object-cover" alt="" />}
    </span>
  )
}

export default function InputBar() {
  const prompt = useStore((s) => s.prompt)
  const appMode = useStore((s) => s.appMode)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const addInputImage = useStore((s) => s.addInputImage)
  const setSketchBoard = useStore((s) => s.setSketchBoard)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const setSettings = useStore((s) => s.setSettings)
  const batchProgress = useStore((s) => s.batchProgress)
  const queuedSubmitCount = useStore((s) => s.queuedSubmitCount)
  const settings = useStore((s) => s.settings)
  const reusedTaskApiProfileId = useStore((s) => s.reusedTaskApiProfileId)
  const reusedTaskApiModel = useStore((s) => s.reusedTaskApiModel)
  const setReusedTaskApiModel = useStore((s) => s.setReusedTaskApiModel)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const selectedFavoriteCollectionIds = useStore((s) => s.selectedFavoriteCollectionIds)
  const setSelectedFavoriteCollectionIds = useStore((s) => s.setSelectedFavoriteCollectionIds)
  const clearFavoriteCollectionSelection = useStore((s) => s.clearFavoriteCollectionSelection)
  const tasks = useStore((s) => s.tasks)
  const favoriteCollections = useStore((s) => s.favoriteCollections)
  const defaultFavoriteCollectionId = useStore((s) => s.defaultFavoriteCollectionId)
  const agentConversations = useStore((s) => s.agentConversations)
  const activeAgentConversationId = useStore((s) => s.activeAgentConversationId)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const openFavoritePicker = useStore((s) => s.openFavoritePicker)
  const searchQuery = useStore((s) => s.searchQuery)
  const channelFilter = useStore((s) => s.channelFilter)

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      // 渠道筛选与业务树筛选并列生效
      if (!taskMatchesChannel(t, channelFilter)) return false
      if (filterFavorite) {
        if (!t.isFavorite) return false
        if (activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !getTaskFavoriteCollectionIds(t, defaultFavoriteCollectionId).includes(activeFavoriteCollectionId)) return false
      }
      if (!taskMatchesFilterStatus(t, filterStatus)) return false
      return taskMatchesSearchQuery(t, q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId, defaultFavoriteCollectionId, channelFilter])

  const inCollectionOverview = filterFavorite && !activeFavoriteCollectionId

  const favoriteCollectionCards = useMemo(() => {
    return [
      {
        id: ALL_FAVORITES_COLLECTION_ID,
        name: '全部',
        tasks: getFavoriteCollectionTasksForBatch(ALL_FAVORITES_COLLECTION_ID, tasks, defaultFavoriteCollectionId),
      },
      ...favoriteCollections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        collection,
        tasks: getFavoriteCollectionTasksForBatch(collection.id, tasks, defaultFavoriteCollectionId),
      })),
    ]
  }, [defaultFavoriteCollectionId, favoriteCollections, tasks])

  const filteredFavoriteCollectionCards = useMemo(() => {
    if (!searchQuery.trim()) return favoriteCollectionCards
    const lowerQuery = searchQuery.toLowerCase()
    return favoriteCollectionCards.filter((collection) => collection.name.toLowerCase().includes(lowerQuery))
  }, [favoriteCollectionCards, searchQuery])

  const handleSelectAllVisibleTasks = useCallback(() => {
    setSelectedTaskIds(filteredTasks.map((task) => task.id))
  }, [filteredTasks, setSelectedTaskIds])

  const handleInvertVisibleTasks = useCallback(() => {
    const visibleIds = new Set(filteredTasks.map((task) => task.id))
    setSelectedTaskIds((current) => {
      const currentSet = new Set(current)
      const next = current.filter((id) => !visibleIds.has(id))
      filteredTasks.forEach((task) => {
        if (!currentSet.has(task.id)) next.push(task.id)
      })
      return next
    })
  }, [filteredTasks, setSelectedTaskIds])

  const handleSelectAllVisibleFavoriteCollections = useCallback(() => {
    setSelectedFavoriteCollectionIds(filteredFavoriteCollectionCards.map((collection) => collection.id))
  }, [filteredFavoriteCollectionCards, setSelectedFavoriteCollectionIds])

  const handleInvertVisibleFavoriteCollections = useCallback(() => {
    const visibleIds = new Set(filteredFavoriteCollectionCards.map((collection) => collection.id))
    setSelectedFavoriteCollectionIds((current) => {
      const currentSet = new Set(current)
      const next = current.filter((id) => !visibleIds.has(id))
      filteredFavoriteCollectionCards.forEach((collection) => {
        if (!currentSet.has(collection.id)) next.push(collection.id)
      })
      return next
    })
  }, [filteredFavoriteCollectionCards, setSelectedFavoriteCollectionIds])

  const handleToggleFavorite = useCallback(() => {
    openFavoritePicker(selectedTaskIds)
  }, [openFavoritePicker, selectedTaskIds])

  const handleDeleteSelected = useCallback(() => {
    setConfirmDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${selectedTaskIds.length} 个任务吗？`,
      action: () => {
        removeMultipleTasks(selectedTaskIds)
      },
    })
  }, [selectedTaskIds, setConfirmDialog])

  const [assignOpen, setAssignOpen] = useState(false)

  const handleAssignDirection = useCallback(() => {
    setAssignOpen(true)
  }, [])

  const handleConfirmAssign = useCallback((directionId: string | null, channel?: string | null) => {
    setAssignOpen(false)
    void assignTasksDirection(selectedTaskIds, directionId)
    // undefined = 用户没碰渠道区，不要误清空；null = 明确要清空
    if (channel !== undefined) void assignTasksChannel(selectedTaskIds, channel)
  }, [selectedTaskIds])

  const handleDownloadSelected = useCallback(async () => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const imageIds = selectedTasks.flatMap(t => t.outputImages || [])
    if (imageIds.length === 0) {
      showToast('选中的任务没有图片', 'info')
      return
    }

    try {
      const timeStr = formatExportFileTime(new Date())
      const fileNameBase = `batch-${timeStr}`
      // 客户端默认「一张卡一个同名文件夹」，网页版没有文件夹，退回单张下载
      const resolveNames = (task: { sopDirectionId?: string }) => {
        const node = task.sopDirectionId ? sopDirections.find((item) => item.id === task.sopDirectionId) : undefined
        const product = node ? sopDirections.find((item) => item.id === node.parentId && item.kind === 'product') : undefined
        return { product: product?.name, direction: node?.name }
      }
      const folderOptions = {
        template: settings.taskFolderTemplate,
        custom: settings.taskFolderCustom,
        resolveNames,
      }
      let result: Awaited<ReturnType<typeof downloadImageIds>>
      if (settings.zipDownloadRoutes.includes('task-selection')) {
        result = await downloadImageEntriesAsZip(getTaskOutputImageZipEntries(selectedTasks), fileNameBase)
      } else if (isTauri) {
        result = await downloadTaskCardsToFolders(selectedTasks, folderOptions)
      } else {
        // 网页端用浏览器的目录权限建文件夹，不支持的浏览器退回单张下载
        const folderResult = await downloadTaskCardsToWebFolders(selectedTasks, folderOptions)
        result = folderResult.webUnsupported ? await downloadImageIds(imageIds, fileNameBase) : folderResult
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
    clearSelection()
  }, [tasks, selectedTaskIds, settings.zipDownloadRoutes, showToast, clearSelection])

  const handleDownloadSelectedFavoriteCollections = useCallback(async () => {
    const selectedIdSet = new Set(selectedFavoriteCollectionIds)
    const selectedCollections = favoriteCollectionCards.filter((collection) => selectedIdSet.has(collection.id))
    if (selectedCollections.length === 0) return

    let successCount = 0
    let failCount = 0
    let downloadedCollectionCount = 0
    let location: string | undefined
    let error: string | undefined
    const useZipDownload = settings.zipDownloadRoutes.includes('favorite-collection-selection')
    const timeStr = formatExportFileTime(new Date())

    try {
      // 客户端选中多个收藏夹时只选择一次目录，避免每个收藏夹各弹一次对话框
      const dir = isTauri && selectedCollections.length > 1 ? await pickSaveDir() : null
      if (isTauri && selectedCollections.length > 1 && !dir) return
      for (const collection of selectedCollections) {
        const entries = getTaskOutputImageZipEntries(collection.tasks)
        if (entries.length === 0) continue
        const zipName = collection.id === ALL_FAVORITES_COLLECTION_ID
          ? `favorites-all-${timeStr}`
          : `favorites-${collection.name}-${timeStr}`
        const result = useZipDownload
          ? await downloadImageEntriesAsZip(entries, zipName, dir)
          : await downloadImageIds(entries.map((entry) => entry.imageId), zipName, dir)
        if (result.canceled) return
        successCount += result.successCount
        failCount += result.failCount
        location = dir?.path ?? result.location ?? location
        error = result.error ?? error
        if (result.successCount > 0) downloadedCollectionCount++
        if (selectedCollections.length > 1 && !dir) await delay(100)
      }

      if (successCount === 0 && failCount > 0) {
        showToast(getDownloadErrorMessage(error), 'error')
      } else if (successCount === 0) {
        showToast('选中的收藏夹没有图片', 'info')
      } else if (failCount > 0) {
        showToast(`部分下载失败：成功 ${successCount}，失败 ${failCount}`, 'error')
      } else {
        showToast(withSaveLocation(useZipDownload && downloadedCollectionCount > 1 ? `下载成功：${downloadedCollectionCount} 个压缩包，${successCount} 张图片` : `下载成功：${successCount} 张图片`, location), 'success')
      }
    } catch (err) {
      console.error(err)
      showToast(getDownloadErrorMessage(err), 'error')
    }
    clearFavoriteCollectionSelection()
  }, [clearFavoriteCollectionSelection, favoriteCollectionCards, selectedFavoriteCollectionIds, settings.zipDownloadRoutes, showToast])

  const handleDeleteSelectedFavoriteCollections = useCallback(() => {
    const selectedIdSet = new Set(selectedFavoriteCollectionIds)
    const selectedCollections = favoriteCollections.filter((collection) => selectedIdSet.has(collection.id))
    if (selectedCollections.length === 0) {
      showToast('没有可删除的收藏夹', 'info')
      return
    }
    if (favoriteCollections.length - selectedCollections.length < 1) {
      showToast('至少保留一个收藏夹', 'error')
      return
    }

    const selectedCollectionIds = new Set(selectedCollections.map((collection) => collection.id))
    const imageCount = new Set(
      tasks
        .filter((task) => getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId).some((id) => selectedCollectionIds.has(id)))
        .flatMap((task) => task.outputImages || []),
    ).size
    setConfirmDialog({
      title: '批量删除收藏夹',
      message: `确定要删除选中的 ${selectedCollections.length} 个收藏夹吗？`,
      checkbox: imageCount > 0
        ? {
            label: `同时删除收藏夹中的图片（${imageCount} 张）`,
            tone: 'danger',
          }
        : undefined,
      action: async (deleteImages = false) => {
        for (const collection of selectedCollections) {
          await deleteFavoriteCollection(collection.id, deleteImages)
        }
        clearFavoriteCollectionSelection()
      },
    })
  }, [clearFavoriteCollectionSelection, defaultFavoriteCollectionId, favoriteCollections, selectedFavoriteCollectionIds, setConfirmDialog, showToast, tasks])

  const maskDraft = useStore((s) => s.maskDraft)
  const moveInputImage = useStore((s) => s.moveInputImage)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const imagesRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(42)

  const [isDragging, setIsDragging] = useState(false)
  const [isSingleLine, setIsSingleLine] = useState(true)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [promptExpandedTop, setPromptExpandedTop] = useState(0)
  const [promptCanExpand, setPromptCanExpand] = useState(false)
  const [clearPromptHover, setClearPromptHover] = useState(false)
  const [expandPromptHover, setExpandPromptHover] = useState(false)
  const [submitHover, setSubmitHover] = useState(false)
  const [attachHover, setAttachHover] = useState(false)
  const [imageHintId, setImageHintId] = useState<string | null>(null)
  const [mobileCollapsed, setMobileCollapsed] = useState(false)
  const [showSizePicker, setShowSizePicker] = useState(false)
  const [showUploadMenu, setShowUploadMenu] = useState(false)
  const [maskPreviewUrl, setMaskPreviewUrl] = useState('')
  const [imageDragIndex, setImageDragIndex] = useState<number | null>(null)
  const [imageDragOverIndex, setImageDragOverIndex] = useState<number | null>(null)
  const [atImageMenuIndex, setAtImageMenuIndex] = useState(0)
  const [atImageMenuDismissed, setAtImageMenuDismissed] = useState(false)
  const [touchDragPreview, setTouchDragPreview] = useState<{ src: string; x: number; y: number } | null>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const dragTouchRef = useRef({ startY: 0, moved: false })
  const suppressHandleClickUntilRef = useRef(0)
  const imageDragIndexRef = useRef<number | null>(null)
  const imageTouchDragRef = useRef({ index: null as number | null, startX: 0, startY: 0, moved: false })
  const imageDragOverIndexRef = useRef<number | null>(null)
  const imageDragPreviewRef = useRef<HTMLElement | null>(null)
  const suppressImageClickRef = useRef(false)
  const isUserInputRef = useRef(false)
  const isComposingRef = useRef(false)
  const imageHintLockedRef = useRef(false)
  const imageHintReleaseRef = useRef<(() => void) | null>(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [menuLeft, setMenuLeft] = useState(0)
  const showPromptExpand = promptExpanded || promptCanExpand

  const updateInputBarClearance = useCallback(() => {
    const bar = cardRef.current?.closest<HTMLElement>('[data-input-bar]')
    if (!bar) return

    const rect = bar.getBoundingClientRect()
    const clearance = Math.max(0, window.innerHeight - rect.top)
    document.documentElement.style.setProperty('--input-bar-clearance', `${Math.ceil(clearance)}px`)
  }, [])

  useLayoutEffect(() => {
    const bar = cardRef.current?.closest<HTMLElement>('[data-input-bar]')
    if (!bar) return

    const frame = window.requestAnimationFrame(updateInputBarClearance)
    const observer = new ResizeObserver(updateInputBarClearance)
    observer.observe(bar)

    const visualViewport = window.visualViewport
    window.addEventListener('resize', updateInputBarClearance)
    visualViewport?.addEventListener('resize', updateInputBarClearance)
    visualViewport?.addEventListener('scroll', updateInputBarClearance)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', updateInputBarClearance)
      visualViewport?.removeEventListener('resize', updateInputBarClearance)
      visualViewport?.removeEventListener('scroll', updateInputBarClearance)
      document.documentElement.style.removeProperty('--input-bar-clearance')
    }
  }, [updateInputBarClearance])

  useLayoutEffect(() => {
    if (!promptExpanded) return

    const header = document.querySelector<HTMLElement>('header')
    if (!header) return

    const updateTop = () => setPromptExpandedTop(Math.max(0, header.getBoundingClientRect().bottom) + 8)
    const observer = new ResizeObserver(updateTop)
    observer.observe(header)
    updateTop()
    window.addEventListener('resize', updateTop)
    header.addEventListener('transitionend', updateTop)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateTop)
      header.removeEventListener('transitionend', updateTop)
    }
  }, [promptExpanded])
  const imageHintTimerRef = useRef<number | null>(null)
  const [sizeLimitInput, setSizeLimitInput] = useState(
    params.max_file_kb == null ? '' : String(params.max_file_kb),
  )
  const [nInput, setNInput] = useState(String(params.n))
  const [nInputFocused, setNInputFocused] = useState(false)
  const dragCounter = useRef(0)
  /** 正在导入拖入/选中的图片：挡住重复触发，避免两批同时写状态把顺序打乱 */
  const uploadingRef = useRef(false)
  const isMobile = useIsMobile()

  const settingsActiveProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const currentActiveProfile = useMemo(() => (
    appMode === 'agent'
      ? getAgentImageApiProfile(settings) ?? settingsActiveProfile
      : settingsActiveProfile
  ), [appMode, settings, settingsActiveProfile])
  const activeProfile = useMemo(() => {
    const reusedProfile = appMode !== 'agent' && settings.reuseTaskApiProfileTemporarily && reusedTaskApiProfileId
      ? settings.profiles.find((profile) => profile.id === reusedTaskApiProfileId)
      : undefined
    return reusedProfile ? resolveApiProfileModel(reusedProfile, reusedTaskApiModel ?? undefined) : currentActiveProfile
  }, [appMode, currentActiveProfile, reusedTaskApiModel, reusedTaskApiProfileId, settings])
  const isTemporarilyReusedProfile = activeProfile.id !== currentActiveProfile.id
  const modelOptions = useMemo(() => (
    splitModelList(settings.profiles.find((profile) => profile.id === activeProfile.id)?.model ?? activeProfile.model)
      .map((model) => ({ label: model, value: model }))
  ), [activeProfile.id, activeProfile.model, settings.profiles])
  const handleModelChange = useCallback((model: string) => {
    // 临时复用其他配置时只切换本次复用的模型，不改动该配置记住的选择
    if (isTemporarilyReusedProfile) {
      setReusedTaskApiModel(model)
      return
    }
    setSettings({
      profiles: settings.profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, selectedModel: model } : profile),
    })
  }, [activeProfile.id, isTemporarilyReusedProfile, setReusedTaskApiModel, setSettings, settings.profiles])
  const activeAgentConversation = appMode === 'agent'
    ? agentConversations.find((conversation) => conversation.id === activeAgentConversationId) ?? null
    : null
  const activeAgentIsRunning = Boolean(activeAgentConversation?.rounds.some((round) => round.status === 'running'))
  const effectiveSettings = useMemo(() => (
    activeProfile.id === settingsActiveProfile.id
      ? settings
      : normalizeSettings({ ...settings, activeProfileId: activeProfile.id })
  ), [activeProfile.id, settingsActiveProfile.id, settings])
  const hasSubmitApiConfig = Boolean(activeProfile.apiKey)
  const sopMode = useSopStore((s) => s.sopMode)
  const variableMode = useSopStore((s) => s.variableMode)
  /** 普通模式：既不跑 SOP 也不跑变量，手写提示词直接出图 */
  const plainMode = !sopMode && !variableMode
  const plainImageMode = useStore((s) => s.plainImageMode)
  const fixedImages = useStore((s) => s.fixedImages)
  const variableImages = useStore((s) => s.variableImages)
  const addFixedImage = useStore((s) => s.addFixedImage)
  const removeFixedImage = useStore((s) => s.removeFixedImage)
  const clearFixedImages = useStore((s) => s.clearFixedImages)
  // 固定图在普通模式融图下有意义；变量模式图生图也用它（这时由三分区面板展示）
  const showFixedImages = plainMode && plainImageMode === 'merge'
  // 批量进行中不再锁提交：新提交会排到队尾，当前批结束后自动开始
  const batchRunning = Boolean(batchProgress)
  // SOP / 变量模式靠参考图与提示词驱动，输入框可以为空，发送按钮常亮（缺图时点一下会提示）
  const canSubmit = Boolean(
    (sopMode || variableMode || prompt.trim()) && hasSubmitApiConfig && !activeAgentIsRunning,
  )
  const batchEnabled = appMode === 'gallery' && settings.showBatchPrompt && settings.batchPromptEnabled
  // 批量进行中始终在画廊显示入口，以便查看进度和停止
  const showBatch = appMode === 'gallery' && (settings.showBatchPrompt || batchRunning)
  const batchPromptCount = useMemo(() => batchEnabled ? splitBatchPrompts(prompt).length : 0, [batchEnabled, prompt])
  const submitButtonAriaLabel = activeAgentIsRunning
    ? '停止生成'
    : hasSubmitApiConfig
    ? maskDraft ? '遮罩编辑' : batchEnabled ? `批量生成 ${batchPromptCount} 条` : '生成图像'
    : '请先配置 API'
  const submitTooltipText = activeAgentIsRunning
    ? '停止生成'
    : !hasSubmitApiConfig
    ? '尚未完成 API 配置，请在右上角设置中进行'
    : batchRunning || queuedSubmitCount > 0
    ? `批量进行中：提交会排队，当前批结束后自动开始${queuedSubmitCount > 0 ? `（已有 ${queuedSubmitCount} 个在排队）` : ''}`
    : '提交任务'
  const promptPlaceholder = variableMode
    ? '变量模式：可留空，拖入参考图后直接发送...'
    : sopMode
    ? 'SOP 模式：可留空，拖入参考图或直接靠卖点发送...'
    : batchEnabled
    ? '每条提示词之间空两行分隔，可输入 @ 来指定参考图...'
    : '描述你想生成的图片，可输入 @ 来指定参考图...'
  const setSopMode = useSopStore((s) => s.setSopMode)
  const setVariableMode = useSopStore((s) => s.setVariableMode)
  const sopProgress = useSopStore((s) => s.progress)
  const sopDirections = useSopStore((s) => s.directions)
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const sopPostTemplates = useSopStore((s) => s.postTemplates)
  const sopPresets = useSopStore((s) => s.presets)
  const savedSops = useSopStore((s) => s.savedSops)
  const sopLastPick = useSopStore((s) => s.lastPick)
  const sopDefaultPick = useSopStore((s) => s.defaultPick)
  const [sopSplitOpen, setSopSplitOpen] = useState(false)
  const [variableRunOpen, setVariableRunOpen] = useState(false)

  const currentDirection = sopDirections.find((node) => node.id === activeDirectionId)
  /**
   * 作用域链：自身 → 父 → 根。
   * 提示词/卖点/风格都按「最近一层配了就用那层」取，所以方向不必自己再配一遍；
   * 身份按层级判断，不依赖可能写错的 kind 字段。
   */
  const sopScopeIds = currentDirection ? scopeChain(sopDirections, currentDirection.id) : []
  /**
   * 提示词库入口用的归属 id。
   * 点「全部任务 / 未归属」时 activeDirectionId 被清空，这里给空串兜底，
   * 让三个入口照常渲染（选中的「上一次使用」按空 key 取不到，就显示未设置）。
   */
  const pickerDirectionId = currentDirection?.id ?? ''
  /**
   * 后处理模板可以是方向专属，也可以是产品通用；方向配了专属模板就只认它。
   * 当前方向实际能套上的模板都没有启用时，「后处理」开着也不会有变化，
   * 面板里给个提示但不禁用（用户可能先把它设成关）。
   */
  const postProcessAvailable = useMemo(() => {
    const list = resolvePostTemplates(sopPostTemplates, sopDirections, activeDirectionId).templates
    return list.some((item) => item.enabled)
  }, [sopDirections, activeDirectionId, sopPostTemplates])
  const pickedPoint = currentDirection
    ? resolvePickedPreset(sopPresets, currentDirection.id, sopScopeIds, 'point', sopLastPick, sopDefaultPick)
    : undefined
  const pickedStyle = currentDirection
    ? resolvePickedPreset(sopPresets, currentDirection.id, sopScopeIds, 'style', sopLastPick, sopDefaultPick)
    : undefined
  /** 当前方向选中的生图 SOP：有值就不反推，直接照它写提示词 */
  const pickedSop = currentDirection
    ? resolveSavedSop(savedSops, sopScopeIds, currentDirection.id, sopLastPick, sopDefaultPick)
    : undefined

  /** 只负责把任务卡推进后台队列，立即返回，不阻塞输入和其他操作 */
  const runSop = useCallback((options: SopRunOptions) => {
    setSopSplitOpen(false)
    // 三个板块合成一份再发：卖点排最前并写死优先级，避免被系统提示词里的文案盖掉
    const bundle = buildPromptBundle({
      systemPrompt: options.systemPromptText,
      point: pickedPoint?.content,
      style: pickedStyle?.content,
    })
    // 没有参考图时 splitEven 会返回一个空组：这一组只靠系统提示词与卖点反推文字版 SOP
    // 参考图不进生图接口，只按用户选的卡数均分，不限张数、也不再自动多分卡
    const groups = splitReferenceGroups(inputImages, options.groupCount)
    enqueueSopJobs(groups.map((group, index) => ({
      label: `第 ${index + 1}/${groups.length} 张卡`,
      imageDataUrls: group.map((img) => img.dataUrl),
      imageIds: group.map((img) => img.id),
      systemPromptText: bundle.merged,
      systemPromptName: options.systemPromptName,
      // 有存档 SOP 就直接用，任务里也就不再记系统提示词，避免详情页显示得对不上
      sopText: options.sopText,
      savedSopName: options.savedSopName,
      copyText: bundle.copyText,
      promptsPerGroup: options.promptsPerGroup,
      directionId: options.directionId,
      ignoreCompliance: options.ignoreCompliance,
      useImageSellingPoints: options.useImageSellingPoints,
      avoidCta: options.avoidCta,
    })))
  }, [inputImages, pickedPoint, pickedStyle])

  /** 变量模式：把任务卡推进后台队列，立即返回；参考图只用于提取策略，不参与生图 */
  const runVariable = useCallback((options: VariableRunOptions) => {
    setVariableRunOpen(false)
    // 三种图都算来源：只拖了固定图也要能跑（纯靠固定图 + 提示词出图），漏判会导致点确认后毫无反应
    if (!inputImages.length && !fixedImages.length && !variableImages.length) return
    // 参考图只用于提取策略、不进生图接口，按用户选的卡数均分，不限张数
    const referenceGroups = inputImages.length
      ? splitReferenceGroups(inputImages, options.groupCount)
      : [[]]
    enqueueVariableJobs(referenceGroups.map((group, index) => ({
      label: `第 ${index + 1}/${referenceGroups.length} 张卡`,
      imageDataUrls: group.map((img) => img.dataUrl),
      imageIds: group.map((img) => img.id),
      variablePromptText: options.variablePromptText,
      variablePromptName: options.variablePromptName,
      copyText: options.copyText,
      styleText: options.styleText,
      fillsPerCard: options.fillsPerCard,
      directionId: options.directionId,
      ignoreCompliance: options.ignoreCompliance,
      avoidCta: options.avoidCta,
      // 图生图：固定图每条都带、变量图逐条轮换；参考图不进生图接口
      fixedImages,
      variableImages,
      // 参考图为空 = 直出：不调模型提取策略，直接把变量提示词解析成骨架 + 可变项
      skipExtract: options.skipExtract,
    })))
  }, [inputImages, fixedImages, variableImages])

  const submitCurrentMode = useCallback(() => {
    if (appMode === 'agent') {
      void submitAgentMessage()
      return
    }
    if (variableMode) {
      // 参考图只用于提取策略，没有也可以；但固定图 / 变量图至少要有一种，否则就是纯文生图
      if (!inputImages.length && !fixedImages.length && !variableImages.length) {
        useStore.getState().showToast('变量模式需要先拖入参考图或图片', 'error')
        return
      }
      setVariableRunOpen(true)
      return
    }
    if (sopMode) {
      // 参考图可以没有：只靠系统提示词与卖点也能反推一份文字版 SOP
      setSopSplitOpen(true)
      return
    }
    // 普通模式：选中的卖点 / 风格拼在提示词前面一起发出去
    const presetPrefix = [
      pickedPoint?.content ? `卖点：${pickedPoint.content}` : '',
      pickedStyle?.content ? `风格：${pickedStyle.content}` : '',
    ].filter(Boolean).join('\n')
    void submitTask({ promptPrefix: presetPrefix })
  }, [appMode, sopMode, variableMode, inputImages.length, fixedImages.length, variableImages.length, pickedPoint, pickedStyle])
  const stopActiveAgentResponse = useCallback(() => {
    stopAgentResponse(activeAgentConversationId)
  }, [activeAgentConversationId])
  const syncPromptFromContentEditable = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    isUserInputRef.current = true
    const range = getContentEditableSelection(el)
    setCursorPos(range.start)
    syncMentionTagSelection(el)
    setPrompt(getContentEditablePlainText(el))
  }, [setPrompt])
  const activeProvider = activeProfile.provider
  const isFalProvider = activeProvider === 'fal'
  const agentAutoImageCount = appMode === 'agent'
  const moderationDisabled = isFalProvider
  const transparentOutputAvailable = appMode === 'gallery'
  const showTransparentOutputControl = transparentOutputAvailable && (params.output_format === 'png' || params.output_format === 'webp')
  const transparentOutputEnabled = transparentOutputAvailable && showTransparentOutputControl && params.transparent_output
  // 限制大小靠本地重压实现，PNG 无损压不下去，所以只在 JPEG / WebP 下可填
  const sizeLimitDisabled = params.output_format === 'png'
  /**
   * 普通模式带参考图时，「数量」是拆成几个请求，每个请求固定 n=1，
   * 所以不该用渠道的单请求上限（OpenAI 10 / fal 4）去卡它。
   * 纯文生图没有拆分，数量会原样发给渠道，仍然按渠道上限收。
   */
  const countsRequests = appMode === 'gallery'
    && plainMode
    && (inputImages.length > 0 || fixedImages.length > 0)
  const outputImageLimit = resolveOutputImageLimit(effectiveSettings, { countsRequests })
  const isFalTextToImage = isFalProvider && inputImages.length === 0
  const nDraftValue = Number(nInput)
  const effectiveNValue = Number.isNaN(nDraftValue) ? params.n : nDraftValue
  const streamConcurrentByN = activeProfile.provider === 'openai' && activeProfile.streamImages === true && !agentAutoImageCount && effectiveNValue > 1
  const nLimitHintText = agentAutoImageCount
    ? 'Agent 模式下数量由模型根据提示词自动决定'
    : countsRequests
    ? `普通模式的数量是请求次数，每个请求出 1 张，最多 ${outputImageLimit} 次`
    : isFalProvider
    ? `fal.ai 最大请求数量为 ${outputImageLimit}`
    : `OpenAI 最大请求数量为 ${outputImageLimit}`
  const displaySize = isFalTextToImage && params.size === 'auto'
    ? DEFAULT_FAL_IMAGE_SIZE
    : (activeProfile.codexCli ? normalizeCodexCliImageSize(params.size) : normalizeImageSize(params.size)) || DEFAULT_PARAMS.size

  // 这次出图会不会真套模板。只有不套模板时，才允许「渠道不支持的尺寸 → 放大生成再缩回来」，
  // 因为模板里的字号 / Logo 宽度是按成品像素写死的，先缩再套会错位。
  const postProcessOn = postProcessAvailable && params.post_process !== false
  // Codex CLI 只认 1K，放大反而会让提示词里的尺寸和实际出图对不上，所以不开放这条路径
  const allowSizeUpscale = !postProcessOn && !activeProfile.codexCli
  const sizePlan = useMemo(
    () => planGenerationSize(params.size, { postProcess: postProcessOn, allowResize: !activeProfile.codexCli }),
    [params.size, postProcessOn, activeProfile.codexCli],
  )
  const sizeScaleHint = sizePlan.scaled
    ? `渠道不支持 ${sizePlan.targetSize.replace('x', '×')}，实际按 ${sizePlan.requestSize.replace('x', '×')} 生成，出图后缩回`
    : ''

  const qualityOptions = [
    ...(!isFalProvider ? [{ label: 'auto', value: 'auto' }] : []),
    { label: 'low', value: 'low' },
    { label: 'medium', value: 'medium' },
    { label: 'high', value: 'high' },
    ...(isGptImage25Model(getImageGenerationModel(activeProfile))
      ? [
          { label: 'xhigh', value: 'xhigh' },
          { label: 'max', value: 'max' },
        ]
      : []),
  ]
  const imageLimit = useInputImageLimit()
  const atImageLimit = inputImages.length >= imageLimit
  const uploadImageTooltipText = atImageLimit ? `参考图数量已达上限（${imageLimit} 张），无法继续添加` : '添加图片'
  const transparentOutputHint = useHintTooltip()
  const handleTransparentOutputMenuOpenChange = useCallback((open: boolean) => {
    if (open) transparentOutputHint.hide()
  }, [transparentOutputHint.hide])
  const sizeLimitHint = useHintTooltip({ enabled: () => sizeLimitDisabled })
  const moderationHint = useHintTooltip({ enabled: () => moderationDisabled })
  const postProcessHint = useHintTooltip({ enabled: () => !postProcessAvailable })
  const sizeHint = useHintTooltip({ enabled: () => isFalTextToImage || activeProfile.codexCli || Boolean(sizeScaleHint) })
  const qualityHint = useHintTooltip({ enabled: () => activeProfile.codexCli || isFalProvider })
  const nLimitHint = useHintTooltip({ autoHideMs: 2000 })
  const streamConcurrentHint = useHintTooltip({ enabled: () => streamConcurrentByN })
  const maskTargetImage = maskDraft
    ? inputImages.find((img) => img.id === maskDraft.targetImageId) ?? null
    : null
  const referenceImages = maskTargetImage
    ? inputImages.filter((img) => img.id !== maskTargetImage.id)
    : inputImages
  const cursorPosition = cursorPos
  const visiblePrompt = stripImageMentionMarkers(prompt)
  const agentOutputImageOptions = useMemo<AtImageOption[]>(() => {
    if (!activeAgentConversation) return []
    return getActiveAgentRounds(activeAgentConversation).flatMap((round) =>
      collectAgentRoundOutputImageSlots(round, tasks).flatMap((imageId, imageIndex) => {
        if (!imageId) return []
        const label = `@第${round.index}轮图${imageIndex + 1}`
        return {
          type: 'agent-output' as const,
          key: `agent-output:${round.id}:${imageIndex}:${imageId}`,
          label,
          imageId,
          insertText: label,
        }
      }),
    )
  }, [activeAgentConversation, tasks])
  const atImageSourceCount = inputImages.length + agentOutputImageOptions.length
  const atImageQuery = isCursorInSelectedImageMention(prompt, cursorPosition)
    ? null
    : getAtImageQuery(visiblePrompt, cursorPosition, { length: atImageSourceCount })
  const atImageOptions = atImageQuery
    ? [
        ...inputImages
          .map((img, index) => ({
            type: 'input',
            key: `input:${img.id}:${index}`,
            label: getImageMentionLabel(index),
            imageId: img.id,
            dataUrl: img.dataUrl,
            imageIndex: index,
          } satisfies AtImageOption))
          .filter((option) => imageMentionMatches(atImageQuery.query, option.imageIndex)),
        ...agentOutputImageOptions.filter((option) => agentImageMentionMatches(atImageQuery.query, option.label)),
      ]
    : []
  const showAtImageMenu = !atImageMenuDismissed && atImageOptions.length > 0





  const selectAtImageOption = useCallback((option: AtImageOption) => {
    const el = textareaRef.current
    const cursor = el ? getContentEditableCursor(el) : prompt.length
    const query = getAtImageQuery(stripImageMentionMarkers(prompt), cursor, { length: atImageSourceCount })
    setAtImageMenuDismissed(true)
    setAtImageMenuIndex(0)
    if (!query) return

    const mentionText = option.type === 'input' ? getImageMentionLabel(option.imageIndex) : option.insertText
    const nextCursor = query.start + mentionText.length
    if (el) {
      el.focus()
      setContentEditableSelection(el, query.start, cursor)
      if (document.execCommand('insertHTML', false, getMentionTagHtml(mentionText))) {
        setContentEditableCursor(el, nextCursor)
        syncPromptFromContentEditable()
        return
      }
    }

    const next = option.type === 'input'
      ? insertImageMentionAtVisibleRange(prompt, query.start, cursor, option.imageIndex)
      : insertTextMentionAtVisibleRange(prompt, query.start, cursor, option.insertText)
    isUserInputRef.current = false
    setPrompt(next.prompt)
    window.setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        setContentEditableCursor(textareaRef.current, next.cursor)
      }
    }, 0)
  }, [atImageSourceCount, prompt, setPrompt, syncPromptFromContentEditable])



  const insertPromptTextAtSelection = useCallback((text: string) => {
    const el = textareaRef.current
    // 换行文本改用 state 渲染以避免 execCommand 插入 <br>/<div> 导致高度和换行异常
    if (el && !text.includes('\n')) {
      el.focus()
      if (document.execCommand('insertText', false, text)) {
        syncPromptFromContentEditable()
        return
      }
    }

    const selection = el ? getContentEditableSelection(el) : { start: prompt.length, end: prompt.length }
    const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start)
    const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end)
    const nextPrompt = `${prompt.slice(0, promptStart)}${text}${prompt.slice(promptEnd)}`
    const nextCursor = selection.start + text.length
    isUserInputRef.current = false
    setPrompt(nextPrompt)
    window.setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        setContentEditableCursor(textareaRef.current, nextCursor)
      }
    }, 0)
  }, [prompt, setPrompt, syncPromptFromContentEditable])

  const handleClearPrompt = useCallback(() => {
    isUserInputRef.current = false
    setPrompt('')
    if (textareaRef.current) {
      textareaRef.current.innerHTML = ''
      textareaRef.current.focus()
    }
  }, [setPrompt])

  useEffect(() => {
    setSizeLimitInput(
      params.max_file_kb == null ? '' : String(params.max_file_kb),
    )
  }, [params.max_file_kb])

  useEffect(() => {
    setNInput(agentAutoImageCount ? 'auto' : String(params.n))
  }, [agentAutoImageCount, params.n])

  useEffect(() => {
    // countsRequests 决定数量上限：普通模式带图时数量是请求次数，不能被渠道 n 上限压回 10
    const normalizedParams = normalizeParamsForSettings(params, effectiveSettings, {
      hasInputImages: inputImages.length > 0,
      countsRequests,
    })
    const patch = getChangedParams(params, normalizedParams)
    if (Object.keys(patch).length) {
      setParams(patch)
    }
  }, [countsRequests, inputImages.length, params, effectiveSettings, setParams])

  useEffect(() => () => {
    if (imageHintTimerRef.current != null) {
      window.clearTimeout(imageHintTimerRef.current)
    }
    imageHintReleaseRef.current?.()
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!maskDraft || !maskTargetImage) {
      setMaskPreviewUrl('')
      return
    }

    createMaskPreviewDataUrl(maskTargetImage.dataUrl, maskDraft.maskDataUrl)
      .then((url) => {
        if (!cancelled) setMaskPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewUrl('')
      })

    return () => {
      cancelled = true
    }
  }, [maskDraft, maskTargetImage?.id, maskTargetImage?.dataUrl])

  // 空 = 不限；填了就取整成 KB，0 和空同义
  const commitSizeLimit = useCallback(() => {
    const nextValue = parseSizeLimitKb(sizeLimitInput)
    setSizeLimitInput(nextValue == null ? '' : String(nextValue))
    if ((nextValue ?? null) !== (params.max_file_kb ?? null)) setParams({ max_file_kb: nextValue })
  }, [sizeLimitInput, params.max_file_kb, setParams])

  const commitN = useCallback(() => {
    nLimitHint.hide()
    if (agentAutoImageCount) {
      setNInput('auto')
      return
    }
    const nextValue = Number(nInput)
    const normalizedValue =
      nInput.trim() === '' ? DEFAULT_PARAMS.n : Number.isNaN(nextValue) ? params.n : nextValue
    const clampedValue = Math.min(outputImageLimit, Math.max(1, normalizedValue))
    setNInput(String(clampedValue))
    setParams({ n: clampedValue })
  }, [agentAutoImageCount, nInput, nLimitHint, outputImageLimit, params.n, setParams])

  const showNLimitHint = useCallback(() => {
    nLimitHint.show()
  }, [nLimitHint])

  const hideNLimitHint = useCallback(() => {
    nLimitHint.hide()
  }, [nLimitHint])

  const showAgentNHint = useCallback(() => {
    if (agentAutoImageCount) showNLimitHint()
  }, [agentAutoImageCount, showNLimitHint])

  const clearAgentNHintTouchTimer = useCallback(() => {
    nLimitHint.clearTimer()
  }, [nLimitHint])

  const startAgentNHintTouch = useCallback(() => {
    if (!agentAutoImageCount) return
    nLimitHint.startTouch()
  }, [agentAutoImageCount, nLimitHint])

  const handleNInputChange = useCallback((value: string) => {
    if (agentAutoImageCount) {
      setNInput('auto')
      return
    }
    setNInput(value)
    const nextValue = Number(value)
    if (!Number.isNaN(nextValue) && nextValue > outputImageLimit) {
      showNLimitHint()
    } else {
      hideNLimitHint()
    }
  }, [agentAutoImageCount, hideNLimitHint, outputImageLimit, showNLimitHint])

  const handleNLimitIncreaseAttempt = useCallback((preventDefault: () => void) => {
    if (agentAutoImageCount) {
      preventDefault()
      showNLimitHint()
      return
    }
    const currentValue = Number(nInput)
    const effectiveValue = Number.isNaN(currentValue) ? params.n : currentValue
    if (!nInputFocused || effectiveValue < outputImageLimit) return

    preventDefault()
    showNLimitHint()
  }, [agentAutoImageCount, nInput, nInputFocused, outputImageLimit, params.n, showNLimitHint])

  const clearImageHintTimer = () => {
    if (imageHintTimerRef.current != null) {
      window.clearTimeout(imageHintTimerRef.current)
      imageHintTimerRef.current = null
    }
  }

  const showImageHint = (id: string) => setImageHintId(id)

  const hideImageHint = () => {
    if (imageHintLockedRef.current) return
    setImageHintId(null)
    clearImageHintTimer()
  }

  const hideLockedImageHint = () => {
    imageHintLockedRef.current = false
    imageHintReleaseRef.current?.()
    imageHintReleaseRef.current = null
    setImageHintId(null)
    clearImageHintTimer()
  }

  const showImageHintUntilRelease = (id: string) => {
    if (imageHintLockedRef.current) {
      setImageHintId(id)
      return
    }
    imageHintLockedRef.current = true
    setImageHintId(id)
    const release = () => {
      window.removeEventListener('mouseup', release)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('dragend', release)
      if (imageHintReleaseRef.current === release) {
        imageHintReleaseRef.current = null
        imageHintLockedRef.current = false
        setImageHintId(null)
        clearImageHintTimer()
      }
    }
    imageHintReleaseRef.current = release
    window.addEventListener('mouseup', release)
    window.addEventListener('pointerup', release)
    window.addEventListener('dragend', release)
  }

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    /**
     * 拖进来几十张图时，逐张 await 会让每张都触发一次输入区全量重渲染，直接卡住。
     * 统一走批量入口：有限并发读取 + 只追加一次状态。
     */
    if (uploadingRef.current) {
      useStore.getState().showToast('正在导入上一批图片，请稍候', 'info')
      return
    }
    uploadingRef.current = true
    const startedAt = Date.now()
    try {
      const { added, discarded, overflow, failed } = await addImagesFromFiles(list, {
        limit: Number.isFinite(imageLimit) ? imageLimit : undefined,
      })
      // 大批量导入给一次结果反馈；单张小图不打扰
      if (list.length > 1 || failed > 0 || discarded > 0) {
        const consumed = Date.now() - startedAt
        const notes: string[] = [`已添加 ${added} 张图片`]
        // 拆开说：不是图片 vs 超过上限，否则用户会觉得「明明是图片却说不是」
        if (discarded > 0) notes.push(`${discarded} 张不是图片格式`)
        if (overflow > 0) notes.push(`${overflow} 张超过上限（最多 ${imageLimit} 张）`)
        if (failed > 0) notes.push(`${failed} 张读取失败`)
        useStore.getState().showToast(
          `${notes.join('，')}（${(consumed / 1000).toFixed(1)}s）`,
          added > 0 ? 'success' : 'info',
        )
      }
    } catch (err) {
      useStore.getState().showToast(
        `图片添加失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      uploadingRef.current = false
    }
  }

  const handleFilesRef = useRef(handleFiles)
  handleFilesRef.current = handleFiles

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFilesRef.current(e.target.files || [])
    e.target.value = ''
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 兼容某些输入法：用 Enter 确认候选字时会额外派发 Enter keydown，
    // 组字期间忽略该事件，避免重复插入或误触发提交/换行。
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || isComposingRef.current || e.nativeEvent.keyCode === 229)) {
      return
    }

    if (showAtImageMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtImageMenuIndex((idx) => (idx + 1) % atImageOptions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtImageMenuIndex((idx) => (idx - 1 + atImageOptions.length) % atImageOptions.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        selectAtImageOption(atImageOptions[atImageMenuIndex] ?? atImageOptions[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtImageMenuIndex(0)
        textareaRef.current?.blur()
        return
      }
    }

    // 阻止 contentEditable 默认换行
    if (e.key === 'Enter') {
      e.preventDefault()

      const isModifier = e.ctrlKey || e.metaKey

      if (settings.enterSubmit) {
        if (e.shiftKey) {
          insertPromptTextAtSelection('\n')
        } else if (!isModifier) {
          if (canSubmit) submitCurrentMode()
        }
      } else {
        if (isModifier) {
          if (canSubmit) submitCurrentMode()
        } else {
          insertPromptTextAtSelection('\n')
        }
      }
      return
    }
  }

  const handlePromptPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    if (Array.from(e.clipboardData.items).some((item) => item.type.startsWith('image/'))) return

    e.preventDefault()
    insertPromptTextAtSelection(text.replace(/\r\n?/g, '\n'))
  }

  const handlePromptCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = textareaRef.current
    if (!el) return

    const selection = getContentEditableSelection(el)
    if (selection.start === selection.end) return

    const promptStart = getPromptIndexFromVisibleIndex(prompt, selection.start)
    const promptEnd = getPromptIndexFromVisibleIndex(prompt, selection.end)
    const text = stripImageMentionMarkers(prompt.slice(promptStart, promptEnd))
    const copyText = /^\s*@图\d+\s*$/.test(text) ? text.trim() : text

    e.preventDefault()
    e.clipboardData.setData('text/plain', copyText)
  }

  // 粘贴图片
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: File[] = []
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        handleFilesRef.current(imageFiles)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  // 拖拽图片 - 监听整个页面
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        handleFilesRef.current(files)
        return
      }

      const transferredText = e.dataTransfer?.getData('text/plain')
      
      const imageIds = transferredText?.startsWith('agent-images:') 
        ? transferredText.slice('agent-images:'.length).split(',') 
        : transferredText?.startsWith('agent-image:')
        ? [transferredText.slice('agent-image:'.length)]
        : []

      if (imageIds.length > 0) {
        Promise.all(imageIds.map(async (imageId) => {
          const dataUrl = await ensureImageCached(imageId)
          if (!dataUrl) {
            showToast('部分图片已不存在', 'error')
            return
          }
          addInputImage({ id: imageId, dataUrl })
        })).then(() => {
          showToast('已上传图片', 'success')
        }).catch((err) => showToast(`上传图片失败：${err instanceof Error ? err.message : String(err)}`, 'error'))
      }
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [addInputImage, showToast])

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    // 计算图片区域等固定高度
    const imagesHeight = imagesRef.current?.offsetHeight ?? 0
    const fixedOverhead = imagesHeight + 140

    // 展开时填满卡片的剩余空间，普通状态最多占页面的 40%。
    const normalMaxH = Math.max(window.innerHeight * 0.4 - fixedOverhead, 80)
    const maxH = promptExpanded
      ? Math.max(el.parentElement?.clientHeight ?? 0, 80)
      : normalMaxH

    // 1. 清零高度以获取真实文本高度
    el.style.transition = 'none'
    el.style.height = '0'
    el.style.overflowY = 'hidden'
    const scrollH = el.scrollHeight

    const placeholderEl = el.parentElement?.querySelector('.prompt-placeholder')
    const placeholderH = placeholderEl ? placeholderEl.scrollHeight : 0
    const minH = Math.max(42, placeholderH)

    const desired = Math.max(scrollH, minH)
    const targetH = desired > maxH ? maxH : desired

    // 判断是否为单行
    setIsSingleLine(desired <= minH)
    setPromptCanExpand(desired > normalMaxH)

    // 2. 回设旧高度并重绘以准备触发动画
    el.style.height = prevHeightRef.current + 'px'
    void el.offsetHeight

    // 3. 恢复平滑过渡并设置新目标高度
    el.style.transition = 'height 150ms ease, border-color 200ms, box-shadow 200ms'
    el.style.height = targetH + 'px'
    el.style.overflowY = desired > maxH ? 'auto' : 'hidden'

    prevHeightRef.current = targetH
  }, [promptExpanded])

  // 同步 prompt 至 contentEditable
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // 输入时不重复渲染以防光标跳动
    if (isUserInputRef.current) {
      isUserInputRef.current = false
      return
    }
    const parts = getPromptMentionParts(prompt, inputImages)
    const html = prompt
      ? parts.map((part) =>
          part.type === 'mention'
            ? getMentionTagHtml(part.text, part.mentionText)
            : part.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        ).join('')
      : ''
    if (el.innerHTML !== html) {
      el.innerHTML = html
    }
  }, [prompt, inputImages])

  // 补 <br> 哨兵避免 pre-wrap 吃掉行尾 \n，同时不影响纯文本读取。
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const last = el.lastChild
    const hasSentinel = last instanceof HTMLBRElement && last.dataset.sentinelBr === 'true'
    const needSentinel = prompt.endsWith('\n')
    if (needSentinel && !hasSentinel) {
      const br = document.createElement('br')
      br.dataset.sentinelBr = 'true'
      el.appendChild(br)
    } else if (!needSentinel && hasSentinel) {
      last.remove()
    }
  }, [prompt, inputImages])

  useEffect(() => {
    adjustTextareaHeight()
  }, [prompt, inputImages, adjustTextareaHeight, isMobile, mobileCollapsed, promptExpanded])

  // 监听 selectionchange 更新光标位置（onSelect 在 contentEditable 下不可靠）
  useEffect(() => {
    const handleSelectionChange = () => {
      const el = textareaRef.current
      if (!el) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return

      const domRange = sel.getRangeAt(0)
      try {
        if (!domRange.intersectsNode(el)) {
          syncMentionTagSelection(el)
          return
        }
      } catch {
        return
      }

      const range = getContentEditableSelection(el)
      setCursorPos(range.start)
      // 记到 store 中，画板等弹窗关闭后可把评论胶囊插回这里，并覆盖选中的内容；
      // 只记录完全落在输入框内的选区，整页全选或拖选越界时不能当成要覆盖的范围
      if (el.contains(domRange.startContainer) && el.contains(domRange.endContainer)) {
        useStore.getState().setPromptSelection(range)
      }
      syncMentionTagSelection(el)

      const rangeRect = domRange.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      if (rangeRect.width === 0 && rangeRect.height === 0) return
      setMenuLeft(rangeRect.left - elRect.left)
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  // 输入栏卡片带 backdrop-blur，fixed 遮罩只能覆盖卡片内部，因此改为监听全局按下来关闭菜单，
  // 并吞掉随后的点击，避免关闭菜单时误触发外部按钮
  useEffect(() => {
    if (!showUploadMenu) return
    const closeMenu = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-add-image-menu]')) return
      suppressGlobalClicks()
      setShowUploadMenu(false)
    }
    window.addEventListener('mousedown', closeMenu, { capture: true })
    window.addEventListener('touchstart', closeMenu, { capture: true })
    return () => {
      window.removeEventListener('mousedown', closeMenu, { capture: true })
      window.removeEventListener('touchstart', closeMenu, { capture: true })
    }
  }, [showUploadMenu])

  // 点击外部时使 input 栏失焦
  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return

      if (document.activeElement instanceof HTMLElement) {
        // 若当前聚焦在输入栏内
        if (document.activeElement.closest('[data-input-bar]')) {
          // 若点击在输入栏外部
          if (!target.closest('[data-input-bar]')) {
            document.activeElement.blur()
          }
        }
      }
    }

    document.addEventListener('mousedown', handleGlobalMouseDown, true)
    return () => {
      document.removeEventListener('mousedown', handleGlobalMouseDown, true)
    }
  }, [])
  useEffect(() => {
    adjustTextareaHeight()
  }, [inputImages.length, Boolean(maskDraft), maskPreviewUrl, adjustTextareaHeight])

  useEffect(() => {
    window.addEventListener('resize', adjustTextareaHeight)
    return () => window.removeEventListener('resize', adjustTextareaHeight)
  }, [adjustTextareaHeight])

  // 移动端拖动条手势
  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    const onTouchStart = (e: TouchEvent) => {
      dragTouchRef.current = { startY: e.touches[0].clientY, moved: false }
    }
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - dragTouchRef.current.startY
      if (Math.abs(dy) > 10) dragTouchRef.current.moved = true
      if (dy > 30) setMobileCollapsed(true)
      if (dy < -30) setMobileCollapsed(false)
    }
    const onTouchEnd = () => {
      if (dragTouchRef.current.moved) {
        suppressHandleClickUntilRef.current = Date.now() + 500
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [])

  const selectClass = 'px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.07] dark:hover:bg-white/[0.1] text-xs transition-all duration-200'

  const getTouchDropIndex = (touch: React.Touch) => {
    const target = document
      .elementFromPoint(touch.clientX, touch.clientY)
      ?.closest<HTMLElement>('[data-input-image-index]')
    if (!target) return null
    const idx = Number(target.dataset.inputImageIndex)
    if (!Number.isInteger(idx)) return null
    const rect = getSafeBoundingClientRect(target)
    if (!rect) return null
    return touch.clientX < rect.left + rect.width / 2 ? idx : idx + 1
  }

  const normalizeImageDropIndex = (idx: number) => {
    const minIdx = maskTargetImage ? 1 : 0
    return Math.max(minIdx, Math.min(inputImages.length, idx))
  }

  const isBeforeMaskDropArea = (clientX: number) => {
    if (!maskTargetImage) return false
    const maskEl = document.querySelector<HTMLElement>('[data-input-image-index="0"]')
    if (!maskEl) return false
    const rect = getSafeBoundingClientRect(maskEl)
    if (!rect) return false
    return clientX < rect.left + rect.width / 2
  }

  const resetImageDrag = () => {
    setImageDragIndex(null)
    setImageDragOverIndex(null)
    imageDragIndexRef.current = null
    imageDragOverIndexRef.current = null
    imageTouchDragRef.current = { index: null, startX: 0, startY: 0, moved: false }
    setTouchDragPreview(null)
    imageDragPreviewRef.current?.remove()
    imageDragPreviewRef.current = null
    hideImageHint()
  }

  useEffect(() => {
    if (!touchDragPreview) return
    const previousOverflow = document.body.style.overflow
    const previousOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'
    return () => {
      document.body.style.overflow = previousOverflow
      document.body.style.overscrollBehavior = previousOverscroll
    }
  }, [touchDragPreview])

  const getDataTransferDragIndex = (e: React.DragEvent) => {
    const value = e.dataTransfer.getData('text/plain')
    const idx = Number(value)
    return Number.isInteger(idx) ? idx : null
  }

  const setImageDragTarget = (idx: number | null, clientX?: number) => {
    const fromIdx = imageDragIndexRef.current
    if (fromIdx !== null && maskTargetImage && (idx === 0 || (clientX != null && isBeforeMaskDropArea(clientX)))) {
      showImageHint(maskTargetImage.id)
      imageDragOverIndexRef.current = null
      setImageDragOverIndex(null)
      return
    }

    if (fromIdx !== null) hideImageHint()
    const normalizedIdx = idx == null ? null : normalizeImageDropIndex(idx)
    const isNoopTarget = fromIdx !== null && normalizedIdx !== null && (normalizedIdx === fromIdx || normalizedIdx === fromIdx + 1)
    const nextIdx = isNoopTarget ? null : normalizedIdx
    imageDragOverIndexRef.current = nextIdx
    setImageDragOverIndex(nextIdx)
  }

  const renderImageThumb = (img: (typeof inputImages)[number], idx: number) => {
    const isMaskTarget = maskDraft?.targetImageId === img.id
    const commentCount = getImageComments(prompt, idx).length
    const imageHintText = isMaskTarget ? '遮罩图必须为第一张图' : ''
    const displaySrc = isMaskTarget && maskPreviewUrl ? maskPreviewUrl : img.dataUrl
    const isImageDragging = imageDragIndex === idx
    const isLast = idx === inputImages.length - 1
    const showDropBefore = imageDragOverIndex === idx && imageDragIndex !== idx
    const showDropAfter = imageDragOverIndex === inputImages.length && isLast && imageDragIndex !== idx

    const handleDragStart = (e: React.DragEvent) => {
      if (isMaskTarget) {
        showImageHintUntilRelease(img.id)
        e.preventDefault()
        return
      }
      hideImageHint()
      imageDragIndexRef.current = idx
      setImageDragIndex(idx)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(idx))
      const preview = document.createElement('div')
      preview.style.cssText = 'position:fixed;left:-1000px;top:-1000px;width:52px;height:52px;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.25);'
      const previewImg = document.createElement('img')
      previewImg.src = displaySrc
      previewImg.style.cssText = 'width:52px;height:52px;object-fit:cover;display:block;'
      preview.appendChild(previewImg)
      document.body.appendChild(preview)
      imageDragPreviewRef.current = preview
      e.dataTransfer.setDragImage(preview, 26, 26)
    }

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const fromIdx = imageDragIndexRef.current
      if (fromIdx === null || fromIdx === idx) return
      const rect = getSafeBoundingClientRect(e.currentTarget)
      if (!rect) return
      setImageDragTarget(e.clientX < rect.left + rect.width / 2 ? idx : idx + 1, e.clientX)
    }

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault()
      const fromIdx = imageDragIndexRef.current ?? getDataTransferDragIndex(e)
      const toIdx = imageDragOverIndexRef.current
      if (fromIdx !== null && toIdx !== null) {
        moveInputImage(fromIdx, toIdx)
      }
      resetImageDrag()
    }

    const handleTouchStart = (e: React.TouchEvent) => {
      if (isMaskTarget) {
        const touch = e.touches[0]
        imageTouchDragRef.current = { index: idx, startX: touch.clientX, startY: touch.clientY, moved: false }
        return
      }
      const touch = e.touches[0]
      imageDragIndexRef.current = idx
      imageTouchDragRef.current = { index: idx, startX: touch.clientX, startY: touch.clientY, moved: false }
      setTouchDragPreview(null)
    }

    const handleTouchMove = (e: React.TouchEvent) => {
      const touch = e.touches[0]
      const touchDrag = imageTouchDragRef.current
      if (touchDrag.index === null) return

      if (isMaskTarget) {
        if (Math.abs(touch.clientX - touchDrag.startX) > 6 || Math.abs(touch.clientY - touchDrag.startY) > 6) {
          e.preventDefault()
          showImageHintUntilRelease(img.id)
        }
        return
      }

      touchDrag.moved = true
      clearImageHintTimer()
      setImageHintId(null)
      suppressImageClickRef.current = true
      e.preventDefault()
      setImageDragIndex(touchDrag.index)
      setTouchDragPreview({ src: displaySrc, x: touch.clientX, y: touch.clientY })
      const dropIndex = getTouchDropIndex(touch)
      setImageDragTarget(dropIndex, touch.clientX)
    }

    const handleTouchEnd = (e: React.TouchEvent) => {
      const touchDrag = imageTouchDragRef.current
      clearImageHintTimer()
      if (touchDrag.index !== null && imageDragOverIndexRef.current !== null) {
        e.preventDefault()
        moveInputImage(touchDrag.index, imageDragOverIndexRef.current)
        window.setTimeout(() => {
          suppressImageClickRef.current = false
        }, 0)
      }
      resetImageDrag()
      hideLockedImageHint()
    }

    const handleTouchCancel = () => {
      suppressImageClickRef.current = false
      hideLockedImageHint()
      resetImageDrag()
    }

    return (
      <div
        key={img.id}
        data-input-image-index={idx}
        className={`relative group inline-block h-[52px] w-[52px] shrink-0 self-start transition-opacity ${isImageDragging ? 'opacity-40' : ''}`}
        style={{ touchAction: isMaskTarget ? 'auto' : 'none' }}
        draggable={!isMobile}
        onMouseLeave={hideImageHint}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragEnd={resetImageDrag}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          const el = textareaRef.current
          // 按输入框最后的选区插入，选中了其他内容（包括胶囊）时直接覆盖
          const visibleLength = stripImageMentionMarkers(prompt).length
          const recorded = useStore.getState().promptSelection
          const selection = recorded?.prompt === prompt ? recorded : { start: visibleLength, end: visibleLength }
          if (el) {
            el.focus()
            setContentEditableSelection(el, selection.start, selection.end)
            if (document.execCommand('insertHTML', false, getMentionTagHtml(getImageMentionLabel(idx)))) {
              syncPromptFromContentEditable()
              return
            }
          }
          const next = insertImageMentionAtVisibleRange(prompt, selection.start, selection.end, idx)
          isUserInputRef.current = false
          setPrompt(next.prompt)
          window.setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus()
              setContentEditableCursor(textareaRef.current, next.cursor)
            }
          }, 0)
        }}
      >
        <ButtonTooltip
          visible={imageHintId === img.id && Boolean(imageHintText) && (!isMobile || isMaskTarget)}
          text={imageHintText}
        />
        {showDropBefore && (
          <div className="absolute -left-[5px] top-0 bottom-0 w-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        {showDropAfter && (
          <div className="absolute -right-[5px] top-0 bottom-0 w-[2px] bg-blue-500 rounded-full z-40 shadow-sm pointer-events-none" />
        )}
        <div
          className={`relative w-[52px] h-[52px] rounded-xl overflow-hidden shadow-sm cursor-grab active:cursor-grabbing select-none ${
            isMaskTarget || commentCount > 0
              ? 'border-2 border-blue-500'
              : 'border border-gray-200 dark:border-white/[0.08]'
          }`}
          onClick={() => {
            if (suppressImageClickRef.current) return
            setLightboxImageId(img.id, inputImages.map((i) => i.id), prompt)
          }}
        >
          {displaySrc && (
            <div className="h-full w-full overflow-hidden">
              <InputThumbImage
                imageId={img.id}
                fallbackSrc={displaySrc}
                className="w-full h-full object-cover hover:opacity-90 transition-opacity pointer-events-none"
              />
            </div>
          )}
          {isMaskTarget && (
            <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
              MASK
            </span>
          )}
          {commentCount > 0 && <CommentBadge count={commentCount} className={isMaskTarget ? 'left-1 top-[18px]' : 'left-1 top-1'} />}
          <span className="absolute bottom-1 left-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/55 text-[9px] font-semibold text-white backdrop-blur-sm z-10 pointer-events-none">
            {idx + 1}
          </span>
          <button
            className="absolute inset-0 w-full h-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer z-20 focus:outline-none border-none"
            onClick={(e) => {
              e.stopPropagation()
              setLightboxImageId(img.id, inputImages.map((i) => i.id), prompt)
            }}
            title="查看"
            aria-label="查看参考图"
          >
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.25 12s3.5-6 9.75-6 9.75 6 9.75 6-3.5 6-9.75 6S2.25 12 2.25 12z" />
              <circle cx="12" cy="12" r="2.75" strokeWidth={2} />
            </svg>
          </button>
        </div>
        {!isMaskTarget && (
          <span
            className="absolute right-0 top-0 flex h-5 w-5 translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-red-500 text-white opacity-0 shadow-md transition-opacity hover:bg-red-600 group-hover:opacity-100 z-30"
            onClick={(e) => {
              e.stopPropagation()
              removeInputImage(idx)
            }}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </span>
        )}
      </div>
    )
  }

  // 桌面端与移动端共用的“添加图片”按钮与菜单，移动端额外提供拍照
  const renderAddImageButton = (mobile: boolean) => (
    <div
      data-add-image-menu
      className="relative flex-shrink-0"
      onMouseEnter={() => setAttachHover(true)}
      onMouseLeave={() => setAttachHover(false)}
    >
      {!mobile && <ButtonTooltip visible={attachHover && !showUploadMenu} text={uploadImageTooltipText} />}
      <button
        onClick={() => {
          if (atImageLimit) return
          setAttachHover(false)
          setShowUploadMenu(!showUploadMenu)
        }}
        className={`p-2.5 rounded-xl transition-all shadow-sm ${
          atImageLimit
            ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
            : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 hover:shadow'
        }`}
        aria-label={uploadImageTooltipText}
        aria-expanded={showUploadMenu}
      >
        <svg
          className={`w-5 h-5 transition-transform duration-200 ${showUploadMenu ? 'rotate-45' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {showUploadMenu && (
        <div className={`absolute bottom-full ${mobile ? 'left-0' : 'right-0'} mb-2 w-32 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-100 dark:border-gray-700 overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-2 duration-200`}>
          {mobile && (
            <button
              className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
              onClick={() => {
                setShowUploadMenu(false)
                cameraInputRef.current?.click()
              }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              拍照
            </button>
          )}
          <button
            className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
            onClick={() => {
              setShowUploadMenu(false)
              fileInputRef.current?.click()
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            上传图片
          </button>
          <button
            className="w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
            onClick={() => {
              setShowUploadMenu(false)
              setSketchBoard({ baseImageSrc: null })
            }}
          >
            <SketchIcon className="w-4 h-4" />
            画板
          </button>
        </div>
      )}
    </div>
  )

  const renderClearAllButton = () => (
    <button
      onClick={() =>
        setConfirmDialog({
          title: maskTargetImage ? '清空全部输入图' : '清空参考图',
          message: maskTargetImage
            ? `确定要清空遮罩主图、${referenceImages.length} 张参考图和当前遮罩吗？`
            : `确定要清空全部 ${inputImages.length} 张参考图吗？`,
          action: () => clearInputImages(),
        })
      }
      className="w-[52px] h-[52px] rounded-xl border border-dashed border-gray-300 dark:border-white/[0.08] flex flex-col items-center justify-center gap-0.5 text-gray-400 dark:text-gray-500 hover:text-red-600 hover:border-red-300 hover:bg-red-500/[0.1] dark:hover:bg-red-500/[0.16] transition-all cursor-pointer flex-shrink-0"
      title={maskTargetImage ? '清空遮罩主图、参考图和遮罩' : '清空全部参考图'}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      <span className="text-[8px] leading-none">{maskTargetImage ? '清空全部' : '清空'}</span>
    </button>
  )

  const renderImageThumbs = () => {
    return (
      <div ref={imagesRef} className="sm:[contain:inline-size]">
        <div className="grid grid-cols-[repeat(auto-fill,52px)] justify-between gap-x-2 gap-y-3 mb-3">
          {inputImages.map((img, idx) => renderImageThumb(img, idx))}
          {renderClearAllButton()}
        </div>
        {touchDragPreview?.src && createPortal(
          <div
            className="fixed z-[140] h-[52px] w-[52px] overflow-hidden rounded-xl shadow-xl pointer-events-none opacity-90"
            style={{ left: touchDragPreview.x, top: touchDragPreview.y, transform: 'translate(-50%, -50%)' }}
          >
            <img src={touchDragPreview.src} className="h-full w-full object-cover" alt="" />
          </div>,
          document.body,
        )}
      </div>
    )
  }

  /**
   * 固定图：普通模式 + 融图时才有意义，融图拆分组时每个请求都会带上这几张。
   * 批量模式下所有图都是变量图，这个区不显示。
   */
  const renderFixedImages = () => {
    if (!showFixedImages) return null
    return (
      <div className="mb-3">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
          <span className="font-medium text-gray-500 dark:text-gray-400">固定图</span>
          <span>融图时每个请求都会带上</span>
          {fixedImages.length > 0 && (
            <button type="button" onClick={clearFixedImages} className="ml-auto text-gray-400 hover:text-red-500">
              清空
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {fixedImages.map((img, idx) => (
            <div
              key={img.id}
              className="group relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-xl border border-gray-200 dark:border-white/10"
            >
              <img src={img.dataUrl} alt={`固定图 ${idx + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removeFixedImage(idx)}
                title="移除"
                className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-[10px] leading-none text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
          <label
            className="flex h-[52px] w-[52px] shrink-0 cursor-pointer items-center justify-center rounded-xl border border-dashed border-gray-300 text-gray-400 transition-colors hover:border-blue-300 hover:text-blue-500 dark:border-white/[0.12] dark:text-gray-500"
            title="添加固定图"
          >
            <span className="text-lg leading-none">+</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                e.target.value = ''
                for (const file of files) {
                  void createInputImageFromFile(file).then((image) => {
                    if (image) addFixedImage(image)
                  })
                }
              }}
            />
          </label>
        </div>
      </div>
    )
  }

  const renderParams = () => (
    <InputParamsPanel
      params={params}
      setParams={setParams}
      activeProfile={activeProfile}
      modelOptions={modelOptions}
      onModelChange={handleModelChange}
      isFalProvider={isFalProvider}
      isFalTextToImage={isFalTextToImage}
      displaySize={displaySize}
      qualityOptions={qualityOptions}
      selectClass={selectClass}
      transparentOutputAvailable={transparentOutputAvailable}
      showTransparentOutputControl={showTransparentOutputControl}
      transparentOutputEnabled={transparentOutputEnabled}
      transparentOutputHint={transparentOutputHint}
      onTransparentOutputMenuOpenChange={handleTransparentOutputMenuOpenChange}
      sizeLimitHint={sizeLimitHint}
      sizeLimitDisabled={sizeLimitDisabled}
      sizeLimitInput={sizeLimitInput}
      setSizeLimitInput={setSizeLimitInput}
      commitSizeLimit={commitSizeLimit}
      moderationHint={moderationHint}
      moderationDisabled={moderationDisabled}
      postProcessEnabled={params.post_process !== false}
      postProcessAvailable={postProcessAvailable}
      postProcessHint={postProcessHint}
      agentAutoImageCount={agentAutoImageCount}
      hideCount={sopMode || variableMode}
      outputImageLimit={outputImageLimit}
      nInput={nInput}
      setNInputFocused={setNInputFocused}
      commitN={commitN}
      handleNInputChange={handleNInputChange}
      handleNLimitIncreaseAttempt={handleNLimitIncreaseAttempt}
      showAgentNHint={showAgentNHint}
      hideNLimitHint={hideNLimitHint}
      startAgentNHintTouch={startAgentNHintTouch}
      clearAgentNHintTouchTimer={clearAgentNHintTouchTimer}
      nLimitHint={nLimitHint}
      nLimitHintText={nLimitHintText}
      streamConcurrentByN={streamConcurrentByN}
      streamConcurrentHint={streamConcurrentHint}
      sizeHint={sizeHint}
      sizeScaleHint={sizeScaleHint}
      qualityHint={qualityHint}
      onOpenSizePicker={() => setShowSizePicker(true)}
      showBatch={showBatch}
      batchEnabled={batchEnabled}
      batchMode={settings.batchPromptMode}
      batchConcurrencyLimited={settings.batchPromptConcurrencyLimited}
      batchConcurrency={settings.batchPromptConcurrency}
      batchPromptCount={batchPromptCount}
      batchProgress={batchProgress}
      queuedSubmitCount={queuedSubmitCount}
      onBatchChange={setSettings}
      onStopBatch={stopBatchPrompts}
    />
  )

  const showFavoriteCollectionBatchBar = inCollectionOverview && selectedFavoriteCollectionIds.length > 0
  const showTaskBatchBar = !showFavoriteCollectionBatchBar && selectedTaskIds.length > 0

  return (
    <>
      <DragUploadOverlay visible={isDragging} atImageLimit={atImageLimit} maxImages={imageLimit} />

      {showSizePicker && (
        <SizePickerModal
          currentSize={isFalTextToImage && params.size === 'auto' ? DEFAULT_FAL_IMAGE_SIZE : params.size}
          onSelect={(size) => setParams({ size })}
          onClose={() => setShowSizePicker(false)}
          allowAuto={!isFalTextToImage}
          codexCli={activeProfile.codexCli}
          allowUpscale={allowSizeUpscale}
        />
      )}

      <div
        data-input-bar
        className={`fixed bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-30 w-full max-w-4xl sm:w-max sm:min-w-[min(56rem,100%)] sm:max-w-[min(80rem,100%)] px-3 sm:px-4 transition-all duration-300${promptExpanded ? ' flex flex-col' : ''}`}
        style={promptExpanded ? { top: `${promptExpandedTop}px`, transitionProperty: 'none' } : undefined}
      >
        {/* 桌面端输入栏宽度只由参数栏内容决定（最宽与任务卡片区域对齐），其余区域用 contain 排除在宽度计算之外 */}
        <div className="sm:[contain:inline-size]">
          <InputBatchBars
            showFavoriteCollectionBatchBar={showFavoriteCollectionBatchBar}
            showTaskBatchBar={showTaskBatchBar}
            selectedTaskIds={selectedTaskIds}
            tasks={tasks}
            clearFavoriteCollectionSelection={clearFavoriteCollectionSelection}
            onSelectAllVisibleFavoriteCollections={handleSelectAllVisibleFavoriteCollections}
            onInvertVisibleFavoriteCollections={handleInvertVisibleFavoriteCollections}
            onDownloadSelectedFavoriteCollections={handleDownloadSelectedFavoriteCollections}
            onDeleteSelectedFavoriteCollections={handleDeleteSelectedFavoriteCollections}
            clearSelection={clearSelection}
            onSelectAllVisibleTasks={handleSelectAllVisibleTasks}
            onInvertVisibleTasks={handleInvertVisibleTasks}
            onToggleFavorite={handleToggleFavorite}
            onAssignDirection={handleAssignDirection}
            onDownloadSelected={handleDownloadSelected}
            onDeleteSelected={handleDeleteSelected}
          />
        </div>
        <div ref={cardRef} className={`relative bg-white/70 dark:bg-gray-900/70 backdrop-blur-2xl border border-white/50 dark:border-white/[0.08] shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] rounded-2xl sm:rounded-3xl p-3 sm:p-4 ring-1 ring-black/5 dark:ring-white/10${promptExpanded ? ' flex min-h-0 flex-1 flex-col' : ''}`}>
          {/* 移动端拖动条 */}
          <div
            ref={handleRef}
            className={promptExpanded ? 'hidden' : 'sm:hidden flex justify-center pt-0.5 pb-2 -mt-1 cursor-pointer touch-none'}
            onClick={() => {
              if (Date.now() < suppressHandleClickUntilRef.current) {
                suppressHandleClickUntilRef.current = 0
                return
              }
              setMobileCollapsed((v) => !v)
            }}
          >
            <div className={`w-10 h-1 rounded-full bg-gray-300 dark:bg-white/[0.06] transition-transform duration-200 ${mobileCollapsed ? 'scale-x-75' : ''}`} />
          </div>

          {/* 变量模式：参考图 / 固定图 / 变量图三个独立入口，各自拖入互不串 */}
          {variableMode && (
            <VariableImageSlots referenceLimit={imageLimit} requestLimit={MAX_INPUT_IMAGES} />
          )}

          {/* 输入图片行（移动端可折叠） */}
          {!variableMode && inputImages.length > 0 && (
            isMobile ? (
              <>
                <div className={`collapse-section${mobileCollapsed ? ' collapsed' : ''}`}>
                  <div className="collapse-inner">
                    {renderImageThumbs()}
                  </div>
                </div>
                {mobileCollapsed && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mb-2 ml-1">
                    {maskDraft ? `1 张遮罩主图 · ${referenceImages.length} 张参考图` : `${inputImages.length} 张参考图`}
                  </div>
                )}
              </>
            ) : (
              renderImageThumbs()
            )
          )}
          {renderFixedImages()}

          {/* 三个入口不跟业务归属绑定：点「全部任务 / 未归属」时 activeDirectionId 是空的，
              仍然要能看到并打开提示词库（库里会提示先选方向）。归属为空时作用域链为空，
              picker 自己会显示「未设置」。 */}
          {sopMode && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {/* 选了库里的 SOP 就直接拿它出图，系统提示词不参与，也就不再显示 */}
              <SopLibraryPicker scopeIds={sopScopeIds} directionId={pickerDirectionId} />
              {!pickedSop && (
                <SopSystemPromptPicker scopeIds={sopScopeIds} directionId={pickerDirectionId} />
              )}
              <SopPresetPicker kind="point" label="卖点" directionId={pickerDirectionId} scopeIds={sopScopeIds} />
              <SopPresetPicker kind="style" label="风格" directionId={pickerDirectionId} scopeIds={sopScopeIds} />
            </div>
          )}
          {/* 变量模式：变量提示词与系统提示词并行，卖点/风格两个模式通用 */}
          {variableMode && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <VariablePromptPicker scopeIds={sopScopeIds} directionId={pickerDirectionId} />
              <SopPresetPicker kind="point" label="卖点" directionId={pickerDirectionId} scopeIds={sopScopeIds} />
              <SopPresetPicker kind="style" label="风格" directionId={pickerDirectionId} scopeIds={sopScopeIds} />
            </div>
          )}
          {/* 普通模式：卖点 / 风格保留，系统提示词的位置换成「融图 / 批量」切换。
              模式切换不依赖业务归属，没选方向也能先定发图方式。 */}
          {plainMode && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <PlainImageModeSwitch />
              <SopPresetPicker kind="point" label="卖点" directionId={pickerDirectionId} scopeIds={sopScopeIds} />
              <SopPresetPicker kind="style" label="风格" directionId={pickerDirectionId} scopeIds={sopScopeIds} />
            </div>
          )}

          {/* 输入框 */}
          <div className={`relative grid sm:[contain:inline-size]${promptExpanded ? ' min-h-0 flex-1' : ''}`}>
            {showAtImageMenu && (
              <div style={{ left: `${menuLeft}px` }} className="absolute bottom-full z-50 mb-2 w-64 overflow-hidden rounded-2xl border border-transparent bg-white/95 p-1.5 shadow-xl ring-1 ring-black/5 backdrop-blur-xl dark:bg-gray-800/95 dark:ring-white/[0.06]">
                <div className="px-2 pb-1 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500">选择图片引用</div>
                <div className="max-h-56 overflow-y-auto custom-scrollbar">
                  {atImageOptions.map((option, optionIndex) => (
                    <button
                      key={option.key}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        selectAtImageOption(option)
                      }}
                      onMouseEnter={() => setAtImageMenuIndex(optionIndex)}
                      className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors ${
                        optionIndex === atImageMenuIndex
                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                          : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                        }`}
                    >
                      <AtImageOptionThumb option={option} />
                      <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
                      {option.type === 'agent-output' && <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">历史</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div
              ref={textareaRef}
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => {
                isUserInputRef.current = true
                const el = e.currentTarget
                const range = getContentEditableSelection(el)
                setCursorPos(range.start)
                syncMentionTagSelection(el)
                const text = getContentEditablePlainText(el)
                setPrompt(text)
                setAtImageMenuIndex(0)
                setAtImageMenuDismissed(false)
              }}
              onSelect={(e) => {
                const el = e.currentTarget
                const range = getContentEditableSelection(el)
                setCursorPos(range.start)
                syncMentionTagSelection(el)
                setAtImageMenuIndex(0)
                setAtImageMenuDismissed(false)
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false
              }}
              onPaste={handlePromptPaste}
              onCopy={handlePromptCopy}
              onClick={(e) => {
                const el = textareaRef.current
                if (!el) return
                const target = e.target as HTMLElement
                if (target.classList.contains('mention-tag')) {
                  const sel = window.getSelection()
                  if (sel) {
                    const range = document.createRange()
                    range.selectNode(target)
                    sel.removeAllRanges()
                    sel.addRange(range)
                    syncMentionTagSelection(el)
                  }
                  return
                }

                syncMentionTagSelection(el)
              }}
              aria-label={promptPlaceholder}
              className={`col-start-1 row-start-1 min-h-[42px] w-full overflow-hidden ios-rounded-scroll-fix whitespace-pre-wrap break-words rounded-2xl border border-gray-200/60 bg-white/50 pl-4 pr-10 py-3 text-sm leading-relaxed shadow-sm outline-none transition-[border-color,box-shadow] duration-200 focus:ring-1 focus:ring-blue-300/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100 dark:focus:ring-blue-500/30${promptExpanded ? ' !h-full !overflow-y-auto' : ''}`}
            />
            {prompt.length === 0 && (
              <div className={`prompt-placeholder col-start-1 row-start-1 pointer-events-none pl-4 pr-10 py-3 text-sm leading-relaxed text-gray-400 dark:text-gray-500${
                isMobile && mobileCollapsed ? ' truncate' : ''
              }`}>
                {promptPlaceholder}
              </div>
            )}
            {prompt.length > 0 && (
              <div
                className={`absolute z-10 ${
                  isSingleLine ? 'right-3 top-1/2 -translate-y-1/2' : 'right-3 top-3'
                }`}
                onMouseEnter={() => setClearPromptHover(true)}
                onMouseLeave={() => setClearPromptHover(false)}
              >
                <ButtonTooltip visible={clearPromptHover} text="清空文本" />
                <button
                  type="button"
                  onClick={() => {
                    setClearPromptHover(false)
                    handleClearPrompt()
                  }}
                  className="flex items-center justify-center rounded-full p-1 text-gray-400 transition-all duration-200 hover:bg-gray-100 hover:text-gray-600 focus:outline-none dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                  aria-label="清空文本"
                >
                  <CloseIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {showPromptExpand && (
              <div
                className="absolute bottom-2.5 right-2.5 z-10"
                onMouseEnter={() => setExpandPromptHover(true)}
                onMouseLeave={() => setExpandPromptHover(false)}
              >
                <ButtonTooltip visible={expandPromptHover} text={promptExpanded ? '恢复输入框' : '展开输入框'} />
                <button
                  type="button"
                  onClick={() => {
                    setExpandPromptHover(false)
                    setPromptExpanded((expanded) => !expanded)
                    setMobileCollapsed(false)
                  }}
                  className="flex items-center justify-center rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                  aria-label={promptExpanded ? '恢复输入框' : '展开输入框'}
                  aria-pressed={promptExpanded}
                >
                  {promptExpanded ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
                </button>
              </div>
            )}
          </div>

          {/* 参数 + 按钮 */}
          <div className="mt-3">
            {sopSplitOpen && createPortal(
              <SopSplitModal
                imageCount={inputImages.length}
                onClose={() => setSopSplitOpen(false)}
                onConfirm={(options) => void runSop(options)}
              />,
              document.body,
            )}
            {variableRunOpen && createPortal(
              <VariableRunModal
                imageCount={inputImages.length}
                fixedCount={fixedImages.length}
                variableCount={variableImages.length}
                onClose={() => setVariableRunOpen(false)}
                onConfirm={(options) => void runVariable(options)}
              />,
              document.body,
            )}
            {assignOpen && createPortal(
              <AssignDirectionModal
                count={selectedTaskIds.length}
                onClose={() => setAssignOpen(false)}
                onConfirm={handleConfirmAssign}
              />,
              document.body,
            )}
            {/* 桌面端布局 */}
            <div className="hidden sm:flex items-center justify-between gap-3">
              {renderParams()}

              <div className="flex gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setSopMode(!sopMode)}
                  title="SOP 生图模式：拖入参考图 → 反推 SOP → 批量写提示词出图"
                  className={`h-10 px-3 rounded-xl text-xs font-medium transition-all shadow-sm ${
                    sopMode
                      ? 'bg-blue-500 text-white hover:bg-blue-600'
                      : 'bg-gray-200 dark:bg-white/[0.06] text-gray-500 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  {sopProgress ? `${sopProgress.done}/${sopProgress.total}` : 'SOP'}
                </button>
                <button
                  type="button"
                  onClick={() => setVariableMode(!variableMode)}
                  title="变量模式：拖入参考图 → 提取「骨架 + 变量」→ 最远点采样选组合填词出图"
                  className={`h-10 px-3 rounded-xl text-xs font-medium transition-all shadow-sm ${
                    variableMode
                      ? 'bg-violet-500 text-white hover:bg-violet-600'
                      : 'bg-gray-200 dark:bg-white/[0.06] text-gray-500 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  {sopProgress && variableMode ? `${sopProgress.done}/${sopProgress.total}` : '变量'}
                </button>
                {renderAddImageButton(false)}
                <div
                  className="relative"
                  onMouseEnter={() => setSubmitHover(true)}
                  onMouseLeave={() => setSubmitHover(false)}
                >
                  <ButtonTooltip visible={(activeAgentIsRunning || !hasSubmitApiConfig || batchRunning || queuedSubmitCount > 0) && submitHover} text={submitTooltipText} />
                  <button
                    onClick={() => activeAgentIsRunning ? stopActiveAgentResponse() : hasSubmitApiConfig ? submitCurrentMode() : setShowSettings(true)}
                    disabled={activeAgentIsRunning ? false : hasSubmitApiConfig ? !canSubmit : false}
                    className={`p-2.5 rounded-xl transition-all shadow-sm hover:shadow ${
                      activeAgentIsRunning
                        ? 'bg-red-500 text-white hover:bg-red-600'
                        : !hasSubmitApiConfig
                        ? 'bg-gray-300 dark:bg-white/[0.06] text-white cursor-pointer'
                        : 'bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed'
                    }`}
                    aria-label={submitButtonAriaLabel}
                  >
                    {activeAgentIsRunning ? (
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="7" y="7" width="10" height="10" rx="1.5" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* 移动端布局 */}
            <div className="sm:hidden flex flex-col gap-2">
              <div className={`collapse-section${mobileCollapsed ? ' collapsed' : ''}`}>
                <div className="collapse-inner">
                  {renderParams()}
                  <div className="h-2" />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSopMode(!sopMode)}
                  className={`h-10 px-3 rounded-xl text-xs font-medium transition-all ${
                    sopMode
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 dark:bg-white/[0.06] text-gray-500 dark:text-gray-300'
                  }`}
                >
                  {sopProgress ? `${sopProgress.done}/${sopProgress.total}` : 'SOP'}
                </button>
                <button
                  type="button"
                  onClick={() => setVariableMode(!variableMode)}
                  className={`h-10 px-3 rounded-xl text-xs font-medium transition-all ${
                    variableMode
                      ? 'bg-violet-500 text-white'
                      : 'bg-gray-200 dark:bg-white/[0.06] text-gray-500 dark:text-gray-300'
                  }`}
                >
                  {sopProgress && variableMode ? `${sopProgress.done}/${sopProgress.total}` : '变量'}
                </button>
                {renderAddImageButton(true)}
                <div
                  className="relative flex-1"
                  onMouseEnter={() => setSubmitHover(true)}
                  onMouseLeave={() => setSubmitHover(false)}
                >
                  <ButtonTooltip visible={(activeAgentIsRunning || !hasSubmitApiConfig || batchRunning || queuedSubmitCount > 0) && submitHover} text={submitTooltipText} />
                  <button
                    onClick={() => activeAgentIsRunning ? stopActiveAgentResponse() : hasSubmitApiConfig ? submitCurrentMode() : setShowSettings(true)}
                    disabled={activeAgentIsRunning ? false : hasSubmitApiConfig ? !canSubmit : false}
                    aria-label={submitButtonAriaLabel}
                    className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all shadow-sm ${
                      activeAgentIsRunning
                        ? 'bg-red-500 text-white hover:bg-red-600'
                        : !hasSubmitApiConfig
                        ? 'bg-gray-300 dark:bg-white/[0.06] text-white cursor-pointer'
                        : 'bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed'
                    }`}
                  >
                    {activeAgentIsRunning ? (
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="7" y="7" width="10" height="10" rx="1.5" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    )}
                    {activeAgentIsRunning ? '停止生成' : maskDraft ? '遮罩编辑' : batchEnabled ? `批量生成 ${batchPromptCount} 条` : '生成图像'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileUpload}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileUpload}
          />
        </div>
      </div>
    </>
  )
}
