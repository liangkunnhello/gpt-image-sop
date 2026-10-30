import type { ReactNode } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  AgentConversation,
  AgentInputDraft,
  AgentMessage,
  AgentRound,
  ApiMode,
  ApiProfile,
  AppSettings,
  BatchProgress,
  PresetConfig,
  AppMode,
  TaskParams,
  InputImage,
  MaskDraft,
  SketchBoardRequest,
  TaskRecord,
  FavoriteCollection,
  ResponsesOutputItem,
  StoredImage,
  StoredImageThumbnail,
} from './types'
import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_PARAMS, type TaskInputSnapshot } from './types'
import { DEFAULT_SETTINGS, getActiveApiProfile, getAgentImageApiProfile, getAgentTextApiProfile, getCustomProviderDefinition, mergeImportedSettings, mergePresetImportedSettings, normalizeSettings, resolveApiProfileModel, splitModelList, validateApiProfile } from './lib/apiProfiles'
import { enforcePresetConfigPolicy, getPresetConfig, getPresetProfileIds, getPresetProviderIds, isPresetConfigDeletionPrevented, isPresetConfigOnlyEnabled, isPresetConfigParamsLocked, isPresetProfile, isPresetProviderDeletionPrevented } from './lib/presetConfig'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { collectSopLibrary, directionPath, mergeSopLibrary, useSopStore } from './lib/sopStore'
import { pointNameForDirection } from './lib/sopPresets'
import { proofreadPrompts } from './lib/promptProofread'
import { ALL_SCOPE, filterTasksByScope, scopeNodeIds, type DirectionScope } from './lib/directionScope'
import { channelForNewTask, channelLabel, taskMatchesChannel } from './lib/channel'
import { planPlainRequests, type PlainImageMode } from './lib/plainImagePlan'
import { MAX_PENDING_SUBMISSIONS, queuePositionLabel, submissionDisposition } from './lib/submitQueue'
import { isTaskUnread } from './lib/unread'
import { getTaskPromptText, remapImageMentionsForOrder, replaceImageMentionsForApi, stripImageMentionMarkers } from './lib/promptImageMentions'
import {
  getAllTasks,
  putTask as dbPutTask,
  deleteTask as dbDeleteTask,
  commitTaskDeletion,
  clearTasks as dbClearTasks,
  getAllAgentConversations,
  putAgentConversation as dbPutAgentConversation,
  replaceAgentConversations,
  clearAgentConversations as dbClearAgentConversations,
  getImage,
  getImageMeta,
  getStoredImageThumbnail,
  getAllImageIds,
  putImage,
  putImageThumbnail,
  deleteImage,
  clearImages,
  storeImage,
  storeImageWithSize,
} from './lib/db'
import { callImageApi } from './lib/api'
import { callAgentConversationTitleApi, callAgentResponsesApi, callBatchImageSingle, parseBatchImageCallArguments, type AgentApiResultImage } from './lib/agentApi'
import { buildAgentApiInput, buildAgentContinuationInput } from './lib/agentInputBuilder'
import { collectAgentRoundOutputImageSlots, extractAgentReferenceIds, getAgentCurrentReferenceId, getAgentGeneratedImageReferenceId } from './lib/agentImageReferences'
import { showBrowserNotification } from './lib/browserNotification'
import { IMAGE_FETCH_CORS_HINT, createUserAbortError, isUserAbort } from './lib/imageApiShared'
import { getFalErrorMessage, getFalQueuedImageResult } from './lib/falAiImageApi'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { runWithConcurrency, splitBatchPrompts } from './lib/batchPrompts'
import { createTransparentOutputMeta, getTransparentRequestParams, removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { blobToDataUrl, dataUrlToBytes, fileToDataUrl } from './lib/dataUrl'
import { cacheImage, cacheThumbnail, clearImageCaches, deleteCachedImage, deleteImageCacheEntry, ensureImageCached, scheduleMissingThumbnailBackfill } from './lib/imageCache'
import { migrateImagesToBlob } from './lib/imageBlob'
import { hasActiveDataOperations, isCustomRecoverableTask, isFalRecoverableTask } from './lib/dataOperations'
import { formatExportFileTime } from './lib/exportFileName'
import { buildExportZip, createExportBlob, getExportZipPlan, MAX_EXPORT_ZIP_BYTES, readExportZip, readExportZipFileAsDataUrl, readExportZipManifest } from './lib/exportZip'
import { getExportImageSizes, readExportImages } from './lib/exportImages'
import { deleteAgentRoundFromConversation, getActiveAgentRounds, getAgentRoundPath, normalizeAgentConversations, remapAgentRoundMentionsForPathChange, uniqueIds } from './lib/agentConversationState'
import { canonicalizeBatchFunctionCallArguments, countResponseToolCalls, createReadyAgentRecoveredToolState, getAgentFunctionOutputCallIds, getAgentRecoveredFailureError, getAgentRecoveredToolCallCount, getPersistableAgentConversations, getPersistableRawResponsePayload, mergeResponseOutputItems, scrubResponseOutputForDeletedAgentTasks, scrubTaskRawResponsePayloadForDeletedTasks } from './lib/agentResponseState'
import { cleanStaleAgentInputDrafts, clearInputDraftState, isEmptyAgentInputDraft, normalizeAgentInputDrafts, remapAgentInputDraftMentionsForPathChange, restoreAgentInputDraftState, restoreGalleryInputDraftState, saveActiveAgentInputDrafts, saveGalleryInputDraft, syncActiveInputDraft, updateInputDraftImages } from './lib/inputDraftState'
import { ALL_FAVORITES_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_ID, createDefaultFavoriteCollection, deleteFavoriteCollectionState, ensureDefaultFavoriteCollection, getTaskFavoriteCollectionIds, mergeFavoriteCollections, normalizeFavoriteCollectionIds, normalizeFavoriteCollectionName, normalizeFavoriteCollections, normalizeFavoritePatch, normalizeLoadedFavoriteState, resolveDefaultFavoriteCollectionId, sameFavoriteCollectionIds } from './lib/favoriteState'
import { createPersistedState, mergePersistedAgentConversations, migratePersistedState, normalizePersistedState } from './lib/persistedState'
import { addImageSizeParam, createTaskDonePatch, createTaskErrorPatch, deriveAgentImageActualParams, deriveGalleryActualParams, firstActualParams, hasActualParams, hasActualSizeParam, mapActualParamsByImage, mapRevisedPromptsByImage, markInterruptedOpenAIRunningTasks } from './lib/taskState'
import { stripInjectedCodexCliSizePrompt, withAspectRatioHint, normalizeCodexCliImageSize } from './lib/size'
import { sizeOverridesForMixedRatios } from './lib/referenceSize'
import { planGenerationSize } from './lib/sizeCapability'
import { parsePixelSize, resizeDataUrlToSize } from './lib/imageResize'
import { applyPostTemplate, productIdForDirection, resolvePostTemplates } from './lib/applyPostTemplate'
import { removeClipVectors } from './lib/clipVectors'
import { buildAvoidHintForTask, withAvoidHint } from './lib/postReserve'
import { imageSizeFromDataUrl } from './lib/imageDimensions'
import { pickTemplateForImage, type PostTemplate } from './lib/postTemplate'
import { dataUrlByteSize, dataUrlFormat, limitDataUrlSize, resolveSizeLimitPlan } from './lib/outputFileSize'
import { finishedFileName, finishedFolderName, writeFinishedImage } from './lib/postFinished'
import { cardKeyOf, deliverCardGroup, deliverImageFileName, deliverTaskCard, deliveredFileRefsOf, resolveCardDeliveryLocation, resolveCardFolderName, tasksOfCard, type DeliverResult } from './lib/deliver'
import { dispatchSkipNote, pickDispatchTemplate } from './lib/dispatch'
import { openDirectoryPath } from './lib/deliveryDirPicker'
import { resolveDeliveryDir } from './lib/deliveryDir'
import { peersForTask } from './lib/duplicateScope'
import { useInspectConfig } from './lib/inspectConfig'
import { useClipStore } from './lib/clipSimilarity'
import { apiFetch, FetchConnectError, isTauri } from './lib/platform'
import { pickSaveDir, saveFile, saveFileToDir, getDefaultSaveDir, createSaveFolder, removeDeliveredFile, useSaveDir, type SaveOptions } from './lib/saveFile'
import { endDataProgress, setDataProgressCancelable, startDataProgress, updateDataProgress } from './lib/dataProgress'
import { throwIfAborted } from './lib/serverSentEvents'
import { safeJsonStorage, tauriStorage } from './lib/tauriStorage'

const FAL_RECOVERY_POLL_MS = 10_000
const CUSTOM_RECOVERY_POLL_MS = 10_000
const SUPPORT_PROMPT_IMAGE_THRESHOLD = 50
const falRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const taskExecutions = new Map<string, symbol>()
/**
 * 每个正在跑的任务一个中止控制器：用户点「停止」时用它掐断请求。
 * 只放「当前这次执行」的那一个；任务结束时删掉，避免误停已经结束的任务。
 */
const taskAbortControllers = new Map<string, AbortController>()
const agentRoundControllers = new Map<string, AbortController>()
const agentRecoveryContinuations = new Set<string>()
const deletedActiveAgentTasks = new Map<string, { task: TaskRecord; controller: AbortController }>()
let agentConversationPersistenceReady = false
let agentConversationMigrationPending = false
const AGENT_STOPPED_MESSAGE = '已停止生成。'
const AGENT_RECOVERY_PAUSE_ERROR = 'AgentRecoveryPauseError'
const AGENT_CONVERSATION_TITLE_MAX_LENGTH = 28
const ERROR_TOAST_MAX_LENGTH = 80
type ToastType = 'info' | 'success' | 'error'
type AgentDeletionResult = 'deleted' | 'deleted-with-warning' | 'running' | 'not-found'

export function getErrorToastMessage(message: string): string {
  const text = message.trim()
  if (!text) return '操作失败'

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
  const separatorIndex = firstLine.search(/[：:]/)
  if (separatorIndex > 0) {
    const title = firstLine.slice(0, separatorIndex).trim()
    if (isErrorToastTitle(title)) return title
  }

  if (firstLine.length > ERROR_TOAST_MAX_LENGTH) return '操作失败，请查看详情'
  return firstLine || '操作失败'
}

function getToastMessage(message: string, type: ToastType): string {
  return type === 'error' ? getErrorToastMessage(message) : message
}

function isErrorToastTitle(title: string): boolean {
  return /(?:失败|错误|异常|报错|无法|不能|超时|中断|断开|请先|请输入|已达上限|不存在|已丢失)$/.test(title)
}

export type SettingsTab = 'general' | 'agent' | 'api' | 'data' | 'mcp' | 'about'

const TIMEOUT_STREAMING_HINT = '也可尝试打开「流式传输」，并提高「请求中间步骤图像数」来维持连接。'
const TIMEOUT_PARTIAL_IMAGES_ZERO_HINT = '官方流式接口不发送心跳，当前「请求中间步骤图像数」为 0，连接可能因无数据传输而断开。建议提高到 2 或 3。'
const TIMEOUT_PARTIAL_IMAGES_LOW_HINT = '也可尝试提高「请求中间步骤图像数」来维持连接，避免长时间无数据传输导致断开。'

type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>

function getTimeoutStreamingHint(profile?: TimeoutStreamingHintProfile | null) {
  if (profile?.provider !== 'openai') return ''
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return TIMEOUT_STREAMING_HINT
  if (partialImages === 0) return TIMEOUT_PARTIAL_IMAGES_ZERO_HINT
  return partialImages < 3 ? TIMEOUT_PARTIAL_IMAGES_LOW_HINT : ''
}

function createOpenAITimeoutError(timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。${getTimeoutStreamingHint(profile)}`
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

export function isAgentTask(task: TaskRecord) {
  return task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)
}

// 失败通知用独立 tag，避免与成功通知互相覆盖
function showTaskCompletionNotification(title: string, body: string, tag = 'task-completion') {
  const settings = normalizeSettings(useStore.getState().settings)
  if (!settings.taskCompletionNotification) return
  showBrowserNotification(title, { body, tag })
}

function showTaskFailureNotification(task: TaskRecord) {
  // Agent 任务由所在回合统一通知，批量任务在整批结束时汇总失败数量
  if (isAgentTask(task) || batchTaskIds.has(task.id)) return
  showTaskCompletionNotification('图像生成失败', '请回到应用查看详情。', 'task-failure')
}

export function countSuccessfulOutputImages(tasks: TaskRecord[]) {
  return tasks.reduce((count, task) => count + (task.status === 'done' && !isAgentTask(task) ? task.outputImages.length : 0), 0)
}

function skipSupportPromptForImportedData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptOpen) return {}
    return { supportPromptSkippedForImportedData: true }
  })
}

function showSupportPromptForExistingLocalData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed || state.supportPromptOpen) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptSkippedForImportedData) return {}
    // 赞助弹窗自动弹出已关闭：本地已有超阈值数据时不再打开（组件与状态字段保留，便于后续恢复）
    return {}
  })
}

function maybeOpenSupportPrompt(previousTasks: TaskRecord[], nextTasks: TaskRecord[], taskId: string) {
  const state = useStore.getState()
  if (state.supportPromptDismissed || state.supportPromptOpen || state.supportPromptSkippedForImportedData) return

  const previousTask = previousTasks.find((task) => task.id === taskId)
  const nextTask = nextTasks.find((task) => task.id === taskId)
  if (!nextTask || previousTask?.status === 'done' || nextTask.status !== 'done' || nextTask.outputImages.length === 0) return

  const previousCount = countSuccessfulOutputImages(previousTasks)
  const nextCount = countSuccessfulOutputImages(nextTasks)
  if (previousCount <= SUPPORT_PROMPT_IMAGE_THRESHOLD && nextCount > SUPPORT_PROMPT_IMAGE_THRESHOLD) {
    // 赞助弹窗自动弹出已关闭：生成数量首次超过阈值时不再打开（组件与状态字段保留，便于后续恢复）
  }
}

function mergeImportedAgentConversations(current: AgentConversation[], imported: AgentConversation[]) {
  const merged = [...current]
  const indexes = new Map(merged.map((conversation, index) => [conversation.id, index]))

  for (const conversation of imported) {
    const index = indexes.get(conversation.id)
    if (index == null) {
      indexes.set(conversation.id, merged.length)
      merged.push(conversation)
    } else {
      merged[index] = conversation
    }
  }

  return merged
}

function createAgentConversation(now = Date.now()): AgentConversation {
  return {
    id: genId(),
    title: '新对话',
    activeRoundId: null,
    createdAt: now,
    updatedAt: now,
    rounds: [],
    messages: [],
  }
}

function createAgentConversationTitle(prompt: string, fallbackTitle: string) {
  const title = prompt.replace(/\s+/g, ' ').trim()
  if (!title) return fallbackTitle
  const chars = Array.from(title)
  if (chars.length <= AGENT_CONVERSATION_TITLE_MAX_LENGTH) return title
  return `${chars.slice(0, AGENT_CONVERSATION_TITLE_MAX_LENGTH - 3).join('')}...`
}

function isEmptyAgentConversation(conversation: AgentConversation) {
  return conversation.rounds.length === 0 && conversation.messages.length === 0 && !conversation.activeRoundId
}

function getLatestAgentConversation(conversations: AgentConversation[]) {
  return conversations.reduce<AgentConversation | null>((latest, conversation) => {
    if (!latest) return conversation
    if (conversation.updatedAt !== latest.updatedAt) return conversation.updatedAt > latest.updatedAt ? conversation : latest
    return conversation.createdAt > latest.createdAt ? conversation : latest
  }, null)
}

export function getPersistedState(state: AppState) {
  return createPersistedState(state, agentConversationMigrationPending && !agentConversationPersistenceReady)
}

async function replaceStoredAgentConversations(conversations: AgentConversation[]) {
  await replaceAgentConversations(conversations.map(getPersistableAgentConversation))
}

function getPersistableAgentConversation(conversation: AgentConversation): AgentConversation {
  return getPersistableAgentConversations([conversation])[0]!
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  const plan = normalizePersistedState(persistedState, currentState)
  if (!plan) return currentState
  if (plan.shouldMigrateAgentConversations) agentConversationMigrationPending = true
  return {
    ...currentState,
    ...plan.state,
    activeFavoriteCollectionId: null,
    favoritePickerTaskIds: null,
    assignPickerTaskIds: null,
  }
}

// ===== Store 类型 =====

interface AppState {
  // 模式
  appMode: AppMode
  setAppMode: (mode: AppMode) => void

  // 设置
  settings: AppSettings
  previousPresetConfig: PresetConfig | null
  setSettings: (s: Partial<AppSettings>) => void
  setPresetImportedSettings: (
    importedSettings: Partial<AppSettings> | unknown,
    transform?: (settings: AppSettings) => Partial<AppSettings>,
  ) => Promise<void>
  dismissedPresetProfileIds: string[]
  dismissPresetProfile: (id: string) => void
  restorePresetProfile: (id: string) => void
  dismissedPresetProviderIds: string[]
  dismissPresetProvider: (id: string) => void
  restorePresetProvider: (id: string) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  /**
   * 本次的自定义文案（输入框上方那一栏「本次文案」）。
   * 只影响出图时的图上文字，不参与输入框提交；会一直被记住，直到手动清掉。
   */
  customCopy: string
  setCustomCopy: (text: string) => void

  /**
   * 输入框最后一次的选区（可见文本偏移），供画板等外部入口插入胶囊并覆盖选中内容；未聚焦过时为 null。
   * 同时记下当时的提示词，提示词被其他途径替换后选区即失效，使用前需比对。
   */
  promptSelection: { start: number; end: number; prompt: string } | null
  setPromptSelection: (selection: { start: number; end: number }) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  /** 一次性追加多张：拖拽/粘贴大批图片时只触发一次更新，避免逐张 set 造成的连续重渲染 */
  addInputImages: (imgs: InputImage[], limit?: number) => number
  replaceInputImage: (idx: number, img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  /**
   * 普通模式的发图方式：
   * batch = 每张变量图各发一次请求；merge = 一次请求带上整组图。
   * 默认 batch，和「三模式」里的普通模式定位一致。
   */
  plainImageMode: PlainImageMode
  setPlainImageMode: (mode: PlainImageMode) => void
  /** 固定图：融图模式下每个请求都会带上；变量模式图生图时也是每条提示词都带 */
  fixedImages: InputImage[]
  addFixedImage: (img: InputImage) => void
  /** 一次性追加多张固定图，拖一批进来时只更新一次 */
  addFixedImages: (imgs: InputImage[], limit?: number) => number
  /** 整体替换固定图（复用配置时按任务回填） */
  setFixedImages: (imgs: InputImage[]) => void
  removeFixedImage: (idx: number) => void
  clearFixedImages: () => void
  /**
   * 变量图：变量模式图生图专用，每条提示词轮换取一张，是「这张和上一张哪里不一样」的来源。
   * 与参考图（只用于提取策略）和固定图（每条都带）分开存。
   */
  variableImages: InputImage[]
  addVariableImage: (img: InputImage) => void
  addVariableImages: (imgs: InputImage[], limit?: number) => number
  /** 整体替换变量图（复用配置时按任务回填） */
  setVariableImages: (imgs: InputImage[]) => void
  removeVariableImage: (idx: number) => void
  clearVariableImages: () => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void
  galleryInputDraft: AgentInputDraft | null

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  /** 临时复用其他配置时使用的模型，只在本次复用中生效，不写入该配置 */
  reusedTaskApiModel: string | null
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null, model?: string | null) => void
  setReusedTaskApiModel: (model: string) => void
  /** 正在进行的批量提交进度，仅保存在内存中 */
  batchProgress: BatchProgress | null
  setBatchProgress: (progress: BatchProgress | null) => void
  /** 排队等待提交的批次数：批量进行中再提交会先排队，当前批结束后自动开始 */
  queuedSubmitCount: number
  setQueuedSubmitCount: (count: number) => void

  // Agent
  agentConversations: AgentConversation[]
  agentConversationsLoaded: boolean
  activeAgentConversationId: string | null
  agentInputDrafts: Record<string, AgentInputDraft>
  agentSidebarCollapsed: boolean
  agentAssetTab: 'references' | 'outputs'
  agentAssetPanelCollapsed: boolean
  agentMobileHeaderVisible: boolean
  agentEditingRoundId: string | null
  agentEditingConversationId: string | null
  agentGeneratingTitleIds: Record<string, true>
  createAgentConversation: () => string
  setActiveAgentConversationId: (id: string | null) => void
  setActiveAgentRoundId: (conversationId: string, roundId: string | null) => void
  renameAgentConversation: (id: string, title: string) => void
  deleteAgentConversation: (id: string) => void
  deleteAgentRound: (conversationId: string, roundId: string) => Promise<AgentDeletionResult>
  deleteAgentAssistantMessage: (conversationId: string, messageId: string) => Promise<AgentDeletionResult>
  setAgentSidebarCollapsed: (collapsed: boolean) => void
  setAgentAssetTab: (tab: 'references' | 'outputs') => void
  setAgentAssetPanelCollapsed: (collapsed: boolean) => void
  setAgentMobileHeaderVisible: (visible: boolean) => void
  setAgentEditingRoundId: (id: string | null) => void
  setAgentEditingConversationId: (id: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  /** 回收站里的任务。与 tasks 分开存，避免影响任何既有筛选与计数逻辑 */
  trashedTasks: TaskRecord[]
  setTrashedTasks: (t: TaskRecord[]) => void
  favoriteCollections: FavoriteCollection[]
  setFavoriteCollections: (collections: FavoriteCollection[]) => void
  defaultFavoriteCollectionId: string | null
  setDefaultFavoriteCollectionId: (id: string | null) => void
  activeFavoriteCollectionId: string | null
  isManageCollectionsModalOpen: boolean
  setActiveFavoriteCollectionId: (id: string | null) => void
  openManageCollectionsModal: () => void
  closeManageCollectionsModal: () => void
  favoritePickerTaskIds: string[] | null
  openFavoritePicker: (taskIds: string[]) => void
  closeFavoritePicker: () => void
  /** 归属选择弹窗：待指派的卡片所属任务 id，null 表示关闭 */
  assignPickerTaskIds: string[] | null
  openAssignPicker: (taskIds: string[]) => void
  closeAssignPicker: () => void
  streamPreviews: Record<string, string>
  streamPreviewSlots: Record<string, Record<string, string>>
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  /**
   * 渠道筛选：null 表示不限。与业务树筛选（sopStore.activeFilterId）互相独立，取交集。
   */
  channelFilter: string | null
  setChannelFilter: (channel: string | null) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void
  selectedFavoriteCollectionIds: string[]
  setSelectedFavoriteCollectionIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleFavoriteCollectionSelection: (id: string, force?: boolean) => void
  clearFavoriteCollectionSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  /** 详情页打开后清掉未读标记；SOP / 变量卡整组一起清 */
  markTaskDetailViewed: (id: string) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  /** 预览参考图时对应的提示词，按图片在列表中的位置取其评论；为空时不显示评论 */
  lightboxCommentPrompt: string | null
  setLightboxImageId: (id: string | null, list?: string[], commentPrompt?: string | null) => void
  /** 画板；baseImageSrc 为画布底图，replaceImageId 为完成后要替换的参考图 */
  sketchBoard: SketchBoardRequest | null
  setSketchBoard: (board: SketchBoardRequest | null) => void
  showSettings: boolean
  settingsTabRequest: SettingsTab | null
  setShowSettings: (v: boolean, tab?: SettingsTab) => void
  supportPromptOpen: boolean
  supportPromptDismissed: boolean
  supportPromptSkippedForImportedData: boolean
  setSupportPromptOpen: (v: boolean) => void
  dismissSupportPrompt: () => void

  // Toast
  toast: { message: string; type: ToastType } | null
  showToast: (message: string, type?: ToastType) => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    /** 显示在 message 下方的自定义内容，过长时可滚动 */
    content?: ReactNode
    checkbox?: {
      label: string
      defaultChecked?: boolean
      disabled?: boolean
      tone?: 'primary' | 'danger'
    }
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    buttons?: Array<{
      label: string
      tone?: 'primary' | 'secondary' | 'danger' | 'warning'
      action: (checkboxChecked?: boolean) => void
    }>
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    awaitAction?: boolean
    /** awaitAction 执行期间确认按钮显示的文字 */
    busyText?: string
    action?: (checkboxChecked?: boolean) => void | boolean | Promise<void | boolean>
    cancelAction?: (checkboxChecked?: boolean) => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

function isImageReferencedByState(state: AppState, imageId: string) {
  if (state.inputImages.some((img) => img.id === imageId)) return true
  if (state.galleryInputDraft?.inputImages.some((img) => img.id === imageId)) return true
  if (Object.values(state.agentInputDrafts).some((draft) => draft.inputImages.some((img) => img.id === imageId))) return true
  if (state.tasks.some((task) =>
    task.inputImageIds.includes(imageId) ||
    task.outputImages.includes(imageId) ||
    // AI 原图是派发 / 再次后处理的源，不能因为成品换了内容就删掉
    task.sourceImages?.includes(imageId) ||
    // 参考图只记在 sopReferenceImageIds 里（SOP 模式 inputImageIds 是空的），
    // 漏判会在重启清理孤儿图时被删掉，复用配置就还原不出来了
    task.sopReferenceImageIds?.includes(imageId) ||
    task.variableImageId === imageId ||
    task.variableFixedImageIds?.includes(imageId) ||
    task.transparentOriginalImages?.includes(imageId) ||
    task.streamPartialImageIds?.includes(imageId) ||
    task.maskTargetImageId === imageId ||
    task.maskImageId === imageId
  )) return true
  return state.agentConversations.some((conversation) =>
    conversation.rounds.some((round) =>
      round.inputImageIds.includes(imageId) ||
      round.maskTargetImageId === imageId ||
      round.maskImageId === imageId
    ) ||
    conversation.messages.some((message) =>
      message.inputImageIds?.includes(imageId) ||
      message.maskTargetImageId === imageId ||
      message.maskImageId === imageId
    ),
  )
}

export async function deleteImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  try {
    await deleteStoredImageIfUnreferenced(imageId)
  } catch {
    // 清理是内存/存储优化，失败不影响替换结果。
  }
}

async function deleteStoredImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  const [image, thumbnail] = await Promise.all([getImage(imageId), getStoredImageThumbnail(imageId)])
  if (isImageReferencedByState(useStore.getState(), imageId)) return

  await deleteImage(imageId)
  if (!isImageReferencedByState(useStore.getState(), imageId)) {
    deleteImageCacheEntry(imageId)
    // 图彻底删掉了，向量库里的指纹也一起清掉，否则全库比对会拿已经不存在的图当参照
    removeClipVectors([imageId])
    return
  }

  if (image) {
    await putImage(image)
    cacheImage(image.id, image.dataUrl)
  }
  if (thumbnail) {
    await putImageThumbnail(thumbnail)
    cacheThumbnail(thumbnail.id, {
      src: thumbnail.thumbnailDataUrl,
      width: thumbnail.width,
      height: thumbnail.height,
      thumbnailVersion: thumbnail.thumbnailVersion,
    })
  }
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Mode
      appMode: 'gallery',
      setAppMode: (appMode) => {
        if (appMode === 'gallery') {
          const state = get()
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          const galleryInputDraft = saveGalleryInputDraft(state)
          set((state) => ({
            appMode,
            agentInputDrafts,
            galleryInputDraft,
            agentMobileHeaderVisible: true,
            selectedTaskIds: [],
            selectedFavoriteCollectionIds: [],
            agentEditingRoundId: null,
            ...(state.appMode === 'agent' ? restoreGalleryInputDraftState(galleryInputDraft) : {}),
          }))
          return
        }

        const state = get()
        const settings = normalizeSettings(state.settings)
        const activeProfile = getActiveApiProfile(settings)
        const agentValidationError = getAgentProfileValidationError(settings)

        if (!agentValidationError) {
          const galleryInputDraft = saveGalleryInputDraft(state)
          set((state) => ({
            appMode: 'agent',
            galleryInputDraft,
            agentMobileHeaderVisible: false,
            agentSidebarCollapsed: true,
            agentAssetPanelCollapsed: true,
            selectedTaskIds: [],
            selectedFavoriteCollectionIds: [],
            ...restoreAgentInputDraftState(state.agentInputDrafts, state.activeAgentConversationId),
          }))
          return
        }

        if (settings.agentApiConfigMode === 'off' && activeProfile.provider === 'openai' && activeProfile.apiMode !== 'responses') {
          state.setConfirmDialog({
            title: '需要 Responses API 配置',
            message: `当前配置「${activeProfile.name}」使用的是 Images API，仅支持生成图片，无 Agent 模式需要的对话能力。\n\n请前往 API 配置页，将当前配置调整为 Responses API，或切换/新建一个支持 Responses API 的配置。`,
            confirmText: '去设置',
            cancelText: '取消',
            action: () => {
              useStore.getState().setShowSettings(true, 'api')
            },
          })
          return
        }

        if (settings.agentApiConfigMode !== 'off') {
          state.setConfirmDialog({
            title: 'Agent API 配置不完整',
            message: `${agentValidationError.message}\n\n请前往 Agent 配置页，选择或新建可用配置。`,
            confirmText: '去设置',
            cancelText: '取消',
            action: () => {
              useStore.getState().setShowSettings(true, 'agent')
            },
          })
          return
        }

        state.setConfirmDialog({
          title: '配置不支持 Agent 模式',
          message: `当前配置「${activeProfile.name}」所属的服务商暂不支持 Agent 模式。Agent 模式需要使用支持 Responses API 的 OpenAI 配置。\n\n请前往 API 配置页，切换或新建一个支持 Responses API 的配置。`,
          confirmText: '去设置',
          cancelText: '取消',
          action: () => {
            useStore.getState().setShowSettings(true, 'api')
          },
        })
      },

      // Settings
      settings: { ...DEFAULT_SETTINGS },
      previousPresetConfig: null,
      dismissedPresetProfileIds: [],
      dismissPresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.includes(id)
          ? state.dismissedPresetProfileIds
          : [...state.dismissedPresetProfileIds, id],
      })),
      restorePresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.filter((item) => item !== id),
      })),
      dismissedPresetProviderIds: [],
      dismissPresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.includes(id)
          ? state.dismissedPresetProviderIds
          : [...state.dismissedPresetProviderIds, id],
      })),
      restorePresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.filter((item) => item !== id),
      })),
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.apiProxy !== undefined ||
          incoming.streamImages !== undefined ||
          incoming.streamPartialImages !== undefined
        const merged = normalizeSettings({ ...previous, ...incoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  apiProxy: incoming.apiProxy ?? profile.apiProxy,
                  streamImages: incoming.streamImages ?? profile.streamImages,
                  streamPartialImages: incoming.streamPartialImages ?? profile.streamPartialImages,
                }
              : profile,
          )
        }
        const effectiveDismissedPresetProviderIds = st.dismissedPresetProviderIds.filter((id) =>
          !isPresetProviderDeletionPrevented(id, previous.profiles),
        )
        const settings = normalizeSettings(enforcePresetConfigPolicy(merged, {
          dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
        }))
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false, reusedTaskApiModel: null }
            : {}),
        }
      }),
      setPresetImportedSettings: async (importedSettings, transform) => {
        set((state) => {
          const presetIds = getPresetProfileIds()
          const presetProviderIds = getPresetProviderIds()
          const dismissedPresetProfileIds = state.dismissedPresetProfileIds.filter((id) => presetIds.has(id))
          const deletionPrevented = isPresetConfigDeletionPrevented()
          const remainingPresetProfiles = (getPresetConfig()?.profiles ?? state.settings.profiles)
            .filter((profile) => !dismissedPresetProfileIds.includes(profile.id))
          const dismissedPresetProviderIds = state.dismissedPresetProviderIds
            .filter((id) => presetProviderIds.has(id))
          const effectiveDismissedPresetProviderIds = dismissedPresetProviderIds
            .filter((id) => !isPresetProviderDeletionPrevented(id, remainingPresetProfiles))
          const merged = mergePresetImportedSettings(state.settings, importedSettings, {
            lockPresetParams: isPresetConfigParamsLocked(),
            dismissedPresetProfileIds: deletionPrevented ? [] : dismissedPresetProfileIds,
            dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
            previousPresetConfig: state.previousPresetConfig,
            usedPresetProfileIds: state.tasks.flatMap((task) => task.apiProfileId ? [task.apiProfileId] : []),
          })
          const settings = normalizeSettings(enforcePresetConfigPolicy(
            normalizeSettings(transform?.(merged.settings) ?? merged.settings),
            { dismissedPresetProviderIds: effectiveDismissedPresetProviderIds },
          ))
          const shouldClearReusedProfile = state.reusedTaskApiProfileId && settings.activeProfileId === state.reusedTaskApiProfileId
          return {
            settings,
            previousPresetConfig: getPresetConfig() ? merged.presetConfig : null,
            dismissedPresetProfileIds,
            dismissedPresetProviderIds,
            reusedTaskApiProfileId: shouldClearReusedProfile ? null : state.reusedTaskApiProfileId,
            ...(shouldClearReusedProfile
              ? { reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false, reusedTaskApiModel: null }
              : {}),
          }
        })
      },
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set((s) => syncActiveInputDraft(s, { prompt })),
      customCopy: '',
      setCustomCopy: (customCopy) => set({ customCopy }),

      promptSelection: null,
      setPromptSelection: (selection) => set((s) => ({ promptSelection: { ...selection, prompt: s.prompt } })),
      inputImages: [],
      plainImageMode: 'batch',
      setPlainImageMode: (plainImageMode) => set({ plainImageMode }),
      fixedImages: [],
      addFixedImage: (img) =>
        set((s) => (s.fixedImages.some((item) => item.id === img.id) ? s : { fixedImages: [...s.fixedImages, img] })),
      addFixedImages: (imgs, limit) => {
        let added = 0
        set((s) => {
          const seen = new Set(s.fixedImages.map((item) => item.id))
          const next = [...s.fixedImages]
          for (const img of imgs) {
            if (seen.has(img.id)) continue
            if (limit != null && next.length >= limit) break
            seen.add(img.id)
            next.push(img)
            added += 1
          }
          return added ? { fixedImages: next } : s
        })
        return added
      },
      removeFixedImage: (idx) =>
        set((s) => ({ fixedImages: s.fixedImages.filter((_, i) => i !== idx) })),
      setFixedImages: (imgs) => set({ fixedImages: imgs }),
      clearFixedImages: () =>
        set((s) => {
          for (const img of s.fixedImages) deleteCachedImage(img.id)
          return { fixedImages: [] }
        }),
      variableImages: [],
      addVariableImage: (img) =>
        set((s) => (s.variableImages.some((item) => item.id === img.id) ? s : { variableImages: [...s.variableImages, img] })),
      addVariableImages: (imgs, limit) => {
        let added = 0
        set((s) => {
          const seen = new Set(s.variableImages.map((item) => item.id))
          const next = [...s.variableImages]
          for (const img of imgs) {
            if (seen.has(img.id)) continue
            if (limit != null && next.length >= limit) break
            seen.add(img.id)
            next.push(img)
            added += 1
          }
          return added ? { variableImages: next } : s
        })
        return added
      },
      removeVariableImage: (idx) =>
        set((s) => ({ variableImages: s.variableImages.filter((_, i) => i !== idx) })),
      setVariableImages: (imgs) => set({ variableImages: imgs }),
      clearVariableImages: () =>
        set((s) => {
          for (const img of s.variableImages) deleteCachedImage(img.id)
          return { variableImages: [] }
        }),
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return syncActiveInputDraft(s, { inputImages: [...s.inputImages, img] })
        }),
      addInputImages: (imgs, limit) => {
        let added = 0
        set((s) => {
          const seen = new Set(s.inputImages.map((item) => item.id))
          const next = [...s.inputImages]
          for (const img of imgs) {
            if (seen.has(img.id)) continue
            if (limit != null && next.length >= limit) break
            seen.add(img.id)
            next.push(img)
            added += 1
          }
          if (added === 0) return s
          return syncActiveInputDraft(s, { inputImages: next })
        })
        return added
      },
      replaceInputImage: (idx, img) => {
        let removedImageId: string | null = null
        set((s) => {
          if (idx < 0 || idx >= s.inputImages.length) return s
          const previous = s.inputImages[idx]
          if (!previous || previous.id === img.id) return s
          if (s.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return s
          removedImageId = previous.id
          const inputImages = s.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: { [previous.id]: img.id },
            clearMissingMask: previous.id === s.maskDraft?.targetImageId,
          }))
        })
        if (removedImageId) void deleteImageIfUnreferenced(removedImageId)
      },
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            clearMissingMask: removed?.id === s.maskDraft?.targetImageId,
          }))
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) deleteCachedImage(img.id)
          return syncActiveInputDraft(s, {
            ...updateInputDraftImages(s, []),
            maskDraft: null,
            maskEditorImageId: null,
          })
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: options?.equivalentImageIds,
          }))
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return syncActiveInputDraft(s, updateInputDraftImages(s, images, { clearMissingMask: false }))
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          })
        }),
      clearMaskDraft: () => set((s) => syncActiveInputDraft(s, { maskDraft: null })),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set((s) => syncActiveInputDraft(s, { maskEditorImageId }))
      },
      galleryInputDraft: null,

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      reusedTaskApiModel: null,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null, model = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
        reusedTaskApiModel: profileId ? model : null,
      }),
      setReusedTaskApiModel: (reusedTaskApiModel) => set({ reusedTaskApiModel }),
      batchProgress: null,
      setBatchProgress: (batchProgress) => set({ batchProgress }),
      queuedSubmitCount: 0,
      setQueuedSubmitCount: (queuedSubmitCount) => set({ queuedSubmitCount }),

      // Agent
      agentConversations: [],
      agentConversationsLoaded: false,
      activeAgentConversationId: null,
      agentInputDrafts: {},
      agentSidebarCollapsed: true,
      agentAssetTab: 'outputs',
      agentAssetPanelCollapsed: false,
      agentMobileHeaderVisible: false,
      agentEditingRoundId: null,
      agentEditingConversationId: null,
      agentGeneratingTitleIds: {},
      createAgentConversation: () => {
        const now = Date.now()
        const latestConversation = getLatestAgentConversation(get().agentConversations)
        if (latestConversation && isEmptyAgentConversation(latestConversation)) {
          set((state) => {
            const agentInputDrafts = saveActiveAgentInputDrafts(state)
            return {
              agentConversations: state.agentConversations.map((conversation) =>
                conversation.id === latestConversation.id
                  ? { ...conversation, createdAt: now, updatedAt: now }
                  : conversation,
              ),
              activeAgentConversationId: latestConversation.id,
              agentInputDrafts,
              agentSidebarCollapsed: true,
              agentEditingRoundId: null,
              ...restoreAgentInputDraftState(agentInputDrafts, latestConversation.id),
            }
          })
          return latestConversation.id
        }

        const conversation = createAgentConversation(now)
        set((state) => {
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          return {
            agentConversations: [
              ...state.agentConversations,
              conversation,
            ],
            activeAgentConversationId: conversation.id,
            agentInputDrafts,
            agentSidebarCollapsed: true,
            agentEditingRoundId: null,
            ...restoreAgentInputDraftState(agentInputDrafts, conversation.id),
          }
        })
        return conversation.id
      },
      setActiveAgentConversationId: (id) => set((state) => {
        if (state.activeAgentConversationId === id) {
          return {
            activeAgentConversationId: id,
            agentSidebarCollapsed: true,
            agentAssetPanelCollapsed: true,
            agentEditingRoundId: null,
          }
        }
        const agentInputDrafts = saveActiveAgentInputDrafts(state)
        return {
          activeAgentConversationId: id,
          agentInputDrafts,
          agentSidebarCollapsed: true,
          agentAssetPanelCollapsed: true,
          agentEditingRoundId: null,
          ...restoreAgentInputDraftState(agentInputDrafts, id),
        }
      }),
      setActiveAgentRoundId: (conversationId, roundId) => set((state) => ({
        agentConversations: state.agentConversations.map((conversation) =>
          conversation.id === conversationId ? { ...conversation, activeRoundId: roundId, updatedAt: Date.now() } : conversation,
        ),
      })),
      renameAgentConversation: (id, title) => set((state) => ({ agentConversations: state.agentConversations.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)) })),
      deleteAgentConversation: (id) => set((state) => {
        const agentInputDrafts = { ...state.agentInputDrafts }
        delete agentInputDrafts[id]
        const activeDeleted = state.activeAgentConversationId === id
        return {
          agentConversations: state.agentConversations.filter((c) => c.id !== id),
          activeAgentConversationId: activeDeleted ? null : state.activeAgentConversationId,
          agentInputDrafts,
          ...(activeDeleted ? clearInputDraftState() : {}),
        }
      }),
      deleteAgentRound: (conversationId, roundId) => deleteAgentRoundAndTasks(conversationId, roundId),
      deleteAgentAssistantMessage: (conversationId, messageId) => deleteAgentAssistantMessageAndTasks(conversationId, messageId),
      setAgentSidebarCollapsed: (agentSidebarCollapsed) => set({ agentSidebarCollapsed }),
      setAgentAssetTab: (agentAssetTab) => set({ agentAssetTab }),
      setAgentAssetPanelCollapsed: (agentAssetPanelCollapsed) => set({ agentAssetPanelCollapsed }),
      setAgentMobileHeaderVisible: (agentMobileHeaderVisible) => set({ agentMobileHeaderVisible }),
      setAgentEditingRoundId: (agentEditingRoundId) => set({ agentEditingRoundId }),
      setAgentEditingConversationId: (agentEditingConversationId) => set({ agentEditingConversationId }),

      // Tasks
      tasks: [],
      trashedTasks: [],
      setTrashedTasks: (trashedTasks) => set(() => ({ trashedTasks })),
      setTasks: (tasks) => set(() => ({
        tasks,
        ...(countSuccessfulOutputImages(tasks) <= SUPPORT_PROMPT_IMAGE_THRESHOLD
          ? { supportPromptSkippedForImportedData: false }
          : {}),
      })),
      favoriteCollections: [createDefaultFavoriteCollection()],
      setFavoriteCollections: (favoriteCollections) => set((state) => {
        const nextCollections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections(favoriteCollections))
        return {
          favoriteCollections: nextCollections,
          defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(nextCollections, state.defaultFavoriteCollectionId),
        }
      }),
      defaultFavoriteCollectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      setDefaultFavoriteCollectionId: (defaultFavoriteCollectionId) => set((state) => (
        defaultFavoriteCollectionId === null || state.favoriteCollections.some((collection) => collection.id === defaultFavoriteCollectionId)
          ? { defaultFavoriteCollectionId }
          : state
      )),
      activeFavoriteCollectionId: null,
      isManageCollectionsModalOpen: false,
      setActiveFavoriteCollectionId: (activeFavoriteCollectionId) => set({ activeFavoriteCollectionId, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),
      openManageCollectionsModal: () => set({ isManageCollectionsModalOpen: true }),
      closeManageCollectionsModal: () => set({ isManageCollectionsModalOpen: false }),
      favoritePickerTaskIds: null,
      openFavoritePicker: (taskIds) => {
        if (!taskIds.length) return
        dismissAllTooltips()
        set({ favoritePickerTaskIds: Array.from(new Set(taskIds)).filter(Boolean) })
      },
      closeFavoritePicker: () => set({ favoritePickerTaskIds: null }),
      assignPickerTaskIds: null,
      openAssignPicker: (taskIds) => {
        if (!taskIds.length) return
        dismissAllTooltips()
        set({ assignPickerTaskIds: Array.from(new Set(taskIds)).filter(Boolean) })
      },
      closeAssignPicker: () => set({ assignPickerTaskIds: null }),
      streamPreviews: {},
      streamPreviewSlots: {},
      setTaskStreamPreview: (taskId, image, requestIndex = 0) => set((s) => {
        if (image) {
          if (!s.tasks.some((task) => task.id === taskId)) return s
          const slotKey = String(requestIndex)
          const currentSlots = s.streamPreviewSlots[taskId] ?? {}
          if (s.streamPreviews[taskId] === image && currentSlots[slotKey] === image) return s
          return {
            streamPreviews: { ...s.streamPreviews, [taskId]: image },
            streamPreviewSlots: {
              ...s.streamPreviewSlots,
              [taskId]: { ...currentSlots, [slotKey]: image },
            },
          }
        }

        if (!(taskId in s.streamPreviews) && !(taskId in s.streamPreviewSlots)) return s
        const next = { ...s.streamPreviews }
        const nextSlots = { ...s.streamPreviewSlots }
        delete next[taskId]
        delete nextSlots[taskId]
        return { streamPreviews: next, streamPreviewSlots: nextSlots }
      }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      channelFilter: null,
      setChannelFilter: (channelFilter) => set({ channelFilter }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set(filterFavorite ? { filterFavorite, selectedTaskIds: [], selectedFavoriteCollectionIds: [] } : { filterFavorite, activeFavoriteCollectionId: null, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),
      selectedFavoriteCollectionIds: [],
      setSelectedFavoriteCollectionIds: (updater) => set((s) => ({
        selectedFavoriteCollectionIds: typeof updater === 'function' ? updater(s.selectedFavoriteCollectionIds) : updater
      })),
      toggleFavoriteCollectionSelection: (id, force) => set((s) => {
        const isSelected = s.selectedFavoriteCollectionIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedFavoriteCollectionIds: shouldSelect
            ? [...s.selectedFavoriteCollectionIds, id]
            : s.selectedFavoriteCollectionIds.filter((x) => x !== id)
        }
      }),
      clearFavoriteCollectionSelection: () => set({ selectedFavoriteCollectionIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) {
          dismissAllTooltips()
          get().markTaskDetailViewed(detailTaskId)
        }
        set({ detailTaskId })
      },
      markTaskDetailViewed: (taskId) => {
        const { tasks } = get()
        const target = tasks.find((task) => task.id === taskId)
        if (!target) return
        // 同一份 SOP / 变量生成的多条任务在画廊里是一张卡，看过一次就整组都算看过
        const sameCard = (task: TaskRecord) =>
          target.sopJobId ? task.sopJobId === target.sopJobId : task.id === target.id
        const viewedAt = Date.now()
        const viewed: TaskRecord[] = []
        const nextTasks = tasks.map((task) => {
          // 已经看过的不要再写一遍，避免每次点开都刷一遍库
          if (!sameCard(task) || !isTaskUnread(task)) return task
          const next = { ...task, detailViewedAt: viewedAt }
          viewed.push(next)
          return next
        })
        if (!viewed.length) return
        set({ tasks: nextTasks })
        // 未读状态要跨重启保持，否则刷新后红点又全冒出来
        for (const task of viewed) void putTask(task)
      },
      lightboxImageId: null,
      lightboxImageList: [],
      lightboxCommentPrompt: null,
      setLightboxImageId: (lightboxImageId, list, commentPrompt = null) => {
        if (lightboxImageId) dismissAllTooltips()
        set({
          lightboxImageId,
          lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []),
          lightboxCommentPrompt: lightboxImageId ? commentPrompt : null,
        })
      },
      sketchBoard: null,
      setSketchBoard: (sketchBoard) => {
        if (sketchBoard) dismissAllTooltips()
        set({ sketchBoard })
      },
      showSettings: false,
      settingsTabRequest: null,
      setShowSettings: (showSettings, settingsTabRequest) => {
        if (showSettings) dismissAllTooltips()
        set({
          showSettings,
          ...(settingsTabRequest ? { settingsTabRequest } : {}),
          ...(!showSettings ? { settingsTabRequest: null } : {}),
        })
      },
      supportPromptOpen: false,
      supportPromptDismissed: false,
      supportPromptSkippedForImportedData: false,
      setSupportPromptOpen: (supportPromptOpen) => set({ supportPromptOpen }),
      dismissSupportPrompt: () => set({ supportPromptOpen: false, supportPromptDismissed: true }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        const toastMessage = getToastMessage(message, type)
        const toast = { message: toastMessage, type }
        set({ toast })
        setTimeout(() => {
          set((s) => (s.toast === toast ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },
    }),
    {
      name: 'gpt-image-playground',
      // 与 zustand 默认存储（window.localStorage）一致，但写满配额只告警不抛异常；客户端改用预加载到内存的 SQLite kv
      storage: createJSONStorage(() => isTauri ? tauriStorage : safeJsonStorage()),
      version: 2,
      migrate: migratePersistedState,
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

let lastStoredAgentConversations = useStore.getState().agentConversations
let agentConversationPersistRunning = false
let agentConversationPersistQueued = false

async function flushAgentConversationsToIndexedDB() {
  if (agentConversationPersistRunning) {
    agentConversationPersistQueued = true
    return
  }

  agentConversationPersistRunning = true
  try {
    do {
      agentConversationPersistQueued = false
      const conversations = useStore.getState().agentConversations
      await replaceStoredAgentConversations(conversations)
      lastStoredAgentConversations = conversations
    } while (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations)
  } finally {
    agentConversationPersistRunning = false
  }
}

useStore.subscribe((state) => {
  if (state.agentConversations === lastStoredAgentConversations) return
  if (!agentConversationPersistenceReady) {
    agentConversationPersistQueued = true
    return
  }
  void flushAgentConversationsToIndexedDB()
})

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

function getPersistableTask(task: TaskRecord): TaskRecord {
  const rawResponsePayload = getPersistableRawResponsePayload(task.rawResponsePayload)
  return rawResponsePayload === task.rawResponsePayload ? task : { ...task, rawResponsePayload }
}

function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbPutTask(getPersistableTask(task))
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && (task.apiProvider ?? 'openai') !== 'fal'
}

function isAsyncCustomProviderTask(settings: AppSettings, provider: string, hasInputImages: boolean) {
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!customProvider?.poll) return false
  const submitMapping = hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    ...createTaskErrorPatch(task, error, now),
    falRecoverable: false,
    elapsed: Math.max(0, now - (task.startedAt ?? task.createdAt)),
  })
  showTaskFailureNotification(task)
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - (task.startedAt ?? task.createdAt)))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds, profile))
    if (failed) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

function usesConcurrentImageRequests(settings: AppSettings, profile: ApiProfile, params: TaskParams, hasInputImages: boolean) {
  const n = params.n > 0 ? params.n : 1
  if (n <= 1) return false
  if (profile.provider === 'openai') {
    if (profile.apiMode === 'responses') return true
    return profile.apiMode === 'images' && (profile.codexCli || profile.streamImages)
  }
  return profile.provider !== 'fal' && profile.codexCli && !isAsyncCustomProviderTask(settings, profile.provider, hasInputImages)
}

export function taskHasOutputErrors(task: Pick<TaskRecord, 'outputErrors'>) {
  return Boolean(task.outputErrors?.length)
}

export function taskMatchesFilterStatus(task: TaskRecord, filterStatus: AppState['filterStatus']) {
  // 回收站任务已经在 trashedTasks 里，不在 tasks 中；这里再挡一次防御性过滤
  if (task.deletedAt) return false
  if (filterStatus === 'all') return true
  if (filterStatus === 'error') return task.status === 'error' || taskHasOutputErrors(task)
  return task.status === filterStatus
}

export function taskMatchesSearchQuery(task: TaskRecord, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  // 任务 ID 也能搜：卡片上复制的完整 id、或者手抄的「# 后面那几位」都要能定位到这张卡
  const idQuery = q.replace(/^#/, '').replace(/\s+/g, '')
  if (idQuery && task.id.toLowerCase().includes(idQuery)) return true
  const prompt = getTaskPromptText(task.prompt || '', task.inputImageIds.length).toLowerCase()
  const paramStr = JSON.stringify(task.params).toLowerCase()
  const errorStr = [task.error, ...(task.outputErrors ?? []).map((item) => item.error)].filter(Boolean).join('\n').toLowerCase()
  return prompt.includes(q) || paramStr.includes(q) || errorStr.includes(q)
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return
  const promptRewriteGuardMessage = settings.allowPromptRewrite
    ? '当前已允许模型改写优化提示词，因此不会额外加入不改写要求。'
    : '同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。'

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。${promptRewriteGuardMessage}`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getFalRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === 'fal' && task.apiProvider === 'fal') return taskProfile
  return null
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile && taskProfile.provider === task.apiProvider && taskProfile.provider !== 'openai' && taskProfile.provider !== 'fal') return taskProfile
  return null
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  if (!task.apiProfileId) return null
  const profile = normalized.profiles.find((item) => item.id === task.apiProfileId)
  // 任务记录的模型仍在配置的模型列表中时，沿用任务提交时的模型
  return profile ? resolveApiProfileModel(profile, task.apiModel) : null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: profile.apiProxy,
    profiles: normalized.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
}

function getAgentProfileValidationError(settings: AppSettings): { profile: ApiProfile | null; message: string } | null {
  const normalized = normalizeSettings(settings)
  const textProfile = getAgentTextApiProfile(normalized)
  if (!textProfile || textProfile.provider !== 'openai' || textProfile.apiMode !== 'responses') {
    return { profile: textProfile, message: 'Agent 模式需要使用支持 Responses API 的 OpenAI 兼容文本模型配置。' }
  }
  const textProfileError = validateApiProfile(textProfile)
  if (textProfileError) return { profile: textProfile, message: `文本模型 API 配置不完整：${textProfileError}` }

  if (normalized.agentApiConfigMode === 'hybrid') {
    const imageProfile = getAgentImageApiProfile(normalized)
    if (!imageProfile) return { profile: null, message: '图像模型 API 配置不存在，请在 Agent 配置页选择可用的图像模型配置。' }
    const imageProfileError = validateApiProfile(imageProfile)
    if (imageProfileError) return { profile: imageProfile, message: `图像模型 API 配置不完整：${imageProfileError}` }
  }

  return null
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null, model: string | null): ApiProfile | null {
  if (!profileId) return null
  const profile = normalizeSettings(settings).profiles.find((item) => item.id === profileId)
  return profile ? resolveApiProfileModel(profile, model ?? undefined) : null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function isNetworkRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof FetchConnectError) return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof FetchConnectError) return true
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiModeApiName(apiMode: ApiMode) {
  return apiMode === 'responses' ? 'Responses API' : 'Image API'
}

function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  usesApiProxy: boolean,
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages'> | null,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)

  // 客户端的连接错误已由 Rust 侧给出具体原因，只有兜底的“无法连接到服务器”仍追加通用提示；
  // 超时、域名解析等发生在建立连接时，与网关超时无关，只有连接被重置或未响应就关闭才可能是等待较久后被网关断开
  if (err instanceof FetchConnectError && !err.message.startsWith('无法连接到服务器')) {
    if (elapsedSeconds <= 15 || !/^(连接被服务器重置|服务器未返回响应就关闭了连接)/.test(err.message)) return null
  }

  if (elapsedSeconds <= 15) {
    // 客户端忽略已保存的代理设置
    if (usesApiProxy && !isTauri) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    const unsupportedApiHint = profile?.provider === 'openai'
      ? `\n· API 不支持 ${getApiModeApiName(profile.apiMode)}`
      : ''
    // 客户端不受跨域限制，不提示跨域原因
    const corsHint = isTauri ? '' : '\n· 接口不支持浏览器跨域请求，可使用 Docker 部署版或本地运行版并配置 API 代理解决'
    return `提示：请求立即失败，可能原因：\n· API 服务器不可达或地址有误，请检查 API URL 是否正确、服务是否正常运行${unsupportedApiHint}${corsHint}`
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return `提示：请求等待约 60 秒后被断开，这通常是 Nginx 等反向代理的默认超时，而非接口本身报错。可调大代理的超时时间（如 proxy_read_timeout），或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return `提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。${getTimeoutStreamingHint(profile)}`
  }

  return `提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearFalRecoveryTimer(taskId: string) {
  const timer = falRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  falRecoveryTimers.delete(taskId)
}

function scheduleFalRecovery(taskId: string, delayMs = FAL_RECOVERY_POLL_MS) {
  if (falRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    falRecoveryTimers.delete(taskId)
    recoverFalTask(taskId)
  }, delayMs)
  falRecoveryTimers.set(taskId, timer)
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(images: string[]): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
  sizes?: Array<{ width?: number; height?: number } | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  const withStoredSizes = images.map((_, index) => addImageSizeParam(preferred?.[index], sizes?.[index]))
  if (withStoredSizes.every(hasActualSizeParam)) {
    return withStoredSizes
  }
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) => {
    const params = withStoredSizes[index]
    const fallbackParams = fallback[index]
    if (hasActualSizeParam(params)) return params
    if (fallbackParams?.size) return { ...(params ?? {}), size: fallbackParams.size }
    return hasActualParams(params) ? params : fallbackParams
  })
}

async function completeRecoveredFalTask(task: TaskRecord, result: Awaited<ReturnType<typeof getFalQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done' || latest.error === AGENT_STOPPED_MESSAGE) return
  if (latest.status !== 'running' && !latest.falRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, sourceImages, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, result.actualParamsList, outputImageSizes)
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || latestBeforeUpdate.error === AGENT_STOPPED_MESSAGE || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.falRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    sourceImages,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    falRecoverable: false,
  })
  useStore.getState().showToast(`fal.ai 任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `fal.ai 任务已恢复，共 ${outputIds.length} 张图片。`)
  else void continueRecoveredAgentRound(task.id)
  const recoveredFalTask = useStore.getState().tasks.find((item) => item.id === task.id)
  if (recoveredFalTask) scheduleAutoDeliver(recoveredFalTask)
}

async function recoverFalTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.apiProvider !== 'fal' || !task.falRequestId || !task.falEndpoint || task.status === 'done') return

  const profile = getFalRecoveryProfile(settings, task)
  if (!profile) {
    scheduleFalRecovery(taskId)
    return
  }

  try {
    const result = await getFalQueuedImageResult(profile, task.falEndpoint, task.falRequestId, task.params)
    clearFalRecoveryTimer(taskId)
    await completeRecoveredFalTask(task, result)
    return
  } catch (err) {
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    if (isNetworkRecoverableError(err)) {
      scheduleFalRecovery(taskId)
      return
    }

    clearFalRecoveryTimer(taskId)
    const error = getFalErrorMessage(err) ?? (err instanceof Error ? err.message : String(err))
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, error, Date.now()),
      ...getRawErrorPayload(err),
      falRecoverable: false,
    })
    showTaskFailureNotification(task)
    if (isAgentTask(task)) void continueRecoveredAgentRound(taskId)
  }
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export async function initStore() {
  const legacyAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  const storedTasks = await getAllTasks()
  const storedAgentConversations = normalizeAgentConversations(await getAllAgentConversations())
  let loadedAgentConversations = mergePersistedAgentConversations(storedAgentConversations, legacyAgentConversations)
  const currentAgentConversations = normalizeAgentConversations(useStore.getState().agentConversations)
  loadedAgentConversations = mergePersistedAgentConversations(loadedAgentConversations, currentAgentConversations)
  const activeAgentConversationId = useStore.getState().activeAgentConversationId && loadedAgentConversations.some((conversation) => conversation.id === useStore.getState().activeAgentConversationId)
    ? useStore.getState().activeAgentConversationId
    : loadedAgentConversations[0]?.id ?? null
  if (loadedAgentConversations.length > 0 || legacyAgentConversations.length > 0) {
    useStore.setState((state) => {
      const agentInputDrafts = cleanStaleAgentInputDrafts(
        normalizeAgentInputDrafts(state.agentInputDrafts, loadedAgentConversations),
        activeAgentConversationId,
      )
      return {
        agentConversations: loadedAgentConversations,
        agentConversationsLoaded: true,
        activeAgentConversationId,
        agentInputDrafts,
        ...(state.appMode === 'agent' ? restoreAgentInputDraftState(agentInputDrafts, activeAgentConversationId) : {}),
      }
    })
    await replaceStoredAgentConversations(loadedAgentConversations)
  } else {
    useStore.setState({ agentConversationsLoaded: true })
  }
  const shouldRewritePersistedLocalState = agentConversationMigrationPending
  agentConversationPersistenceReady = true
  agentConversationMigrationPending = false
  if (agentConversationPersistQueued || useStore.getState().agentConversations !== lastStoredAgentConversations) {
    await flushAgentConversationsToIndexedDB()
  }
  if (shouldRewritePersistedLocalState) {
    useStore.setState({})
  }
  const { tasks: markedTasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks, Date.now())
  const interruptedTaskIds = new Set(interruptedTasks.map((task) => task.id))
  const favoriteState = useStore.getState()
  const normalizedFavorites = normalizeLoadedFavoriteState(markedTasks.map(getPersistableTask), favoriteState.favoriteCollections, favoriteState.defaultFavoriteCollectionId)
  const tasks = normalizedFavorites.tasks
  if (normalizedFavorites.collections !== favoriteState.favoriteCollections) {
    favoriteState.setFavoriteCollections(normalizedFavorites.collections)
  }
  if (normalizedFavorites.defaultFavoriteCollectionId !== favoriteState.defaultFavoriteCollectionId) {
    useStore.getState().setDefaultFavoriteCollectionId(normalizedFavorites.defaultFavoriteCollectionId)
  }
  await Promise.all(tasks
    .filter((task, index) => normalizedFavorites.changed || interruptedTaskIds.has(task.id) || task.rawResponsePayload !== markedTasks[index]?.rawResponsePayload)
    .map((task) => putTask(task)))
  // 回收站里的任务从主列表分离，主列表只保留未删除的
  useStore.getState().setTrashedTasks(tasks.filter((task) => Boolean(task.deletedAt)))
  useStore.getState().setTasks(tasks.filter((task) => !task.deletedAt))
  showSupportPromptForExistingLocalData(tasks)
  // 人工改判成不合格的图（结论落库），如果之前已经交付过，启动时把交付目录里那份撤掉。
  // 自动质检结论只在内存里，重启后拿不到，只能靠下一次质检触发。
  void pruneFailedDeliveredImages().catch((err) => console.warn('启动清理不合格交付文件失败：', err))
  // 客户端关闭确认用同样的判断跳过这些任务，它们重启后会继续查询结果
  for (const task of tasks) {
    if (isFalRecoverableTask(task)) scheduleFalRecovery(task.id, 0)
    if (isCustomRecoverableTask(task)) scheduleCustomRecovery(task.id, 0)
  }

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const state = useStore.getState()
  const persistedInputImages = state.inputImages
  const galleryInputDraft = state.galleryInputDraft
  const agentConversations = state.agentConversations
  const agentInputDrafts = state.agentInputDrafts
  for (const img of persistedInputImages) referencedIds.add(img.id)
  if (galleryInputDraft) {
    for (const img of galleryInputDraft.inputImages) referencedIds.add(img.id)
  }
  for (const draft of Object.values(agentInputDrafts)) {
    for (const img of draft.inputImages) referencedIds.add(img.id)
  }
  for (const conversation of agentConversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) referencedIds.add(id)
    }
  }
  for (const t of tasks) {
    addTaskReferencedImageIds(referencedIds, t)
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  // 只清「生成出来的」：用户上传的参考图是素材，重新找图比重新生成贵得多，
  // 而且任务卡的「复用配置」正靠这些图还原当时的输入。元数据取不到时也保留，宁可占点空间。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
      continue
    }
    const meta = await getImageMeta(imgId)
    if (meta?.source === 'generated' || meta?.source === 'mask') {
      await deleteImage(imgId)
    } else {
      referencedImageIds.push(imgId)
    }
  }
  void scheduleMissingThumbnailBackfill(referencedImageIds)
  // 网页版旧数据的原图和缩略图以 dataUrl 字符串保存，首屏加载后在后台逐条转成 Blob
  if (!isTauri) setTimeout(() => void migrateImagesToBlob(), 2_000)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push({ ...img, dataUrl: storedImage.dataUrl })
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }

  if (galleryInputDraft) {
    const restoredGalleryImages: InputImage[] = []
    for (const img of galleryInputDraft.inputImages) {
      if (img.dataUrl) {
        restoredGalleryImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredGalleryImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }
    const restoredGalleryDraft: AgentInputDraft = {
      ...galleryInputDraft,
      ...updateInputDraftImages(galleryInputDraft, restoredGalleryImages),
    }
    const shouldClearMask = galleryInputDraft.maskDraft !== restoredGalleryDraft.maskDraft
    const galleryDraftsChanged =
      restoredGalleryImages.length !== galleryInputDraft.inputImages.length ||
      restoredGalleryImages.some((img, index) => img.dataUrl !== galleryInputDraft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    if (galleryDraftsChanged) {
      const latestState = useStore.getState()
      const nextGalleryInputDraft = isEmptyAgentInputDraft(restoredGalleryDraft) ? null : restoredGalleryDraft
      useStore.setState({
        galleryInputDraft: nextGalleryInputDraft,
        ...(latestState.appMode === 'gallery'
          ? restoreGalleryInputDraftState(nextGalleryInputDraft)
          : {}),
      })
    }
  }

  const restoredAgentInputDrafts: Record<string, AgentInputDraft> = {}
  let agentDraftsChanged = false
  for (const [conversationId, draft] of Object.entries(agentInputDrafts)) {
    const restoredDraftImages: InputImage[] = []
    for (const img of draft.inputImages) {
      if (img.dataUrl) {
        restoredDraftImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredDraftImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }

    const restoredDraft: AgentInputDraft = {
      ...draft,
      ...updateInputDraftImages(draft, restoredDraftImages),
    }
    const shouldClearMask = draft.maskDraft !== restoredDraft.maskDraft
    if (!isEmptyAgentInputDraft(restoredDraft)) restoredAgentInputDrafts[conversationId] = restoredDraft
    if (
      restoredDraftImages.length !== draft.inputImages.length ||
      restoredDraftImages.some((img, index) => img.dataUrl !== draft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    ) {
      agentDraftsChanged = true
    }
  }
  if (agentDraftsChanged) {
    const latestState = useStore.getState()
    useStore.setState({
      agentInputDrafts: restoredAgentInputDrafts,
      ...(latestState.appMode === 'agent'
        ? restoreAgentInputDraftState(restoredAgentInputDrafts, latestState.activeAgentConversationId)
        : {}),
    })
  }
}

/** 提交新任务的选项 */
interface SubmitOptions {
  allowFullMask?: boolean
  useCurrentApiProfileWhenReusedMissing?: boolean
  promptPrefix?: string
}

/**
 * 一次提交用到的全部输入快照。
 *
 * 排队重放靠它还原「当初提交的内容」，不受输入框后续改动影响：
 * 排队期间用户可能已经在写下一批提示词、换图、切归属方向。
 */
interface SubmitInput {
  settings: AppSettings
  prompt: string
  /**
   * 提交瞬间「本次文案」那一栏的内容。
   * 排队执行时用户可能已经改了它，所以跟 prompt 一样要快照下来。
   */
  customCopy: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  params: TaskParams
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  reusedTaskApiModel: string | null
  /** 归属方向：取提交瞬间的「当前归属」，排队执行时不能按那时的界面状态改判 */
  directionId: string
  /** 渠道来源，同样取提交瞬间 */
  channel: string | null
  sopMode: boolean
  variableMode: boolean
  plainImageMode: PlainImageMode
  fixedImages: InputImage[]
}

function captureSubmitInput(): SubmitInput {
  const state = useStore.getState()
  const sop = useSopStore.getState()
  return {
    settings: state.settings,
    prompt: state.prompt,
    customCopy: state.customCopy,
    inputImages: state.inputImages,
    maskDraft: state.maskDraft,
    params: state.params,
    reusedTaskApiProfileId: state.reusedTaskApiProfileId,
    reusedTaskApiProfileName: state.reusedTaskApiProfileName,
    reusedTaskApiProfileMissing: state.reusedTaskApiProfileMissing,
    reusedTaskApiModel: state.reusedTaskApiModel,
    directionId: sop.activeDirectionId,
    channel: state.channelFilter,
    sopMode: sop.sopMode,
    variableMode: sop.variableMode,
    plainImageMode: state.plainImageMode,
    fixedImages: state.fixedImages,
  }
}

/** 待提交队列：批量进行中再提交先排在这里，当前批结束自动依次开始 */
interface PendingSubmission {
  options: SubmitOptions
  input: SubmitInput
}
const pendingSubmissions: PendingSubmission[] = []
/** 正在执行的提交数（存图、遮罩校验那段 await 也算），防连点重复提交 */
let inFlightSubmissions = 0

function syncQueuedSubmitCount() {
  useStore.getState().setQueuedSubmitCount(pendingSubmissions.length)
}

/** 排到队尾后清空输入框，与「提交成功」一致：否则会以为没发出去而反复点 */
function clearInputAfterQueued(settings: AppSettings) {
  const state = useStore.getState()
  if (settings.clearInputAfterSubmit) {
    state.setPrompt('')
    state.clearInputImages()
    state.clearFixedImages()
  }
  state.setReusedTaskApiProfile(null)
}

/**
 * 提交新任务。
 *
 * 批量进行中不直接执行，先排队：打断正在跑的批会让它少出几张，
 * 多批同时跑又会把渠道并发打满、触发限流。
 */
export async function submitTask(options: SubmitOptions = {}, replayInput?: SubmitInput) {
  const input = replayInput ?? captureSubmitInput()
  const state = useStore.getState()
  const busy = Boolean(state.batchProgress) || inFlightSubmissions > 0
  const disposition = submissionDisposition({ busy, queued: pendingSubmissions.length })
  if (disposition === 'reject') {
    state.showToast(`排队已满（${MAX_PENDING_SUBMISSIONS} 个提交），等前面的跑完再提交`, 'error')
    return
  }
  if (disposition === 'queue') {
    pendingSubmissions.push({ options, input })
    syncQueuedSubmitCount()
    state.showToast(`已排到队尾：${queuePositionLabel(pendingSubmissions.length)}`, 'success')
    clearInputAfterQueued(input.settings)
    return
  }
  await executeSubmit(options, input)
}

/** 取下一个排队提交执行；正在跑或队列空时什么也不做 */
function drainPendingSubmissions() {
  if (inFlightSubmissions > 0) return
  if (useStore.getState().batchProgress) return
  const next = pendingSubmissions.shift()
  if (!next) return
  syncQueuedSubmitCount()
  void executeSubmit(next.options, next.input)
}

/** 清空待提交队列（清空数据时用，避免排队的任务在清空后又冒出来） */
export function clearPendingSubmissions() {
  if (!pendingSubmissions.length) return
  pendingSubmissions.length = 0
  syncQueuedSubmitCount()
}

/** 执行体：走到这里说明轮到自己了，不再判断排队 */
async function executeSubmit(options: SubmitOptions, input: SubmitInput) {
  inFlightSubmissions += 1
  try {
    await runSubmitTask(options, input)
  } finally {
    inFlightSubmissions -= 1
    // 确认弹窗会递归进第二次 executeSubmit，计数归零才轮到队列
    if (inFlightSubmissions === 0) drainPendingSubmissions()
  }
}

async function runSubmitTask(options: SubmitOptions, input: SubmitInput) {
  const { settings, prompt, inputImages, maskDraft, params, reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, reusedTaskApiModel } = input
  const { showToast, setConfirmDialog } = useStore.getState()

  const normalizedSettings = normalizeSettings(settings)
  let activeProfile = getActiveApiProfile(settings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId, reusedTaskApiModel)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${activeProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        // 确认后接着跑同一次提交，输入快照不变
        void executeSubmit({ ...options, useCurrentApiProfileWhenReusedMissing: true }, input)
      },
        })
        return
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  if (validateApiProfile(activeProfile)) {
    showToast(`请先完善请求 API 配置：${validateApiProfile(activeProfile)}`, 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  const batchPrompts = normalizedSettings.showBatchPrompt && normalizedSettings.batchPromptEnabled ? splitBatchPrompts(prompt) : []

  /**
   * 发送前文字校对（普通模式）。
   *
   * 放在 beginBatch 之前：被拦下时不能留下一个「正在跑」的批量状态。
   * 普通模式的卖点只是拼在提示词前面的文字、不要求变成画面文案，
   * 所以这里不带 copyText，只查违规词与违规内容。
   */
  const proofreadText = options.promptPrefix?.trim()
    ? `${options.promptPrefix.trim()}\n\n${prompt.trim()}`
    : prompt.trim()
  const proofread = await proofreadPrompts({
    profile: activeProfile,
    prompts: [proofreadText],
    enabled: normalizedSettings.promptProofread !== false,
  })
  if (proofread.blocks.length) {
    showToast(`提示词没通过校对，未发送：${proofread.blocks[0].reasons.join('；')}`, 'error')
    return
  }
  for (const note of proofread.notes) showToast(note, 'info')

  // 排队在 submitTask 入口就处理了：能走到这里说明当前没有批在跑，直接占位开跑
  const batchId = batchPrompts.length ? beginBatch(batchPrompts.length) : 0

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void executeSubmit({ allowFullMask: true }, input)
          },
        })
        endBatch(batchId)
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      endBatch(batchId)
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  try {
    for (const img of orderedInputImages) {
      await storeImage(img.dataUrl)
    }
  } catch (err) {
    console.error('保存参考图失败', err)
    endBatch(batchId)
    showToast(`保存参考图失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    return
  }

  /**
   * 普通模式带参考图时，「数量」是拆成几个请求（每个请求固定 n=1），
   * 这时候不该按渠道的单请求上限（OpenAI 10 / fal 4）收，否则批量想跑 100 张直接被砍到 10。
   * 纯文生图、批量提示词这两条路径会把 n 原样发给渠道，仍然按渠道上限收。
   */
  const countsRequests = !batchPrompts.length
    && !input.sopMode
    && !input.variableMode
    && (orderedInputImages.length > 0 || input.fixedImages.length > 0)
  const normalizedParams = normalizeParamsForSettings(params, requestSettings, {
    hasInputImages: orderedInputImages.length > 0,
    countsRequests,
  })
  const shouldUseTransparentOutput = (normalizedParams.output_format === 'png' || normalizedParams.output_format === 'webp') && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const normalizedParamPatch = getChangedParams(params, taskParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  // 普通模式拆请求时也要算进批量：否则 10 个请求会弹 10 次完成提示、自动打开 10 次详情
  let requestBatchId = batchId
  const startTask = async (
    taskPrompt: string,
    images: InputImage[] = orderedInputImages,
    n?: number,
    /** 拆分出来的请求共享一个 sopJobId，画廊里才会聚合成一张任务卡 */
    meta?: Pick<TaskRecord, 'sopJobId' | 'sopPromptIndex' | 'sopName'>,
    /** 单个请求的尺寸覆盖：批量模式按各自参考图比例取基准尺寸 */
    sizeOverride?: string,
    /**
     * 发送瞬间的输入框状态快照，供「复用配置」还原。
     * 拆分出的多个请求共用同一份（它们来自同一次发送）。
     */
    snapshot?: TaskInputSnapshot,
  ) => {
    const paramsForTask: TaskParams = {
      ...(n == null ? taskParams : { ...taskParams, n }),
      // codex CLI 渠道本来就会被压到 1K，覆盖值也照它的规则收一次，别塞超限尺寸
      ...(sizeOverride ? { size: activeProfile.codexCli ? normalizeCodexCliImageSize(sizeOverride) : sizeOverride } : {}),
    }
    const transparentMeta = paramsForTask.transparent_output && activeProfile.transparentBackgroundMethod === 'local'
      ? createTransparentOutputMeta(taskPrompt)
      : null
    const task: TaskRecord = {
      id: genId(),
      prompt: taskPrompt,
      params: paramsForTask,
      apiProvider: activeProfile.provider,
      apiProfileId: activeProfile.id,
      apiProfileName: activeProfile.name,
      apiMode: activeProfile.apiMode,
      apiModel: activeProfile.model,
      inputImageIds: images.map((i) => i.id),
      maskTargetImageId,
      maskImageId,
      transparentOutput: transparentMeta?.transparentOutput,
      transparentPrompt: transparentMeta?.effectivePrompt,
      outputImages: [],
      status: 'running',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
      // 归属取「当前归属」而不是「正在筛选的节点」：
      // 点「未归属」筛选时 activeFilterId 是 __unassigned__ 这种视图标记，
      // 写进任务会变成一个查不到节点的脏方向；点类目筛选也不该把图挂到分组容器上。
      // 归属与渠道都取提交瞬间的快照：排队执行时界面可能已经切到别的方向/渠道
      sopDirectionId: input.directionId || undefined,
      // 卖点名快照：命名模板 {point} 用，之后换卖点不会把旧卡的名字改掉
      sopPointName: pointNameForTask(input.directionId) || undefined,
      channel: channelForNewTask(input.channel),
      // 恢复输入框用；同一批拆出的请求共用同一份快照
      inputSnapshot: snapshot,
      ...(meta ? {
        sopJobId: meta.sopJobId,
        sopPromptIndex: meta.sopPromptIndex,
        sopName: meta.sopName,
      } : {}),
    }

    useStore.getState().setTasks([task, ...useStore.getState().tasks])
    await putTask(task)
    if (requestBatchId) batchTaskIds.add(task.id)
    // 异步调用 API
    executeTask(task.id)
    return task.id
  }

  // 普通模式：数量 = 请求次数。融图把变量图切成 N 组、每组再带全部固定图；
  // 批量每个请求一张变量图，不够就循环取。批量提示词模式不叠加这套拆分。
  const finalPrompt = options.promptPrefix?.trim()
    ? `${options.promptPrefix.trim()}\n\n${prompt.trim()}`
    : prompt.trim()
  const plainPlan = !input.sopMode && !input.variableMode && !batchPrompts.length
    ? planPlainRequests({
        mode: input.plainImageMode,
        count: taskParams.n,
        variableImages: orderedInputImages,
        fixedImages: input.fixedImages,
      })
    : null

  if (plainPlan) {
    const planBatchId = beginBatch(plainPlan.length)
    requestBatchId = planBatchId
    // 同一批拆分请求共用一个 jobId，画廊与详情页按它聚合成一张任务卡
    const planJobId = `plain-${genId()}`
    const planImageMode = input.plainImageMode
    const planModeLabel = planImageMode === 'merge' ? '融图' : '批量'
    /**
     * 发送前快照：按分池记录，复用配置时才分得清哪几张进固定图区。
     * 这里用 prompt（用户原文）而不是 finalPrompt，避免把提交时拼上的
     * 卖点 / 风格前缀也写回输入框。
     */
    const plainSnapshot: TaskInputSnapshot = {
      mode: 'plain',
      prompt: prompt.trim(),
      plainImageMode: planImageMode,
      fixedImageIds: input.fixedImages.map((img) => img.id),
      variableImageIds: orderedInputImages.map((img) => img.id),
      customCopy: input.customCopy?.trim() || undefined,
    }
    // 批量模式每个请求只带一张参考图。尺寸填 auto 又横竖混排时，渠道会把画幅统一成一个，
    // 所以同批参考图比例不一致时，按各请求自己那张图的比例取 2K 基准尺寸；
    // 比例都一样就保持 auto 不动。融图一个请求里有多张图，比例不唯一，也保持 auto。
    const sizeOverrides = planModeLabel === '批量' && taskParams.size === 'auto'
      ? sizeOverridesForMixedRatios(plainPlan.map((item) => item.images[0]?.dataUrl ?? ''))
      : null
    const limit = normalizedSettings.batchPromptConcurrencyLimited
      ? Math.max(1, normalizedSettings.batchPromptConcurrency)
      : plainPlan.length
    let settled = 0
    useStore.getState().setBatchProgress({ total: plainPlan.length, started: 0, finished: 0 })
    await runWithConcurrency(
      plainPlan,
      limit,
      async (item, index) => {
        try {
          const sizeOverride = sizeOverrides ? sizeOverrides[index] : undefined
          const taskId = await startTask(finalPrompt, item.images, 1, {
            sopJobId: planJobId,
            sopPromptIndex: index + 1,
            sopName: planModeLabel,
          }, sizeOverride, plainSnapshot)
          await waitForTaskSettled(taskId, () => planBatchId !== activeBatchId)
        } catch (err) {
          console.error('提交图片请求失败', err)
        }
        settled += 1
        useStore.getState().setBatchProgress({ total: plainPlan.length, started: settled, finished: settled })
      },
      () => planBatchId !== activeBatchId,
    )
    if (planBatchId === activeBatchId) {
      endBatch(planBatchId)
      const modeLabel = planModeLabel
      const usedCount = plainPlan.reduce((sum, item) => sum + item.images.length, 0)
      // 批量模式下数量就是请求次数，图多出来时要说清楚，否则像是把图吞了
      const unused = input.plainImageMode === 'batch'
        ? Math.max(0, new Set(orderedInputImages.map((item) => item.id)).size - plainPlan.length)
        : 0
      // 尺寸被逐个改写时要说一句，否则用户会疑惑「明明选了自动」
      const sizeNote = sizeOverrides ? '；参考图横竖比例不同，已按各图比例取 2K 尺寸' : ''
      useStore.getState().showToast(
        `已提交 ${plainPlan.length} 个请求（${modeLabel}，共 ${usedCount} 张图）${unused > 0 ? `；还有 ${unused} 张图没用上，调高数量或切融图` : ''}${sizeNote}`,
        'success',
      )
    }
    if (settings.clearInputAfterSubmit) {
      useStore.getState().setPrompt('')
      useStore.getState().clearInputImages()
      useStore.getState().clearFixedImages()
    }
    useStore.getState().setReusedTaskApiProfile(null)
    return
  }

  if (batchPrompts.length) {
    useStore.getState().showToast(`已开始批量提交 ${batchPrompts.length} 条提示词`, 'success')
  } else {
    /**
     * 走到这里说明没有走上面的分池拆分：要么是纯文生图（没有参考图），
     * 要么是批量提示词。这些情况仍记一份快照，复用配置时至少能把提示词、
     * 发图方式和当时的图片分池还原回输入框。
     */
    const fallbackSnapshot: TaskInputSnapshot = {
      mode: 'plain',
      prompt: prompt.trim(),
      plainImageMode: input.plainImageMode,
      fixedImageIds: input.fixedImages.map((img) => img.id),
      variableImageIds: orderedInputImages.map((img) => img.id),
      customCopy: input.customCopy?.trim() || undefined,
    }
    await startTask(finalPrompt, undefined, undefined, undefined, undefined, fallbackSnapshot)
    useStore.getState().showToast('任务已提交', 'success')
  }

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  useStore.getState().setReusedTaskApiProfile(null)

  if (batchPrompts.length) {
    const limit = normalizedSettings.batchPromptMode === 'queue'
      ? 1
      : normalizedSettings.batchPromptConcurrencyLimited ? normalizedSettings.batchPromptConcurrency : batchPrompts.length
    await runBatchPrompts(batchId, batchPrompts, limit, startTask)
  }
}

// 当前批量的标识，停止或结束时递增使旧批量失效；批量任务不单独弹出完成提示和失败详情
let activeBatchId = 0
const batchTaskIds = new Set<string>()

function beginBatch(total: number) {
  activeBatchId += 1
  useStore.getState().setBatchProgress({ total, started: 0, finished: 0 })
  return activeBatchId
}

function endBatch(batchId: number) {
  if (!batchId || batchId !== activeBatchId) return
  activeBatchId += 1
  // 停止后仍在运行的任务恢复单独的完成提示和失败详情
  batchTaskIds.clear()
  useStore.getState().setBatchProgress(null)
  // 当前批跑完或被停止后，排队中的提交依次开始
  queueMicrotask(drainPendingSubmissions)
}

/** 等待任务结束（完成、失败或被删除）或批量被停止；断线待恢复的任务也视为结束，避免卡住队列 */
function waitForTaskSettled(taskId: string, isCancelled: () => boolean) {
  const isSettled = (tasks: TaskRecord[]) => isCancelled() || tasks.find((item) => item.id === taskId)?.status !== 'running'
  return new Promise<void>((resolve) => {
    if (isSettled(useStore.getState().tasks)) {
      resolve()
      return
    }
    const unsubscribe = useStore.subscribe((state) => {
      if (!isSettled(state.tasks)) return
      unsubscribe()
      resolve()
    })
  })
}

async function runBatchPrompts(
  batchId: number,
  prompts: string[],
  limit: number,
  startTask: (
    taskPrompt: string,
    images?: InputImage[],
    n?: number,
    meta?: Pick<TaskRecord, 'sopJobId' | 'sopPromptIndex' | 'sopName'>,
    sizeOverride?: string,
    snapshot?: TaskInputSnapshot,
  ) => Promise<string>,
) {
  const isStopped = () => batchId !== activeBatchId
  const total = prompts.length
  let started = 0
  let finished = 0
  let failed = 0
  await runWithConcurrency(prompts, limit, async (taskPrompt) => {
    started += 1
    useStore.getState().setBatchProgress({ total, started, finished })
    try {
      /**
       * 批量提示词每条各自是一条任务：快照里的 prompt 用该条提示词，
       * 复用配置时才能还原到「当时发的这一条」，而不是整段多行文本。
       */
      const snapshot: TaskInputSnapshot = {
        mode: 'plain',
        prompt: taskPrompt.trim(),
        plainImageMode: useStore.getState().plainImageMode,
        fixedImageIds: useStore.getState().fixedImages.map((img) => img.id),
        variableImageIds: useStore.getState().inputImages.map((img) => img.id),
        customCopy: useStore.getState().customCopy.trim() || undefined,
      }
      const taskId = await startTask(taskPrompt, undefined, undefined, undefined, undefined, snapshot)
      await waitForTaskSettled(taskId, isStopped)
      if (useStore.getState().tasks.find((item) => item.id === taskId)?.status === 'error') failed += 1
    } catch (err) {
      failed += 1
      console.error('批量提交任务失败', err)
    }
    finished += 1
    if (!isStopped()) useStore.getState().setBatchProgress({ total, started, finished })
  }, isStopped)
  if (isStopped()) return

  endBatch(batchId)
  const message = failed > 0 ? `批量生成完成：成功 ${total - failed} 条，失败 ${failed} 条` : `批量生成完成，共 ${total} 条`
  useStore.getState().showToast(message, failed > 0 ? 'error' : 'success')
  showTaskCompletionNotification('批量生成完成', `${message}。`)
}

/** 停止批量提交：立即结束批量状态，不再启动剩余提示词，已开始的任务继续执行 */
export function stopBatchPrompts() {
  const progress = useStore.getState().batchProgress
  if (!progress) return
  // 点「停止」就是要全停：排队中的提交也一并取消，否则会接着烧额度
  const queued = pendingSubmissions.length
  clearPendingSubmissions()
  endBatch(activeBatchId)
  useStore.getState().showToast(
    `已停止批量提交，共提交 ${progress.started} / ${progress.total} 条，已开始的任务会继续完成${queued > 0 ? `；已取消 ${queued} 个排队提交` : ''}`,
    'info',
  )
}

function getActiveAgentConversation(): AgentConversation {
  const state = useStore.getState()
  const existing = state.agentConversations.find((conversation) => conversation.id === state.activeAgentConversationId)
  if (existing) return existing

  const id = state.createAgentConversation()
  return useStore.getState().agentConversations.find((conversation) => conversation.id === id)!
}

function updateAgentConversation(conversationId: string, updater: (conversation: AgentConversation) => AgentConversation) {
  useStore.setState((state) => ({
    agentConversations: state.agentConversations.map((conversation) =>
      conversation.id === conversationId ? updater(conversation) : conversation,
    ),
  }))
}

function getAgentRoundControllerKey(conversationId: string, roundId: string) {
  return `${conversationId}:${roundId}`
}

function getDeletedActiveAgentTasks(conversationId: string, roundId: string, controller: AbortController) {
  return Array.from(deletedActiveAgentTasks.values())
    .filter((entry) => entry.controller === controller && entry.task.agentConversationId === conversationId && entry.task.agentRoundId === roundId)
    .map((entry) => entry.task)
}

function createAgentAbortError() {
  return new DOMException('Agent 请求已停止', 'AbortError')
}

function createAgentRecoveryPauseError() {
  const err = new Error('Agent recovery paused')
  err.name = AGENT_RECOVERY_PAUSE_ERROR
  return err
}

function isAgentRecoveryPauseError(err: unknown) {
  return err instanceof Error && err.name === AGENT_RECOVERY_PAUSE_ERROR
}

function appendAgentStoppedMessage(content: string) {
  const trimmed = content.trimEnd()
  if (!trimmed) return AGENT_STOPPED_MESSAGE
  if (trimmed.endsWith(AGENT_STOPPED_MESSAGE)) return trimmed
  return `${trimmed}\n\n${AGENT_STOPPED_MESSAGE}`
}

function markAgentRoundTasksStopped(conversationId: string, roundId: string, now = Date.now()) {
  const runningTasks = useStore.getState().tasks.filter((task) =>
    (task.status === 'running' || task.falRecoverable || task.customRecoverable) &&
    task.agentConversationId === conversationId &&
    task.agentRoundId === roundId,
  )

  for (const task of runningTasks) {
    clearFalRecoveryTimer(task.id)
    clearCustomRecoveryTimer(task.id)
    updateTaskInStore(task.id, {
      ...createTaskErrorPatch(task, AGENT_STOPPED_MESSAGE, now),
      falRecoverable: false,
      customRecoverable: false,
      elapsed: Math.max(0, now - (task.startedAt ?? task.createdAt)),
    })
  }
  return runningTasks.length > 0
}

function markAgentRoundTasksFailed(
  conversationId: string,
  roundId: string,
  error: string,
  rawResponsePayload?: string,
  shouldFailTask: (task: TaskRecord) => boolean = () => true,
  now = Date.now(),
) {
  const runningTasks = useStore.getState().tasks.filter((task) =>
    task.status === 'running' &&
    task.agentConversationId === conversationId &&
    task.agentRoundId === roundId &&
    shouldFailTask(task),
  )

  for (const task of runningTasks) {
    useStore.getState().setTaskStreamPreview(task.id)
    updateTaskInStore(task.id, {
      ...createTaskErrorPatch(task, error, now),
      ...(rawResponsePayload ? { rawResponsePayload } : {}),
      falRecoverable: false,
      customRecoverable: false,
      elapsed: Math.max(0, now - (task.startedAt ?? task.createdAt)),
    })
  }
  return runningTasks.length > 0
}

function markAgentRoundStopped(conversationId: string, roundId: string) {
  const now = Date.now()
  const stoppedTasks = markAgentRoundTasksStopped(conversationId, roundId, now)
  let stoppedRound = false
  updateAgentConversation(conversationId, (current) => {
    const round = current.rounds.find((item) => item.id === roundId)
    if (!round || round.status !== 'running') return current

    stoppedRound = true
    const existingAssistantMessage = current.messages.find((message) => message.roundId === roundId && message.role === 'assistant')
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    return {
      ...current,
      updatedAt: now,
      rounds: current.rounds.map((item) =>
        item.id === roundId
          ? {
              ...item,
              ...(assistantMessageId ? { assistantMessageId } : {}),
              status: 'error',
              error: AGENT_STOPPED_MESSAGE,
              finishedAt: now,
            }
          : item,
      ),
      messages: existingAssistantMessage
        ? current.messages.map((message) =>
            message.id === existingAssistantMessage.id
              ? { ...message, content: appendAgentStoppedMessage(message.content) }
              : message,
          )
        : [
            ...current.messages,
            {
              id: assistantMessageId,
              role: 'assistant',
              content: AGENT_STOPPED_MESSAGE,
              roundId,
              createdAt: now,
            },
          ],
    }
  })
  return stoppedRound || stoppedTasks
}

function appendAgentAssistantMessageContent(conversationId: string, messageId: string, delta: string) {
  if (!delta) return
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: Date.now(),
    messages: current.messages.map((message) =>
      message.id === messageId
        ? { ...message, content: `${message.content}${delta}` }
        : message,
    ),
  }))
}

async function generateAgentConversationTitle(
  conversationId: string,
  prompt: string,
  inputImageIds: string[],
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
  fallbackTitle: string,
) {
  useStore.setState((state) => {
    const next = { ...state.agentGeneratingTitleIds, [conversationId]: true as const }
    return { agentGeneratingTitleIds: next }
  })
  try {
    const imageDataUrls = await readAgentImageDataUrls(inputImageIds)
    const title = await callAgentConversationTitleApi({
      settings: requestSettings,
      profile: activeProfile,
      prompt,
      imageDataUrls,
    })
    if (!title || title === fallbackTitle) return

    updateAgentConversation(conversationId, (current) => {
      const firstRound = current.rounds[0]
      if (!firstRound || stripImageMentionMarkers(firstRound.prompt) !== prompt || current.title !== fallbackTitle) return current
      return { ...current, title, updatedAt: Date.now() }
    })
  } catch {
    // Title generation is best-effort; keep the local fallback title on failure.
  } finally {
    useStore.setState((state) => {
      const next = { ...state.agentGeneratingTitleIds }
      delete next[conversationId]
      return { agentGeneratingTitleIds: next }
    })
  }
}

export function stopAgentResponse(conversationId = useStore.getState().activeAgentConversationId) {
  if (!conversationId) return
  const conversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
  if (!conversation) return
  const activeRunningRound = [...getActiveAgentRounds(conversation)].reverse().find((round) => round.status === 'running')
  const runningRound = activeRunningRound ?? conversation.rounds.find((round) => round.status === 'running')
  if (!runningRound) return

  const controller = agentRoundControllers.get(getAgentRoundControllerKey(conversationId, runningRound.id))
  if (controller) {
    controller.abort()
    if (markAgentRoundStopped(conversationId, runningRound.id)) {
      useStore.getState().showToast('已停止生成', 'info')
    }
    return
  }

  markAgentRoundStopped(conversationId, runningRound.id)
  useStore.getState().showToast('已停止生成', 'info')
}

function addAgentReferencedImageIds(target: Set<string>, conversations = useStore.getState().agentConversations, inputDrafts = useStore.getState().agentInputDrafts) {
  for (const conversation of conversations) {
    for (const round of conversation.rounds) {
      for (const id of round.inputImageIds) target.add(id)
      if (round.maskImageId) target.add(round.maskImageId)
    }
    for (const message of conversation.messages) {
      if (message.maskImageId) target.add(message.maskImageId)
    }
  }
  for (const draft of Object.values(inputDrafts)) {
    for (const img of draft.inputImages) target.add(img.id)
  }
}

function addInputDraftReferencedImageIds(target: Set<string>, draft: AgentInputDraft | null) {
  if (!draft) return
  for (const img of draft.inputImages) target.add(img.id)
}

function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  for (const id of task.outputImages || []) target.add(id)
  // AI 原图单独存着（派发、再次后处理都要用），不能因为成品换了内容就当孤儿图删掉
  for (const id of task.sourceImages || []) {
    if (id) target.add(id)
  }
  /**
   * 参考图 / 变量图只记在这个字段里（SOP 模式 inputImageIds 是空的），
   * 漏了它们，下次启动清理孤儿图时会把它们删掉 ——
   * 表现就是「复用配置」还原不出当时的参考图。
   */
  for (const id of task.sopReferenceImageIds || []) {
    if (id) target.add(id)
  }
  if (task.variableImageId) target.add(task.variableImageId)
  for (const id of task.variableFixedImageIds || []) {
    if (id) target.add(id)
  }
  for (const id of task.transparentOriginalImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.streamPartialImageIds || []) target.add(id)
}

/**
 * 删任务时可以清理的图片候选：只收「生成出来的」。
 *
 * 用户上传的参考图 / 固定图 / 变量图不放进来 —— 它们是素材，删了就得重新找，
 * 而且下次拿同一批图复用配置还要用。清理只针对成品、AI 原图、透明底原图这些可再生的。
 */
function addTaskCleanupImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.sourceImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.transparentOriginalImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.streamPartialImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
}

/**
 * 提交瞬间的卖点名快照（方向没配就继承产品）。
 *
 * 存在任务上而不是交付时再解析：卖点是「按方向记上一次使用」的，
 * 之后换了卖点再交付旧卡，文件夹名会写成别的卖点。
 */
function pointNameForTask(directionId?: string): string {
  const sop = useSopStore.getState()
  return pointNameForDirection(sop.directions, sop.presets, directionId, sop.lastPick, sop.defaultPick)
}

/** 成品图落盘的文件夹名：一个任务卡一个文件夹，命名沿用设置里的任务文件夹模板 */
function finishedFolderFor(task: TaskRecord): string {
  const sop = useSopStore.getState()
  const settings = useStore.getState().settings
  const productId = productIdForDirection(sop.directions, task.sopDirectionId)
  return finishedFolderName(task, sop.directions, settings.taskFolderTemplate, settings.taskFolderCustom, productId)
}

/**
 * 交付上下文：三级交付地址、业务树、命名模板，以及兜底的默认保存地址。
 *
 * 兜底地址只在「三级都没配交付地址」时才用；文件保存位置设成「每次询问」时
 * 没有默认地址可取，此时宁可跳过自动交付，也不弹一个没人点的保存对话框。
 */
async function buildDeliverContext(): Promise<Parameters<typeof deliverTaskCard>[1]> {
  const sop = useSopStore.getState()
  const settings = useStore.getState().settings
  let fallbackDir: string | undefined
  if (isTauri && settings.saveLocationMode === 'default') {
    try {
      fallbackDir = await getDefaultSaveDir()
    } catch (err) {
      console.warn('读取默认保存地址失败，自动交付将回退到已配置的交付地址', err)
    }
  }
  return {
    tasks: useStore.getState().tasks,
    directions: sop.directions,
    deliveryDirs: sop.deliveryDirs,
    template: settings.taskFolderTemplate,
    custom: settings.taskFolderCustom,
    fallbackDir,
    claimCardFolder: claimCardDeliverFolder,
  }
}

/**
 * 记下这张卡占用的交付文件夹名。
 *
 * 同一套配置跑两次会得到两张内容一样的卡，按命名模板算出来的文件夹名也一样，交付时就会互相覆盖。
 * 先交付的那张把名字记下来（同卡各任务都记一份），后来的卡在 resolveCardFolderName 里
 * 看到它已占用，自动改用 `-02`、`-03`；重交付自己时仍认这个名字，不会越交越多。
 *
 * 导出是为了让单测能直接验证占位确实落到任务上。
 */
export function claimCardDeliverFolder(cardKey: string, folder: string) {
  const targets = useStore.getState().tasks.filter((item) => (
    cardKeyOf(item) === cardKey && item.deliverFolder !== folder
  ))
  if (!targets.length) return
  const ids = new Set(targets.map((item) => item.id))
  useStore.setState((state) => ({
    tasks: state.tasks.map((item) => (ids.has(item.id) ? { ...item, deliverFolder: folder } : item)),
  }))
  for (const item of targets) void putTask({ ...item, deliverFolder: folder })
}

/**
 * 单条提示词完成后自动交付它自己的那几张图。
 *
 * 用 fire-and-forget：交付是「复制一份到外部目录」，不该拖慢任务转成 done 的时机；
 * 失败也只提示，不回滚任务状态。
 */
function scheduleAutoDeliver(task: TaskRecord) {
  const settings = useStore.getState().settings
  if (!settings.autoDeliver) return
  if (!isTauri) return
  // 进回收站的任务不交付
  if (task.deletedAt) return
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest) return
  void (async () => {
    try {
      const context = await buildDeliverContext()
      const result = await deliverTaskCard(latest, context)
      recordDeliveredFiles(result.files, result.dir)
      reportDeliverResult(result)
    } catch (err) {
      console.error('自动交付失败：', err)
    }
  })()
}

/** 交付结果的统一提示：失败给原因，成功给落点 */
function reportDeliverResult(result: DeliverResult) {
  const { showToast } = useStore.getState()
  if (result.ok) {
    const where = result.location ?? result.folder ?? '交付地址'
    // 张数对不上要直接说，否则用户看到「已交付 1 张」会以为是命令中断
    if (result.expected && result.written < result.expected) {
      showToast(`已交付 ${result.written} 张到 ${where}，另有 ${result.expected - result.written} 张读取失败`, 'error')
      return
    }
    showToast(`已交付 ${result.written} 张到 ${where}`, 'success')
    return
  }
  if (result.noTarget) {
    showToast('未配置交付地址，也没设置默认保存地址，这次没有自动交付', 'info')
    return
  }
  if (result.nothingToDeliver) return
  if (result.error) showToast(`交付失败：${result.error}`, 'error')
}

/** 手动「立即交付」：把整张卡（同 sopJobId 的所有任务）一次写全 */
/**
 * 立刻交付这张卡。
 *
 * @param onlyImageIds 只交这几张（多选交付用）。不传就是整卡按原有规则交。
 *   实现上是把「其余图」作为排除项传给整卡交付 —— 文件名序号、文件夹归属、
 *   质检排除这些逻辑都不用重写一份。
 */
export async function deliverTaskNow(taskId: string, onlyImageIds?: string[]): Promise<DeliverResult> {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return { ok: false, written: 0, error: '任务不存在' }
  if (!isTauri) return { ok: false, written: 0, error: '网页版请用「下载到文件夹」' }
  const context = await buildDeliverContext()
  /**
   * 有质检就只交合格的：自动质检判「不合格」的整张卡一起排除。
   * 人工改判过的由 deliverableOutputImages 自己看任务上的 qcVerdicts，这里只处理自动结论。
   * 待定 / 没跑过质检的照常交付 —— 静默少交比多交一张更麻烦。
   */
  const qc = useClipStore.getState().qc
  const excludeImageIds = new Set<string>()
  /** 因质检不合格被排除的张数：单独计数，别把「没选的图」也算进这句提示里 */
  let qcSkipped = 0
  for (const item of tasksOfCard(context.tasks, task)) {
    for (const id of item.outputImages ?? []) {
      if (qc[id]?.verdict === 'fail') {
        excludeImageIds.add(id)
        qcSkipped += 1
      }
    }
  }
  // 多选交付：把没选的图排除掉（已选的才交）
  if (onlyImageIds?.length) {
    const keep = new Set(onlyImageIds)
    for (const item of tasksOfCard(context.tasks, task)) {
      for (const id of item.outputImages ?? []) {
        if (!keep.has(id)) excludeImageIds.add(id)
      }
    }
  }
  const result = await deliverCardGroup(task, context, { excludeImageIds })
  recordDeliveredFiles(result.files, result.dir)
  reportDeliverResult(result)
  // 只报质检跳过的那部分：多选交付时排除的是「没选的图」，说成质检不合格会误导
  if (qcSkipped && result.ok) {
    useStore.getState().showToast(`已跳过 ${qcSkipped} 张质检不合格的图`, 'info')
  }
  return result
}

/** 「打开交付文件夹」的结果，供界面决定提示什么 */
export interface OpenDeliveryFolderResult {
  ok: boolean
  /** card = 打开的是卡文件夹；root = 这张卡还没交付过，打开的是交付地址 */
  opened?: 'card' | 'root'
  /** 实际打开的绝对路径 */
  path?: string
  /** 三级都没配交付地址，也没有兜底的默认保存地址 */
  noTarget?: boolean
  /** true 表示网页版没有本地目录可开 */
  webOnly?: boolean
  error?: string
}

/**
 * 「打开交付文件夹」：在资源管理器里打开这张卡的交付位置。
 *
 * 优先开卡文件夹（交付地址 + 卡文件夹名）；这张卡还没交付过时目录不存在，
 * 退回打开交付地址本身，并告诉调用方 open 的是哪一层，
 * 免得用户以为「交付过了」。
 */
export async function openDeliveryFolderForTask(taskId: string): Promise<OpenDeliveryFolderResult> {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (!isTauri) return { ok: false, webOnly: true }
  const context = await buildDeliverContext()
  const location = await resolveCardDeliveryLocation(task, context)
  if (!location) return { ok: false, noTarget: true }
  try {
    await openDirectoryPath(location.path)
    return { ok: true, opened: 'card', path: location.path }
  } catch {
    // 多半是还没交付过（目录不存在），也可能是目录被移走；都退回交付地址
  }
  try {
    await openDirectoryPath(location.dir)
    return { ok: true, opened: 'root', path: location.dir }
  } catch (err) {
    return { ok: false, path: location.dir, error: typeof err === 'string' ? err : '打开交付地址失败' }
  }
}

/** 供界面显示：这张卡最终会交付到哪（含继承来源与兜底） */
export async function resolveTaskDeliveryTarget(task: TaskRecord) {
  const sop = useSopStore.getState()
  const settings = useStore.getState().settings
  const resolved = resolveDeliveryDir(sop.deliveryDirs, sop.directions, task.sopDirectionId)
  if (resolved) return resolved
  if (!isTauri || settings.saveLocationMode !== 'default') return null
  try {
    return { ownerId: '', path: await getDefaultSaveDir() }
  } catch {
    return null
  }
}

async function storeTaskOutputImages(task: TaskRecord, images: string[]) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const outputImageSizes: Array<{ width?: number; height?: number }> = []
  const transparentOriginalImageIds: string[] = []
  // AI 直出原图 id，供「再次后处理」重新套模板
  const sourceImageIds: string[] = []
  const storedImageIds: string[] = []

  // 后处理：按这张图自己的比例挑模板，没有对得上的模板就原样保留
  // 参数面板里可以把「后处理」关掉，关掉时一张都不套，原图直出
  const sopState = useSopStore.getState()
  // 方向下配了专属模板就只套它，没配才用产品模板（见 resolvePostTemplates）
  const postTemplates = task.params.post_process === false
    ? []
    : resolvePostTemplates(sopState.postTemplates, sopState.directions, task.sopDirectionId).templates
  const postProcessOn = postTemplates.some((item) => item.enabled)

  // 渠道不支持目标尺寸时，出图用的是同比例更大的尺寸，这里缩回用户设的那个尺寸。
  // 缩过之后它就是「接口给的原图」，后面判断有没有套模板都拿它当基准。
  const sizePlan = planGenerationSize(task.params.size, { postProcess: postProcessOn })
  let generatedImages = images
  if (sizePlan.scaled) {
    const target = parsePixelSize(sizePlan.targetSize)
    if (target) {
      generatedImages = await Promise.all(images.map((url) => resizeDataUrlToSize(url, target)))
    }
  }

  let finalImages = generatedImages
  const appliedIndexes: number[] = []
  // 每张图实际套上的模板：体积上限挂在模板上，压体积时要按这张图自己的模板取
  const appliedTemplates: Array<PostTemplate | null> = generatedImages.map(() => null)
  if (postProcessOn) {
    finalImages = await Promise.all(generatedImages.map(async (url, index) => {
      const size = imageSizeFromDataUrl(url)
      const template = size ? pickTemplateForImage(postTemplates, size.width, size.height, task.channel) : null
      if (!template) return url
      try {
        const output = await applyPostTemplate(url, template)
        appliedIndexes.push(index)
        appliedTemplates[index] = template
        return output
      } catch (err) {
        console.warn('后处理模板应用失败，已保留原图', err)
        return url
      }
    }))
  }

  // 限制文件大小：压的是最终要存的那一份，所以放在透明背景处理之后。
  // 上限优先取这张图套上的模板（按渠道 + 尺寸配的），模板没配才用全局开关；
  // 模板设了上限时 PNG 也要压 —— 会转成 WebP，所以文件名按实际编码写
  let overflowCount = 0
  let largestBytes = 0
  let tightestLimitBytes = 0
  // 一个任务卡一个文件夹，文件名按序号 + 分辨率。
  // 同卡的多条任务共用一个文件夹，所以序号要接着提示词序号排，
  // 否则每条任务都从 01 开始，后写的那条会把前一条的成品覆盖掉
  const finishedIndexBase = task.sopPromptIndex && task.sopPromptIndex > 0 ? task.sopPromptIndex - 1 : 0
  const finishedFolder = appliedIndexes.length ? finishedFolderFor(task) : ''

  try {
    for (let index = 0; index < finalImages.length; index += 1) {
      const dataUrl = finalImages[index]
      // AI 直出、还没经过任何本地处理的那一份。派发、再次后处理都拿它当源，
      // 所以用接口原样返回的 images[index]，而不是下面为了对齐目标尺寸缩过的那份；
      // 只要后面有任何一步改了画面（套模板 / 扣透明底 / 压体积），就必须另存一份
      const aiOriginal = images[index] ?? generatedImages[index]
      let outputDataUrl = dataUrl
      /** 透明背景分支已经存过的那份「扣底前」图，和 AI 原图相同时直接复用，别存两遍 */
      let transparentStoredId = ''
      if (task.transparentOutput) {
        const original = await storeImageWithSize(dataUrl, 'generated')
        storedImageIds.push(original.id)
        cacheImage(original.id, dataUrl)
        transparentStoredId = original.id

        try {
          outputDataUrl = task.params.output_format === 'webp'
            ? await removeKeyedBackgroundFromDataUrl(dataUrl, undefined, 'webp', task.params.output_compression)
            : await removeKeyedBackgroundFromDataUrl(dataUrl)
          transparentOriginalImageIds.push(original.id)
        } catch (err) {
          console.warn('透明背景后处理失败，已回退为原始输出', err)
          outputIds.push(original.id)
          outputDataUrls.push(dataUrl)
          outputImageSizes.push(original)
          transparentOriginalImageIds.push('')
          // 扣底失败时成品就是套完模板的那张；它和 AI 原图不一样时仍要留原图，
          // 否则这张图永远没法派发 / 再次后处理
          if (dataUrl === aiOriginal) {
            sourceImageIds.push(original.id)
          } else {
            const source = await storeImageWithSize(aiOriginal, 'generated')
            storedImageIds.push(source.id)
            cacheImage(source.id, aiOriginal)
            sourceImageIds.push(source.id)
          }
          continue
        }
      }

      const sizeLimit = resolveSizeLimitPlan(task.params, appliedTemplates[index]?.maxFileKb)
      if (sizeLimit) {
        try {
          const limited = await limitDataUrlSize(outputDataUrl, sizeLimit.format, sizeLimit.bytes)
          outputDataUrl = limited.dataUrl
          if (!limited.fits) {
            overflowCount += 1
            largestBytes = Math.max(largestBytes, dataUrlByteSize(outputDataUrl))
            // 各张图的上限可能不同（模板按尺寸配），报最严的那个更接近真实约束
            tightestLimitBytes = tightestLimitBytes ? Math.min(tightestLimitBytes, sizeLimit.bytes) : sizeLimit.bytes
          }
        } catch (err) {
          console.warn('限制文件大小失败，已保留原图', err)
        }
      }

      const stored = await storeImageWithSize(outputDataUrl, 'generated')
      storedImageIds.push(stored.id)
      cacheImage(stored.id, outputDataUrl)
      outputIds.push(stored.id)
      outputDataUrls.push(outputDataUrl)
      outputImageSizes.push(stored)

      // AI 原图：成品和直出图逐字节相同就直接复用同一个 id，不必多占一份空间；
      // 否则（套了模板 / 扣了透明底 / 压过体积）另存一份，供派发与再次后处理当源
      if (outputDataUrl === aiOriginal) {
        sourceImageIds.push(stored.id)
      } else if (dataUrl === aiOriginal && transparentStoredId) {
        sourceImageIds.push(transparentStoredId)
      } else {
        const source = await storeImageWithSize(aiOriginal, 'generated')
        storedImageIds.push(source.id)
        cacheImage(source.id, aiOriginal)
        sourceImageIds.push(source.id)
      }

      // 落一份到 data/finished/<任务文件夹>/，直接去文件夹就能取成品（带后处理、已压到目标体积的那份）
      if (appliedIndexes.includes(index)) {
        void writeFinishedImage(
          finishedFolder,
          // 模板设了体积上限时成品会被转成 WebP，后缀要跟实际编码一致
          finishedFileName(finishedIndexBase + index, task.params.size, dataUrlFormat(outputDataUrl) ?? task.params.output_format),
          outputDataUrl,
        )
      }
    }

    // 上限是硬要求，达不到要让用户知道，不能静默放过
    if (overflowCount > 0) {
      useStore.getState().showToast(
        `有 ${overflowCount} 张图压到最低画质仍有 ${Math.round(largestBytes / 1024)}KB，超过 ${Math.round(tightestLimitBytes / 1024)}KB 上限`,
        'info',
      )
    }

    return {
      outputIds,
      outputDataUrls,
      outputImageSizes,
      sourceImages: sourceImageIds.some((id, index) => id !== outputIds[index]) ? sourceImageIds : undefined,
      transparentOriginalImageIds: transparentOriginalImageIds.length ? transparentOriginalImageIds : undefined,
    }
  } catch (err) {
    await deleteUnreferencedImageIds(storedImageIds)
    throw err
  }
}

async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(imageIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks, trashedTasks, inputImages, galleryInputDraft } = useStore.getState()
  const stillUsed = new Set<string>()
  for (const task of tasks) addTaskReferencedImageIds(stillUsed, task)
  // 回收站里的任务仍然占着图片，清空回收站前不能把它们当孤儿图删掉
  for (const task of trashedTasks) addTaskReferencedImageIds(stillUsed, task)
  addAgentReferencedImageIds(stillUsed)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)
  // 固定图 / 变量图还在输入栏里等着用，别当孤儿图清掉
  for (const img of useStore.getState().fixedImages) stillUsed.add(img.id)
  for (const img of useStore.getState().variableImages) stillUsed.add(img.id)
  // 后处理模板的预览底图是用户挑的，被引用的图不能被当孤儿清掉
  for (const byRatio of Object.values(useSopStore.getState().postPreviewImages)) {
    for (const imgId of Object.values(byRatio)) stillUsed.add(imgId)
  }

  for (const imgId of candidates) {
    if (stillUsed.has(imgId)) continue
    await deleteStoredImageIfUnreferenced(imgId)
  }
}

/**
 * 再次后处理：用出图时保留的 AI 原图重新套「当前」模板，覆盖原来那批成品，不重新生图。
 * 只重做「套模板 + 体积上限」；透明背景任务不支持（重抠图会改变画面，已超出「再后处理」的语义）。
 *
 * 一张卡（同 sopJobId）里的多个任务一起处理：详情页本来就是按卡展示的，
 * 只重做第一条提示词那几张，用户会以为「点了没反应」。
 */
/** 再次后处理每处理这么多张任务提交一次，兼顾「崩溃不白干」与「别把主线程占满」 */
const REAPPLY_COMMIT_BATCH = 20

/**
 * 一张卡里哪些图会被「再次后处理」重做。
 *
 * 跳过两类：已进图片回收站的（重做不该把它复活）、没有对应 AI 原图的（老任务没存 sourceImages）。
 * 抽成纯函数是为了让进度条的总数可测 —— 总数一旦算多了或算少了，进度条就会停在中途或提前满。
 */
export function reapplyTargetIndexes(task: TaskRecord): number[] {
  const trashed = new Set(task.trashedOutputImages ?? [])
  const indexes: number[] = []
  task.outputImages.forEach((imageId, index) => {
    if (!imageId || trashed.has(imageId)) return
    if (index >= (task.sourceImages?.length ?? 0)) return
    indexes.push(index)
  })
  return indexes
}

export async function reapplyPostTemplate(
  taskId: string,
  /** 进度回调：一张张串行套模板，几十张要跑几十秒，界面得能看到走到哪了 */
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<void> {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) throw new Error('找不到任务卡')
  if (task.transparentOutput) {
    throw new Error('透明背景的任务暂不支持再次后处理，请重新生图')
  }
  const group = tasksOfCard(useStore.getState().tasks, task)
  // 有些老任务没留原图（或那一张当时没套模板、原图与成品同一份），单独跳过，不拖累整卡
  const ready = group.filter((item) => (
    item.outputImages.length > 0
    && item.sourceImages?.length === item.outputImages.length
    && item.sourceImages.every(Boolean)
  ))
  if (!ready.length) {
    throw new Error('这个任务没有保留 AI 原图，无法再次后处理（只有新版客户端出的图支持）')
  }
  if (ready.some((item) => item.transparentOutput)) {
    throw new Error('透明背景的任务暂不支持再次后处理，请重新生图')
  }

  const sopState = useSopStore.getState()

  // 先把「这一卡到底要重做哪几张」算清楚：进度条一开始就得知道总数，
  // 否则第一张做完之前只能显示「后处理中…」，等于没进度。
  const plan: Array<{ item: TaskRecord; templates: PostTemplate[]; indexes: number[] }> = []
  let planned = 0
  for (const item of ready) {
    const templates = item.params.post_process === false
      ? []
      : resolvePostTemplates(sopState.postTemplates, sopState.directions, item.sopDirectionId).templates
    if (!templates.some((entry) => entry.enabled)) continue
    const indexes = reapplyTargetIndexes(item)
    if (!indexes.length) continue
    plan.push({ item, templates, indexes })
    planned += indexes.length
  }

  const oldIds: string[] = []
  let applied = 0
  let written = 0
  let done = 0

  let lastProgressAt = 0
  const emitProgress = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    // 进度条虽然只刷新自己，但一张一报也没意义；首帧和收尾必须报，中间按 300ms 节流
    if (!force && now - lastProgressAt < 300) return
    lastProgressAt = now
    onProgress({ done, total: planned })
  }
  // 一进来就报 0/总数：点了按钮立刻能看到进度，而不是干等
  emitProgress(true)

  // 攒着一起提交：几百张的卡逐张 setState，等于把「整个任务列表序列化 + 重新渲染」
  // 做几百次，主线程会被占满（实测几百张时直接「页面未响应」）
  const pendingUpdates: Array<{ id: string; nextIds: string[] }> = []
  const flushUpdates = () => {
    if (!pendingUpdates.length) return
    const patches = new Map(pendingUpdates.map((entry) => [entry.id, entry.nextIds]))
    useStore.setState((state) => ({
      tasks: state.tasks.map((entry) => (
        patches.has(entry.id)
          ? { ...entry, outputImages: patches.get(entry.id)!, trashedOutputImages: undefined }
          : entry
      )),
    }))
    for (const entry of pendingUpdates) {
      const next = useStore.getState().tasks.find((item) => item.id === entry.id)
      if (next) void putTask(next)
    }
    pendingUpdates.length = 0
  }

  for (const { item, templates, indexes } of plan) {
    const folder = finishedFolderFor(item)
    const nextIds: string[] = []
    for (const index of indexes) {
      // 逐张取原图：一次只把一张读进内存，几百张的卡不会一次性堆满
      const sourceId = item.sourceImages?.[index]
      if (!sourceId) continue
      const source = await getImage(sourceId)
      if (!source?.dataUrl) throw new Error('AI 原图已被清理，无法再次后处理')
      let dataUrl = source.dataUrl
      const size = imageSizeFromDataUrl(dataUrl)
      const template = size ? pickTemplateForImage(templates, size.width, size.height, item.channel) : null
      let appliedTemplate: PostTemplate | null = null
      if (template) {
        try {
          dataUrl = await applyPostTemplate(dataUrl, template)
          appliedTemplate = template
          applied += 1
        } catch (err) {
          console.warn('再次后处理：套模板失败，保留原图', err)
        }
      }
      // 体积上限跟模板走：模板配了就用模板的，没配才用输入区的全局值
      const sizeLimit = resolveSizeLimitPlan(item.params, appliedTemplate?.maxFileKb)
      if (sizeLimit) {
        try {
          dataUrl = (await limitDataUrlSize(dataUrl, sizeLimit.format, sizeLimit.bytes)).dataUrl
        } catch (err) {
          console.warn('再次后处理：限制体积失败，保留原图', err)
        }
      }
      const stored = await storeImageWithSize(dataUrl, 'generated')
      cacheImage(stored.id, dataUrl)
      nextIds.push(stored.id)
      // 序号沿用提示词序号，同卡的多条任务不会互相覆盖同一批文件。
      // 串行写：几百个并发 IPC 会把前端桥和 Rust 侧一起压住，这里是兜底不是快路径
      await writeFinishedImage(
        folder,
        finishedFileName(
          (item.sopPromptIndex ? item.sopPromptIndex - 1 : 0) + index,
          item.params.size,
          dataUrlFormat(dataUrl) ?? item.params.output_format,
        ),
        dataUrl,
      )
      done += 1
      emitProgress()
    }

    if (!nextIds.length) continue
    oldIds.push(...item.outputImages, ...(item.transparentOriginalImages ?? []))
    // 回收的旧图这次被跳过、随 oldIds 一起清掉，标记也没有意义了
    pendingUpdates.push({ id: item.id, nextIds })
    written += nextIds.length
    if (pendingUpdates.length >= REAPPLY_COMMIT_BATCH) {
      flushUpdates()
      // 让出主线程：不然几百张连着算 canvas，窗口会被系统判成「页面未响应」
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    }
  }
  flushUpdates()
  emitProgress(true)

  await deleteUnreferencedImageIds(oldIds)
  useStore.getState().showToast(
    applied ? `已用原图重新后处理 ${written} 张` : '没有匹配的模板，画面与之前一致',
    applied ? 'success' : 'info',
  )
}

/** 一个派发目标的执行结果，供界面汇总提示 */
export interface DispatchTargetResult {
  targetId: string
  /** 「保险 / 百万医疗险 / 月亮」 */
  name: string
  /** 生成并挂到新卡里的张数 */
  created: number
  /** 真正写进交付文件夹的张数；没配交付地址、或网页版时为 0 */
  written: number
  /** 比例对不上、被跳过的原图张数 */
  skipped: number
  /** 新生成的卡 id，一张图都没出时为空 */
  taskId?: string
  folder?: string
  path?: string
  error?: string
}

export interface DispatchResult {
  ok: boolean
  results: DispatchTargetResult[]
  /** 整卡可派发的 AI 原图张数 */
  total: number
  error?: string
}

/** 整卡（同 sopJobId）可派发的 AI 原图 id，顺序与详情页图片顺序一致 */
export function collectDispatchOriginals(task: TaskRecord): string[] {
  // 卡片可能来自界面传进来的快照（详情页聚合过的对象），不一定在 store 里；
  // 那种情况下至少把它自己当成一张卡，而不是返回空列表让派发静默不可用
  const state = useStore.getState().tasks
  const scope = state.some((item) => item.id === task.id) ? state : [task]
  const group = tasksOfCard(scope, task)
    .slice()
    .sort((a, b) => (a.sopPromptIndex ?? 0) - (b.sopPromptIndex ?? 0))
  const ids: string[] = []
  for (const item of group) {
    const trashed = new Set(item.trashedOutputImages ?? [])
    item.outputImages.forEach((imageId, index) => {
      if (!imageId || trashed.has(imageId)) return
      // 有后处理 / 压过体积的卡会把 AI 原图单独存一份，派发要用那一份；
      // 老任务没有 sourceImages 时退回成品本身（等于原始直出）
      ids.push(item.sourceImages?.[index] || imageId)
    })
  }
  return ids
}

/**
 * 派发：把这张卡的 AI 原图分别套上多个产品 / 方向的后处理模板，
 * 每个目标出一份成品，落到该目标自己的交付地址，并在应用内生成一张卡。
 *
 * 为什么在这里而不是复用「再次后处理」：那个是原地覆盖这张卡的成品，
 * 派发是「一张原图复制成多份、各套各的水印」，原卡必须保持原样。
 */
export async function dispatchTaskCard(taskId: string, targetIds: string[]): Promise<DispatchResult> {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return { ok: false, results: [], total: 0, error: '任务不存在' }
  if (!targetIds.length) return { ok: false, results: [], total: 0, error: '没有选择派发目标' }

  const originals = collectDispatchOriginals(task)
  if (!originals.length) return { ok: false, results: [], total: 0, error: '这张卡还没有可派发的成品' }

  // 先把原图全部读出来：多个目标共用同一批源图，读一次就够
  const sources: Array<{ id: string; dataUrl: string; width: number; height: number }> = []
  for (const id of originals) {
    const image = await getImage(id)
    if (!image?.dataUrl) continue
    const size = imageSizeFromDataUrl(image.dataUrl)
    if (!size) continue
    sources.push({ id, dataUrl: image.dataUrl, width: size.width, height: size.height })
  }
  if (!sources.length) return { ok: false, results: [], total: 0, error: 'AI 原图已被清理，无法派发' }

  const sop = useSopStore.getState()
  const context = await buildDeliverContext()
  const sourceName = task.sopName?.trim()
    || getTaskPromptText(task.prompt, task.inputImageIds?.length ?? 0).slice(0, 20)
    || '原图'
  const results: DispatchTargetResult[] = []

  for (const targetId of targetIds) {
    const node = sop.directions.find((item) => item.id === targetId && !item.deletedAt)
    if (!node) {
      results.push({ targetId, name: targetId, created: 0, written: 0, skipped: 0, error: '找不到这个产品 / 方向' })
      continue
    }
    const label = directionPath(sop.directions, targetId) || node.name
    const templates = resolvePostTemplates(sop.postTemplates, sop.directions, targetId).templates
      .filter((item) => item.enabled)
    if (!templates.length) {
      results.push({ targetId, name: label, created: 0, written: 0, skipped: 0, error: '这个目标没有启用的后处理模板' })
      continue
    }

    const outputs: Array<{ id: string; dataUrl: string; size: string; ext: string }> = []
    const usedSources: string[] = []
    let skipped = 0
    for (const source of sources) {
      const template = pickDispatchTemplate(templates, source.width, source.height, task.channel)
      if (!template) {
        skipped += 1
        continue
      }
      try {
        let dataUrl = await applyPostTemplate(source.dataUrl, template)
        // 体积上限跟目标模板走，和出图时的规则保持一致
        const sizeLimit = resolveSizeLimitPlan(task.params, template.maxFileKb)
        if (sizeLimit) {
          try {
            dataUrl = (await limitDataUrlSize(dataUrl, sizeLimit.format, sizeLimit.bytes)).dataUrl
          } catch (err) {
            console.warn('派发：限制体积失败，保留原图', err)
          }
        }
        const stored = await storeImageWithSize(dataUrl, 'generated')
        cacheImage(stored.id, dataUrl)
        const bytes = dataUrlToBytes(dataUrl)
        const size = imageSizeFromDataUrl(dataUrl)
        outputs.push({
          id: stored.id,
          dataUrl,
          size: size ? `${size.width}x${size.height}` : (task.params.size ?? ''),
          ext: bytes.ext,
        })
        usedSources.push(source.id)
      } catch (err) {
        console.warn('派发：套模板失败，跳过这张', err)
        skipped += 1
      }
    }

    if (!outputs.length) {
      results.push({ targetId, name: label, created: 0, written: 0, skipped, error: dispatchSkipNote(skipped, sources.length) })
      continue
    }

    const now = Date.now()
    const newTask: TaskRecord = {
      id: genId(),
      prompt: `派发 · ${sourceName}`,
      params: { ...task.params, n: outputs.length },
      inputImageIds: [],
      outputImages: outputs.map((item) => item.id),
      sourceImages: usedSources,
      status: 'done',
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      elapsed: 0,
      // 派发是用户点出来的，不是后台跑完的，不用再标未读红点
      detailViewedAt: now,
      // 文件夹名与卡片标题都用 sopName，这里用「派发-源卡名」：
      // 名字里的 - 会被文件夹命名拆成两段，所以无论源卡名多长，「派发」这个标识都会保留下来
      sopName: `派发-${sourceName}`,
      sopDirectionId: targetId,
      // 派发出来的卡沿用源卡的卖点：它套的是同一批原图
      sopPointName: task.sopPointName,
      channel: task.channel,
      sourceMode: task.sourceMode ?? 'gallery',
      dispatchFromTaskId: task.id,
    }

    const dir = resolveDeliveryDir(sop.deliveryDirs, sop.directions, targetId)?.path
      ?? context.fallbackDir?.trim()
      ?? ''
    let written = 0
    let folder: string | undefined
    let path: string | undefined
    let writeError: string | undefined

    if (!dir) {
      writeError = '没配交付地址，这次只生成了卡'
    } else if (!isTauri) {
      writeError = '网页版无法写本地文件夹，这次只生成了卡'
    } else {
      try {
        const saveDir = await useSaveDir(dir)
        // 一张卡一个文件夹，命名与「立即交付」完全一致，重复派发落在同一个文件夹里
        // 同一个源卡派发两次会算出同一个文件夹名，交给占位逻辑避开
        const folderName = resolveCardFolderName(newTask, context, outputs[0]?.size).folder
        newTask.deliverFolder = folderName
        const folderInfo = await createSaveFolder(saveDir, folderName, true)
        folder = folderInfo.name
        path = folderInfo.path
        for (let index = 0; index < outputs.length; index += 1) {
          const item = outputs[index]
          try {
            await saveFileToDir(
              saveDir,
              dataUrlToBytes(item.dataUrl).bytes,
              deliverImageFileName(index + 1, newTask, context, item.size, item.ext, folderName),
              undefined,
              folderInfo.name,
              true,
            )
            written += 1
          } catch (err) {
            console.error('派发写入失败：', err)
          }
        }
        if (!written) writeError = '图片写入失败'
      } catch (err) {
        writeError = typeof err === 'string' ? err : '交付地址不可用'
      }
    }

    // 卡先落库：写盘失败也留着，用户可以在应用内看到并手动再交付
    const state = useStore.getState()
    state.setTasks([newTask, ...state.tasks])
    await putTask(newTask)

    results.push({
      targetId,
      name: label,
      created: outputs.length,
      written,
      skipped,
      taskId: newTask.id,
      folder,
      path,
      error: writeError,
    })
  }

  const created = results.reduce((sum, item) => sum + item.created, 0)
  const failed = results.filter((item) => item.error && !item.created)
  if (created > 0) {
    const targets = results.filter((item) => item.created > 0).length
    useStore.getState().showToast(`已派发到 ${targets} 个目标，共 ${created} 张`, 'success')
  } else {
    useStore.getState().showToast(
      failed[0]?.error ? `派发失败：${failed[0].error}` : '派发失败，没有生成任何图片',
      'error',
    )
  }

  return { ok: created > 0, results, total: sources.length }
}

async function persistTaskStreamPartialImage(taskId: string, dataUrl: string, execution?: symbol) {
  try {
    const imgId = await storeImage(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)

    const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || latestTask.status === 'done' || (execution && taskExecutions.get(taskId) !== execution)) {
      await deleteUnreferencedImageIds([imgId])
      return
    }

    const currentIds = latestTask.streamPartialImageIds || []
    if (currentIds.includes(imgId)) return
    updateTaskInStore(taskId, { streamPartialImageIds: [...currentIds, imgId] })
  } catch (err) {
    console.error(err)
  }
}

async function readAgentImageDataUrls(ids: string[]) {
  const dataUrls: string[] = []
  for (const id of ids) {
    const dataUrl = await ensureImageCached(id)
    if (dataUrl) dataUrls.push(dataUrl)
  }
  return dataUrls
}

function scrubAgentOutputPayloadsForDeletedTasks(deletedTasks: TaskRecord[]) {
  const deletedByRound = new Map<string, TaskRecord[]>()
  const affectedConversationIds = new Set<string>()
  for (const task of deletedTasks) {
    if (task.sourceMode !== 'agent' || !task.agentConversationId || !task.agentRoundId) continue
    const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
    deletedByRound.set(key, [...(deletedByRound.get(key) ?? []), task])
    affectedConversationIds.add(task.agentConversationId)
  }
  if (deletedByRound.size === 0) return { updatedTasks: [], updatedConversations: [] }

  const updatedTasks: TaskRecord[] = []
  const updatedConversations: AgentConversation[] = []
  useStore.setState((state) => {
    const tasksByRound = new Map<string, TaskRecord[]>()
    for (const task of [...state.tasks, ...deletedTasks]) {
      if (!task.agentConversationId || !task.agentRoundId) continue
      const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
      if (!deletedByRound.has(key)) continue
      tasksByRound.set(key, [...(tasksByRound.get(key) ?? []), task])
    }
    const roundsByKey = new Map<string, AgentRound>()
    let conversationsChanged = false
    const agentConversations = state.agentConversations.map((conversation) => {
      if (!affectedConversationIds.has(conversation.id)) return conversation
      let changed = false
      const rounds = conversation.rounds.map((round) => {
        const key = getAgentRoundControllerKey(conversation.id, round.id)
        const roundDeletedTasks = deletedByRound.get(key)
        if (!roundDeletedTasks) return round
        roundsByKey.set(key, round)
        if (!round.responseOutput?.length) return round
        const responseOutput = scrubResponseOutputForDeletedAgentTasks(round, round.responseOutput, roundDeletedTasks, tasksByRound.get(key) ?? roundDeletedTasks)
        if (responseOutput === round.responseOutput) return round
        changed = true
        return { ...round, responseOutput }
      })
      if (!changed) return conversation
      conversationsChanged = true
      const updated = { ...conversation, rounds }
      updatedConversations.push(updated)
      return updated
    })
    const tasks = state.tasks.map((task) => {
      if (!task.agentConversationId || !task.agentRoundId) return task
      const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
      const roundDeletedTasks = deletedByRound.get(key)
      if (!roundDeletedTasks) return task
      const round = roundsByKey.get(key)
      if (!round) return task
      const scrubbed = scrubTaskRawResponsePayloadForDeletedTasks(task, round, roundDeletedTasks, tasksByRound.get(key) ?? roundDeletedTasks)
      if (scrubbed.rawResponsePayload === task.rawResponsePayload) return task
      updatedTasks.push(scrubbed)
      return scrubbed
    })
    if (!conversationsChanged && updatedTasks.length === 0) return state
    return {
      ...(conversationsChanged ? { agentConversations } : {}),
      ...(updatedTasks.length > 0 ? { tasks } : {}),
    }
  })
  return { updatedTasks, updatedConversations }
}

async function persistTaskDeletionCleanup(deletedTaskIds: string[], cleanup: ReturnType<typeof scrubAgentOutputPayloadsForDeletedTasks>) {
  const tasks = cleanup.updatedTasks.map(getPersistableTask)
  const conversations = cleanup.updatedConversations.map(getPersistableAgentConversation)
  try {
    await commitTaskDeletion(deletedTaskIds, tasks, conversations)
  } catch (err) {
    console.warn('原子清理任务关联数据失败，改用逐项持久化', err)
    await Promise.all([
      ...deletedTaskIds.map((taskId) => dbDeleteTask(taskId)),
      ...tasks.map((task) => dbPutTask(task)),
      ...conversations.map((conversation) => dbPutAgentConversation(conversation)),
    ])
  }
}

function appendAgentRecoveredToolOutputs(conversationId: string, roundId: string, additions: ResponsesOutputItem[]) {
  updateAgentConversation(conversationId, (current) => ({
    ...current,
    updatedAt: Date.now(),
    rounds: current.rounds.map((round) => {
      if (round.id !== roundId) return round
      const output = round.responseOutput ?? []
      const existingOutputCallIds = getAgentFunctionOutputCallIds(output)
      const nextAdditions = additions.filter((item) => item.call_id && !existingOutputCallIds.has(item.call_id))
      return nextAdditions.length > 0
        ? { ...round, responseOutput: [...output, ...nextAdditions] }
        : round
    }),
  }))
}

async function continueRecoveredAgentRound(taskId: string) {
  const state = useStore.getState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task?.agentConversationId || !task.agentRoundId) return

  const key = getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId)
  if (agentRoundControllers.has(key) || agentRecoveryContinuations.has(key)) return

  agentRecoveryContinuations.add(key)
  try {
    const latestState = useStore.getState()
    const conversation = latestState.agentConversations.find((item) => item.id === task.agentConversationId)
    const round = conversation?.rounds.find((item) => item.id === task.agentRoundId)
    if (!conversation || !round || round.status === 'done' || round.error === AGENT_STOPPED_MESSAGE) return

    const failRound = (error: string) => {
      updateAgentConversation(conversation.id, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((currentRound) =>
          currentRound.id === round.id
            ? { ...currentRound, status: 'error', error, finishedAt: Date.now() }
            : currentRound,
        ),
      }))
      showTaskCompletionNotification('Agent 回复失败', '请回到应用查看详情。', 'task-failure')
    }

    const recovered = createReadyAgentRecoveredToolState(round, latestState.tasks)
    if (!recovered) return

    appendAgentRecoveredToolOutputs(conversation.id, round.id, recovered.additions)
    const updatedState = useStore.getState()
    const updatedConversation = updatedState.agentConversations.find((item) => item.id === conversation.id)
    const updatedRound = updatedConversation?.rounds.find((item) => item.id === round.id)
    if (!updatedConversation || !updatedRound) return

    if (!recovered.allSuccessful) {
      failRound(getAgentRecoveredFailureError(updatedRound, updatedState.tasks))
      return
    }

    const normalizedSettings = normalizeSettings(updatedState.settings)
    const agentValidationError = getAgentProfileValidationError(normalizedSettings)
    if (agentValidationError) {
      failRound(`无法继续恢复任务：${agentValidationError.message}`)
      return
    }
    const activeProfile = getAgentTextApiProfile(normalizedSettings)
    const imageProfile = getAgentImageApiProfile(normalizedSettings)
    if (!activeProfile || !imageProfile) {
      failRound('Agent API 配置不存在，无法继续恢复任务。')
      return
    }
    const roundTasks = updatedState.tasks.filter((item) => item.agentRoundId === round.id)
    const resumeParams = roundTasks.find((item) => item.params)?.params
      ?? normalizeParamsForSettings(updatedState.params, createSettingsForApiProfile(normalizedSettings, imageProfile), { hasInputImages: round.inputImageIds.length > 0 })
    const maxToolCalls = Number.isFinite(normalizedSettings.agentMaxToolRounds)
      ? Math.max(1, Math.trunc(normalizedSettings.agentMaxToolRounds))
      : DEFAULT_AGENT_MAX_TOOL_ROUNDS
    const toolCallsUsed = getAgentRecoveredToolCallCount(updatedRound.responseOutput ?? [], roundTasks)

    updateAgentConversation(conversation.id, (current) => ({
      ...current,
      updatedAt: Date.now(),
      rounds: current.rounds.map((currentRound) =>
        currentRound.id === round.id
          ? { ...currentRound, status: 'running', error: null, finishedAt: null }
          : currentRound,
      ),
    }))

    void executeAgentRound(
      conversation.id,
      round.id,
      resumeParams,
      createSettingsForApiProfile(normalizedSettings, activeProfile),
      activeProfile,
      imageProfile,
      {
        responseOutput: updatedRound.responseOutput ?? [],
        recoveredTaskIds: recovered.recoveredTaskIds,
        toolCallsUsed,
      },
    )
  } finally {
    agentRecoveryContinuations.delete(key)
  }
}

export async function submitAgentMessage() {
  const state = useStore.getState()
  const { settings, prompt, inputImages, maskDraft, params, showToast } = state
  if (state.batchProgress) {
    showToast('画廊批量任务进行中，请等待完成或回到画廊停止后再提交', 'error')
    return
  }
  const normalizedSettings = normalizeSettings(settings)

  const agentValidationError = getAgentProfileValidationError(normalizedSettings)
  if (agentValidationError) {
    showToast(`请先完善 Agent API 配置：${agentValidationError.message}`, 'error')
    state.setShowSettings(true, normalizedSettings.agentApiConfigMode === 'off' ? 'api' : 'agent')
    return
  }

  const activeProfile = getAgentTextApiProfile(normalizedSettings)!
  const imageProfile = getAgentImageApiProfile(normalizedSettings)!

  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    showToast('请输入消息', 'error')
    return
  }

  const conversation = getActiveAgentConversation()
  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast('请等待生成完成，或先停止生成', 'info')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        state.clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  const inputImageIds = uniqueIds(orderedInputImages.map((image) => image.id))

  for (const image of orderedInputImages) {
    await storeImage(image.dataUrl)
  }

  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const imageRequestSettings = createSettingsForApiProfile(normalizedSettings, imageProfile)
  const now = Date.now()
  const editingRound = state.agentEditingRoundId
    ? conversation.rounds.find((item) => item.id === state.agentEditingRoundId) ?? null
    : null
  const editingRoundAssistantMessage = editingRound?.assistantMessageId
    ? conversation.messages.find((message) => message.id === editingRound.assistantMessageId) ?? null
    : conversation.messages.find((message) => message.roundId === editingRound?.id && message.role === 'assistant') ?? null
  const editingRoundHasAssistantMessage = Boolean(editingRoundAssistantMessage)
  const editingRoundHasErrorAssistantMessage = Boolean(
    editingRound?.status === 'error' && editingRoundAssistantMessage?.content.startsWith('请求失败：'),
  )
  const editingRoundHasChildren = editingRound
    ? conversation.rounds.some((round) => (round.parentRoundId ?? null) === editingRound.id)
    : false
  const shouldAppendToEditingRound = Boolean(
    editingRound && !editingRoundHasChildren && (!editingRoundHasAssistantMessage || editingRoundHasErrorAssistantMessage),
  )
  const roundId = shouldAppendToEditingRound && editingRound ? editingRound.id : genId()
  const userMessageId = shouldAppendToEditingRound && editingRound ? editingRound.userMessageId : genId()
  const activeRounds = getActiveAgentRounds(conversation)
  const activeLeafId = activeRounds[activeRounds.length - 1]?.id ?? null
  const parentRoundId = editingRound ? editingRound.parentRoundId ?? null : activeLeafId
  const parentPath = parentRoundId ? getAgentRoundPath(conversation, parentRoundId) : []
  const normalizedParams = {
    ...normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: inputImageIds.length > 0 }),
    n: DEFAULT_PARAMS.n,
    transparent_output: false,
  }
  const round: AgentRound = {
    id: roundId,
    index: shouldAppendToEditingRound && editingRound ? editingRound.index : parentPath.length + 1,
    parentRoundId,
    ...(editingRoundHasErrorAssistantMessage && editingRoundAssistantMessage ? { assistantMessageId: editingRoundAssistantMessage.id } : {}),
    userMessageId,
    prompt: trimmedPrompt,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const userMessage: AgentMessage = {
    id: userMessageId,
    role: 'user',
    content: trimmedPrompt,
    roundId,
    inputImageIds,
    maskTargetImageId,
    maskImageId,
    createdAt: now,
  }

  let fallbackTitle: string | null = null
  updateAgentConversation(conversation.id, (current) => {
    const nextTitle = current.rounds.length === 0 ? createAgentConversationTitle(stripImageMentionMarkers(trimmedPrompt), current.title) : current.title
    if (current.rounds.length === 0) fallbackTitle = nextTitle
    const messages = shouldAppendToEditingRound
      ? current.messages.some((message) => message.id === userMessageId)
        ? current.messages.map((message) => {
            if (message.id === userMessageId) return userMessage
            if (editingRoundHasErrorAssistantMessage && message.id === editingRoundAssistantMessage?.id) {
              return { ...message, content: '', outputTaskIds: [] }
            }
            return message
          })
        : [...current.messages, userMessage]
      : [...current.messages, userMessage]

    return {
      ...current,
      title: nextTitle,
      activeRoundId: roundId,
      updatedAt: now,
      rounds: shouldAppendToEditingRound
        ? current.rounds.map((item) => item.id === roundId ? round : item)
        : [...current.rounds, round],
      messages,
    }
  })

  state.setPrompt('')
  state.clearInputImages()
  state.clearMaskDraft()
  state.setAgentEditingRoundId(null)

  if (fallbackTitle) {
    void generateAgentConversationTitle(conversation.id, stripImageMentionMarkers(trimmedPrompt), inputImageIds, requestSettings, activeProfile, fallbackTitle)
  }

  void executeAgentRound(conversation.id, roundId, normalizedParams, requestSettings, activeProfile, imageProfile)
}

export async function regenerateAgentAssistantMessage(conversationId: string, roundId: string) {
  const state = useStore.getState()
  const { settings, params, showToast } = state
  const normalizedSettings = normalizeSettings(settings)

  const agentValidationError = getAgentProfileValidationError(normalizedSettings)
  if (agentValidationError) {
    showToast(`请先完善 Agent API 配置：${agentValidationError.message}`, 'error')
    state.setShowSettings(true, normalizedSettings.agentApiConfigMode === 'off' ? 'api' : 'agent')
    return
  }

  const activeProfile = getAgentTextApiProfile(normalizedSettings)!
  const imageProfile = getAgentImageApiProfile(normalizedSettings)!

  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const sourceRound = conversation?.rounds.find((item) => item.id === roundId) ?? null
  const sourceUserMessage = sourceRound
    ? conversation?.messages.find((message) => message.id === sourceRound.userMessageId) ?? null
    : null
  if (!conversation || !sourceRound || !sourceUserMessage) {
    showToast('找不到要重新生成的 Agent 消息', 'error')
    return
  }

  if (conversation.rounds.some((round) => round.status === 'running')) {
    showToast('请等待生成完成，或先停止生成', 'info')
    return
  }

  const inputImageIds = uniqueIds(sourceRound.inputImageIds)
  const requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  const imageRequestSettings = createSettingsForApiProfile(normalizedSettings, imageProfile)
  const normalizedParams = {
    ...normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: inputImageIds.length > 0 }),
    n: DEFAULT_PARAMS.n,
    transparent_output: false,
  }
  const now = Date.now()
  if (sourceRound.status === 'error') {
    const assistantMessageId = sourceRound.assistantMessageId
      ?? conversation.messages.find((message) => message.roundId === sourceRound.id && message.role === 'assistant')?.id
    updateAgentConversation(conversationId, (current) => ({
      ...current,
      activeRoundId: sourceRound.id,
      updatedAt: now,
      rounds: current.rounds.map((round) =>
        round.id === sourceRound.id
          ? {
              ...round,
              outputTaskIds: [],
              responseId: undefined,
              responseOutput: undefined,
              status: 'running',
              error: null,
              finishedAt: null,
            }
          : round,
      ),
      messages: assistantMessageId
        ? current.messages.map((message) =>
            message.id === assistantMessageId ? { ...message, content: '', outputTaskIds: [] } : message,
          )
        : current.messages,
    }))
    state.setAgentEditingRoundId(null)
    void executeAgentRound(conversationId, sourceRound.id, normalizedParams, requestSettings, activeProfile, imageProfile)
    return
  }

  const newRoundId = genId()
  const newUserMessageId = genId()
  const newRound: AgentRound = {
    id: newRoundId,
    index: sourceRound.index,
    parentRoundId: sourceRound.parentRoundId ?? null,
    userMessageId: newUserMessageId,
    prompt: sourceRound.prompt || sourceUserMessage.content.trim(),
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: now,
    finishedAt: null,
  }
  const newUserMessage: AgentMessage = {
    id: newUserMessageId,
    role: 'user',
    content: sourceUserMessage.content,
    roundId: newRoundId,
    inputImageIds,
    maskTargetImageId: sourceRound.maskTargetImageId ?? sourceUserMessage.maskTargetImageId ?? null,
    maskImageId: sourceRound.maskImageId ?? sourceUserMessage.maskImageId ?? null,
    createdAt: now,
  }

  updateAgentConversation(conversationId, (current) => ({
    ...current,
    activeRoundId: newRoundId,
    updatedAt: now,
    rounds: [...current.rounds, newRound],
    messages: [...current.messages, newUserMessage],
  }))
  state.setAgentEditingRoundId(null)
  void executeAgentRound(conversationId, newRoundId, normalizedParams, requestSettings, activeProfile, imageProfile)
}

async function executeAgentRound(
  conversationId: string,
  roundId: string,
  params: TaskParams,
  requestSettings: AppSettings,
  activeProfile: ApiProfile,
  imageProfile: ApiProfile,
  resume?: { responseOutput: ResponsesOutputItem[]; recoveredTaskIds: string[]; toolCallsUsed: number },
) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const controllerKey = getAgentRoundControllerKey(conversationId, roundId)
  agentRoundControllers.set(controllerKey, controller)
  try {
    const latestState = useStore.getState()
    const conversation = latestState.agentConversations.find((item) => item.id === conversationId)
    if (!conversation) return
    const round = conversation.rounds.find((item) => item.id === roundId)
    const userMessage = round ? conversation.messages.find((message) => message.id === round.userMessageId) : null
    if (!round || !userMessage) return
    const maskDataUrl = round.maskImageId ? await ensureImageCached(round.maskImageId) : undefined
    if (round.maskImageId && !maskDataUrl) throw new Error('遮罩图片已不存在')

    const apiInput = await buildAgentApiInput({
      conversation,
      currentRound: round,
      tasks: latestState.tasks,
      loadImage: ensureImageCached,
    })
    if (controller.signal.aborted) throw createAgentAbortError()
    const existingAssistantMessage = round.assistantMessageId
      ? conversation.messages.find((message) => message.id === round.assistantMessageId) ?? null
      : conversation.messages.find((message) => message.roundId === roundId && message.role === 'assistant') ?? null
    const assistantMessageId = existingAssistantMessage?.id ?? genId()
    const resumedAssistantContent = resume ? existingAssistantMessage?.content.trim() ?? '' : ''
    const shouldStreamAssistantMessage = activeProfile.streamImages === true
    const imageRequestSettings = createSettingsForApiProfile(requestSettings, imageProfile)
    const imageParams = normalizeParamsForSettings(params, imageRequestSettings, { hasInputImages: round.inputImageIds.length > 0 })
    const streamingTaskIds: string[] = resume ? [...round.outputTaskIds] : []
    const taskIdByToolCallId = new Map<string, string>()
    const taskByToolCallId = new Map<string, TaskRecord>()

    const getDeletedAgentTasks = () => {
      const deletedTasks = getDeletedActiveAgentTasks(conversationId, roundId, controller)
      const deletedTaskIds = new Set(deletedTasks.map((task) => task.id))
      const currentTaskIds = new Set(useStore.getState().tasks.map((task) => task.id))
      for (const [toolCallId, taskId] of taskIdByToolCallId) {
        const task = taskByToolCallId.get(toolCallId)
        if (task && !currentTaskIds.has(taskId) && !deletedTaskIds.has(taskId)) deletedTasks.push(task)
      }
      return deletedTasks
    }
    const getLatestRound = () => useStore.getState().agentConversations
      .find((item) => item.id === conversationId)
      ?.rounds.find((item) => item.id === roundId)

    const attachTaskToAgentRound = (taskId: string) => {
      if (streamingTaskIds.includes(taskId)) return
      streamingTaskIds.push(taskId)
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId
            ? { ...item, outputTaskIds: item.outputTaskIds.includes(taskId) ? item.outputTaskIds : [...item.outputTaskIds, taskId] }
            : item,
        ),
        messages: current.messages.map((message) =>
          message.id === assistantMessageId
            ? { ...message, outputTaskIds: [...new Set([...(message.outputTaskIds ?? []), taskId])] }
            : message,
        ),
      }))
    }

    const ensureStreamingAgentTask = async (
      toolCallId: string,
      taskPrompt = '',
      inputImageIds = round.inputImageIds ?? [],
      options: { createdAt?: number; agentBatchCallId?: string; agentBatchItemId?: string; maskTargetImageId?: string | null; maskImageId?: string | null; taskParams?: TaskParams } = {},
    ) => {
      const existingTaskId = taskIdByToolCallId.get(toolCallId)
      if (existingTaskId) return existingTaskId

      const existingTask = useStore.getState().tasks.find((task) => task.agentToolCallId === toolCallId)
      if (existingTask) {
        taskIdByToolCallId.set(toolCallId, existingTask.id)
        taskByToolCallId.set(toolCallId, existingTask)
        attachTaskToAgentRound(existingTask.id)
        return existingTask.id
      }

      const task: TaskRecord = {
        id: genId(),
        prompt: taskPrompt,
        params: options.taskParams ?? { ...imageParams, n: 1 },
        apiProvider: imageProfile.provider,
        apiProfileId: imageProfile.id,
        apiProfileName: imageProfile.name,
        apiMode: imageProfile.apiMode,
        apiModel: imageProfile.model,
        inputImageIds,
        maskTargetImageId: options.maskTargetImageId !== undefined ? options.maskTargetImageId : round.maskTargetImageId ?? null,
        maskImageId: options.maskImageId !== undefined ? options.maskImageId : round.maskImageId ?? null,
        outputImages: [],
        status: 'running',
        error: null,
        createdAt: options.createdAt ?? Date.now(),
        finishedAt: null,
        elapsed: null,
        sourceMode: 'agent',
        // 走同一套规则：当前选着哪个渠道，新卡就归到哪个渠道，别被筛选藏起来
        channel: channelForNewTask(useStore.getState().channelFilter),
        agentConversationId: conversationId,
        agentRoundId: roundId,
        agentMessageId: assistantMessageId,
        agentToolCallId: toolCallId,
        ...(options.agentBatchCallId ? { agentBatchCallId: options.agentBatchCallId } : {}),
        ...(options.agentBatchItemId ? { agentBatchItemId: options.agentBatchItemId } : {}),
      }

      taskIdByToolCallId.set(toolCallId, task.id)
      taskByToolCallId.set(toolCallId, task)
      useStore.getState().setTasks([task, ...useStore.getState().tasks])
      attachTaskToAgentRound(task.id)
      await putTask(task)
      return task.id
    }

    const completeAgentImageTask = async (image: AgentApiResultImage, rawResponsePayload?: string) => {
      const toolCallId = image.toolCallId ?? genId()
      const taskId = await ensureStreamingAgentTask(toolCallId)
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (latestTask?.status === 'done' && latestTask.outputImages.length > 0) return { taskId, committed: true }

      const stored = await storeImageWithSize(image.dataUrl, 'generated')
      cacheImage(stored.id, image.dataUrl)
      const latestBeforeUpdate = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latestBeforeUpdate) {
        await deleteUnreferencedImageIds([stored.id])
        return { taskId, committed: false }
      }
      const actualParams = deriveAgentImageActualParams(image.actualParams, stored)
      updateTaskInStore(taskId, {
        prompt: image.revisedPrompt ?? latestBeforeUpdate.prompt,
        outputImages: [stored.id],
        actualParams,
        actualParamsByImage: { [stored.id]: actualParams },
        revisedPromptByImage: image.revisedPrompt ? { [stored.id]: image.revisedPrompt } : undefined,
        rawResponsePayload,
        ...createTaskDonePatch(latestBeforeUpdate, Date.now()),
        agentToolAction: image.action,
      })
      useStore.getState().setTaskStreamPreview(taskId)
      {
        const doneAgentTask = useStore.getState().tasks.find((item) => item.id === taskId)
        if (doneAgentTask) scheduleAutoDeliver(doneAgentTask)
      }
      return { taskId, committed: true }
    }

    const failAgentImageTask = (toolCallId: string, error: string, rawResponsePayload?: string) => {
      const taskId = taskIdByToolCallId.get(toolCallId)
      if (!taskId) return
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latestTask || latestTask.status !== 'running') return

      useStore.getState().setTaskStreamPreview(taskId)
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(latestTask, error, Date.now()),
        rawResponsePayload,
        falRecoverable: false,
        customRecoverable: false,
      })
    }

    const pauseAgentImageTaskForRecovery = (toolCallId: string, err: unknown) => {
      const taskId = taskIdByToolCallId.get(toolCallId)
      if (!taskId || !isNetworkRecoverableError(err)) return false
      const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
      if (!latestTask || latestTask.status !== 'running') return false

      if (latestTask.apiProvider === 'fal' && latestTask.falRequestId && latestTask.falEndpoint) {
        useStore.getState().setTaskStreamPreview(taskId)
        updateTaskInStore(taskId, {
          ...createTaskErrorPatch(latestTask, '与 fal.ai 的连接已断开，之后会继续查询任务结果。', Date.now()),
          falRecoverable: true,
        })
        scheduleFalRecovery(taskId)
        return true
      }

      if (latestTask.customTaskId) {
        useStore.getState().setTaskStreamPreview(taskId)
        updateTaskInStore(taskId, {
          ...createTaskErrorPatch(latestTask, '与自定义异步任务的连接已断开，之后会继续查询任务结果。', Date.now()),
          customRecoverable: true,
        })
        scheduleCustomRecovery(taskId)
        return true
      }

      return false
    }

    if (shouldStreamAssistantMessage) {
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) =>
          item.id === roundId ? { ...item, assistantMessageId } : item,
        ),
        messages: current.messages.some((message) => message.id === assistantMessageId)
          ? current.messages.map((message) => message.id === assistantMessageId
            ? resume
              ? { ...message, outputTaskIds: [...new Set([...(message.outputTaskIds ?? []), ...round.outputTaskIds])] }
              : { ...message, content: '', outputTaskIds: [] }
            : message)
          : [
              ...current.messages,
              {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                roundId,
                createdAt: Date.now(),
              },
            ],
      }))
    }
    const maxToolCalls = Number.isFinite(requestSettings.agentMaxToolRounds)
      ? Math.max(1, Math.trunc(requestSettings.agentMaxToolRounds))
      : DEFAULT_AGENT_MAX_TOOL_ROUNDS
    let accumulatedOutputItems: ResponsesOutputItem[] = resume?.responseOutput ?? []
    let accumulatedText = resumedAssistantContent
    const textSegments: string[] = resumedAssistantContent ? [resumedAssistantContent] : []
    let lastResponseId: string | undefined = round.responseId
    let toolCallsUsed = resume?.toolCallsUsed ?? 0
    let apiInputForTurn = apiInput
    if (resume) {
      const resumeState = useStore.getState()
      apiInputForTurn = await buildAgentContinuationInput({
        baseInput: apiInput,
        currentRound: round,
        tasks: resumeState.tasks,
        currentRoundOutput: accumulatedOutputItems,
        batchTaskIds: resume.recoveredTaskIds,
        toolCallsUsed,
        maxToolCalls,
        loadImage: ensureImageCached,
      })
    }
    let reachedToolLimit = resume ? toolCallsUsed >= maxToolCalls : false
    let pendingToolTextSeparator = false

    // Helper: resolve reference image ids to data URLs for batch image calls
    const resolveReferenceImages = async (referenceIds: string[]): Promise<{ dataUrls: string[]; imageIds: string[] }> => {
      const dataUrls: string[] = []
      const imageIds: string[] = []
      for (const refId of referenceIds) {
        // Resolve both generated image refs and current/user input refs from XML tags.
        const latestConv = useStore.getState().agentConversations.find((item) => item.id === conversationId)
        if (!latestConv) continue
        for (const r of getAgentRoundPath(latestConv, roundId)) {
          for (let imgIdx = 0; imgIdx < r.inputImageIds.length; imgIdx++) {
            const currentRefId = getAgentCurrentReferenceId(r, imgIdx)
            if (currentRefId === refId) {
              const imageId = r.inputImageIds[imgIdx]
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
          const outputImages = collectAgentRoundOutputImageSlots(r, useStore.getState().tasks)
          for (let imgIdx = 0; imgIdx < outputImages.length; imgIdx++) {
            const generatedRefId = getAgentGeneratedImageReferenceId(r, imgIdx)
            if (generatedRefId === refId) {
              const imageId = outputImages[imgIdx]
              if (!imageId) continue
              const dataUrl = await ensureImageCached(imageId)
              if (dataUrl) dataUrls.push(dataUrl)
              imageIds.push(imageId)
            }
          }
        }
      }
      return { dataUrls, imageIds }
    }

    const parseSingleImageCallArguments = (args: string): { id: string; prompt: string } | null => {
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
        if (!prompt) return null
        const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : 'image'
        return { id, prompt }
      } catch {
        return null
      }
    }

    const callHybridImageApiSingle = async (opts: {
      taskId: string
      prompt: string
      referenceImageDataUrls: string[]
      taskParams: TaskParams
      signal: AbortSignal
      onPartialImage?: (event: { image: string; partialImageIndex?: number }) => void | Promise<void>
    }) => {
      const result = await callImageApi({
        settings: imageRequestSettings,
        // 有的渠道不严格遵守 size，画幅比例会乱跳，先把比例写进提示词；auto 时跟参考图一致
        prompt: withAspectRatioHint(
          replaceImageMentionsForApi(opts.prompt, opts.referenceImageDataUrls.length),
          opts.taskParams.size,
          opts.referenceImageDataUrls,
        ),
        params: opts.taskParams,
        inputImageDataUrls: opts.referenceImageDataUrls,
        skipCodexCliSizePrompt: true,
        onPartialImage: opts.onPartialImage
          ? (partial) => {
              void opts.onPartialImage?.({ image: partial.image, partialImageIndex: partial.partialImageIndex ?? partial.requestIndex })
            }
          : undefined,
        onFalRequestEnqueued: (request) => {
          updateTaskInStore(opts.taskId, {
            falRequestId: request.requestId,
            falEndpoint: request.endpoint,
            falRecoverable: false,
          })
        },
        onCustomTaskEnqueued: (request) => {
          updateTaskInStore(opts.taskId, {
            customTaskId: request.taskId,
            customRecoverable: false,
          })
        },
      })
      if (opts.signal.aborted) throw createAgentAbortError()
      const dataUrl = result.images[0]
      return {
        image: dataUrl ? {
          dataUrl,
          actualParams: result.actualParamsList?.[0] ?? result.actualParams,
          revisedPrompt: result.revisedPrompts?.[0] ?? opts.prompt,
        } satisfies AgentApiResultImage : null,
        error: result.failedRequests?.[0]?.error ?? (dataUrl ? null : '接口未返回图片数据'),
        rawResponsePayload: JSON.stringify({
          imageCount: result.images.length,
          actualParams: result.actualParams,
          actualParamsList: result.actualParamsList,
          revisedPrompts: result.revisedPrompts,
          rawImageUrls: result.rawImageUrls,
          failedRequests: result.failedRequests,
        }, null, 2),
      }
    }

    const executeSingleImageFunctionCall = async (functionCallItem: ResponsesOutputItem): Promise<string | null> => {
      const callId = functionCallItem.call_id ?? ''
      const item = parseSingleImageCallArguments(functionCallItem.arguments ?? '')
      if (!item) return JSON.stringify({ error: 'Invalid or empty image arguments' })

      const referenceIds = uniqueIds(extractAgentReferenceIds(item.prompt))
      const references = await resolveReferenceImages(referenceIds)
      const toolCallId = callId || genId()
      const taskParams = {
        ...normalizeParamsForSettings(imageParams, imageRequestSettings, { hasInputImages: references.dataUrls.length > 0 }),
        n: 1,
      }

      const taskId = await ensureStreamingAgentTask(toolCallId, item.prompt, references.imageIds, {
        createdAt: Date.now(),
        taskParams,
        maskTargetImageId: null,
        maskImageId: null,
      })

      try {
        const result = await callHybridImageApiSingle({
          taskId,
          prompt: item.prompt,
          referenceImageDataUrls: references.dataUrls,
          taskParams,
          signal: controller.signal,
          onPartialImage: async ({ image, partialImageIndex }) => {
            if (controller.signal.aborted) return
            const taskId = taskIdByToolCallId.get(toolCallId)
            if (taskId) {
              useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
              if (partialImageIndex === 0 || partialImageIndex == null) void persistTaskStreamPartialImage(taskId, image)
            }
          },
        })

        if (controller.signal.aborted) throw createAgentAbortError()
        if (result.image) {
          const completed = await completeAgentImageTask({ ...result.image, toolCallId }, result.rawResponsePayload)
          if (completed.committed) {
            toolCallsUsed += 1
            return JSON.stringify({ id: item.id, status: 'done' })
          }
          return null
        }

        failAgentImageTask(toolCallId, result.error!, result.rawResponsePayload)
        return JSON.stringify({ id: item.id, status: 'error', error: result.error })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        if (controller.signal.aborted) throw createAgentAbortError()
        if (pauseAgentImageTaskForRecovery(toolCallId, err)) throw createAgentRecoveryPauseError()
        failAgentImageTask(toolCallId, error)
        return JSON.stringify({ id: item.id, status: 'error', error })
      }
    }

    // Helper: execute a generate_image_batch function call concurrently
    const executeBatchFunctionCall = async (functionCallItem: ResponsesOutputItem): Promise<string> => {
      const callId = functionCallItem.call_id ?? ''
      const args = functionCallItem.arguments ?? ''
      const batchItems = parseBatchImageCallArguments(args)

      if (!batchItems || batchItems.length === 0) {
        return JSON.stringify({ error: 'Invalid or empty batch arguments' })
      }

      // Create task cards in model-provided order before starting network calls.
      const batchExecutionItems = []
      for (const item of batchItems) {
        const referenceIds = uniqueIds(extractAgentReferenceIds(item.prompt))
        const references = await resolveReferenceImages(referenceIds)
        const batchToolCallId = genId()
        const taskParams = requestSettings.agentApiConfigMode === 'hybrid'
          ? {
              ...normalizeParamsForSettings(imageParams, imageRequestSettings, { hasInputImages: references.dataUrls.length > 0 }),
              n: 1,
            }
          : { ...imageParams, n: 1 }
        await ensureStreamingAgentTask(batchToolCallId, item.prompt, references.imageIds, {
          createdAt: Date.now(),
          taskParams,
          maskTargetImageId: null,
          maskImageId: null,
          ...(callId ? { agentBatchCallId: callId } : {}),
          agentBatchItemId: item.id,
        })
        batchExecutionItems.push({ item, batchToolCallId, references, referenceIds, taskParams })
      }

      // Fire all batch items concurrently after all cards are visible.
      const batchPromises = batchExecutionItems.map(async ({ item, batchToolCallId, references, referenceIds, taskParams }) => {
        let committed = false
        const batchResult = requestSettings.agentApiConfigMode === 'hybrid'
          ? {
              batchItemId: item.id,
              ...(await callHybridImageApiSingle({
                taskId: taskIdByToolCallId.get(batchToolCallId)!,
                prompt: item.prompt,
                referenceImageDataUrls: references.dataUrls,
                taskParams,
                signal: controller.signal,
                onPartialImage: async ({ image, partialImageIndex }) => {
                  if (controller.signal.aborted) return
                  const taskId = taskIdByToolCallId.get(batchToolCallId)
                  if (taskId) {
                    useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                    if (partialImageIndex === 0 || partialImageIndex == null) void persistTaskStreamPartialImage(taskId, image)
                  }
                },
              })),
            }
          : await callBatchImageSingle({
              profile: imageProfile,
              params: taskParams,
              batchItemId: item.id,
              prompt: item.prompt,
              referenceImageDataUrls: references.dataUrls,
              referenceIds,
              allowPromptRewrite: requestSettings.allowPromptRewrite,
              signal: controller.signal,
              onImageToolStarted: shouldStreamAssistantMessage
                ? async () => {
                    if (controller.signal.aborted) return
                  }
                : undefined,
              onPartialImage: shouldStreamAssistantMessage
                ? async ({ image, partialImageIndex }) => {
                    if (controller.signal.aborted) return
                    const taskId = taskIdByToolCallId.get(batchToolCallId)
                    if (taskId) {
                      useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
                      if (partialImageIndex === 0 || partialImageIndex == null) {
                        void persistTaskStreamPartialImage(taskId, image)
                      }
                    }
                  }
                : undefined,
              onImageToolCompleted: shouldStreamAssistantMessage
                ? async (image) => {
                    if (controller.signal.aborted) return
                    committed = (await completeAgentImageTask({ ...image, toolCallId: batchToolCallId })).committed
                  }
                : undefined,
            })

        if (controller.signal.aborted) throw createAgentAbortError()
        // If not streaming and we have an image, complete the pre-created task.
        if (batchResult.image && (requestSettings.agentApiConfigMode === 'hybrid' || !shouldStreamAssistantMessage)) {
          committed = (await completeAgentImageTask({ ...batchResult.image, toolCallId: batchToolCallId }, batchResult.rawResponsePayload)).committed
        }

        const latestTask = useStore.getState().tasks.find((task) => task.id === taskIdByToolCallId.get(batchToolCallId))
        return { ...batchResult, committed: committed || Boolean(latestTask?.status === 'done' && latestTask.outputImages.length > 0) }
      })

      const batchResults = await Promise.allSettled(batchPromises)
      if (controller.signal.aborted) throw createAgentAbortError()

      // Build function_call_output
      const outputImages: Array<{ id: string; status: string; error?: string }> = []
      let pausedForRecovery = false
      for (let i = 0; i < batchItems.length; i++) {
        const settled = batchResults[i]
        const batchItem = batchItems[i]
        const taskId = taskIdByToolCallId.get(batchExecutionItems[i].batchToolCallId)
        if (!taskId || !useStore.getState().tasks.some((task) => task.id === taskId)) continue
        if (settled.status === 'fulfilled') {
          const r = settled.value
          if (r.image && !r.committed) continue
          if (!r.image) {
            failAgentImageTask(batchExecutionItems[i].batchToolCallId, r.error!, r.rawResponsePayload)
          }
          outputImages.push({
            id: r.batchItemId,
            status: r.image ? 'done' : 'error',
            ...(r.error ? { error: r.error } : {}),
          })
        } else {
          const error = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
          if (isAgentRecoveryPauseError(settled.reason) || pauseAgentImageTaskForRecovery(batchExecutionItems[i].batchToolCallId, settled.reason)) {
            pausedForRecovery = true
            continue
          }
          failAgentImageTask(batchExecutionItems[i].batchToolCallId, error)
          outputImages.push({
            id: batchItem.id,
            status: 'error',
            error,
          })
        }
      }
      if (pausedForRecovery) throw createAgentRecoveryPauseError()

      const successCount = outputImages.filter((img) => img.status === 'done').length
      toolCallsUsed += successCount

      return JSON.stringify({ images: outputImages })
    }

    while (true) {
      if (controller.signal.aborted) throw createAgentAbortError()
      if (reachedToolLimit) break
      const textBeforeResponse = accumulatedText
      let currentResponseOutputItems: ResponsesOutputItem[] = []
      const result = await callAgentResponsesApi({
        settings: requestSettings,
        profile: activeProfile,
        imageProfile,
        params: imageParams,
        input: apiInputForTurn,
        maskDataUrl,
        signal: controller.signal,
        onTextDelta: shouldStreamAssistantMessage
          ? (delta) => {
              if (controller.signal.aborted) return
              if (pendingToolTextSeparator && delta && accumulatedText.trim()) {
                accumulatedText += '\n\n'
                appendAgentAssistantMessageContent(conversationId, assistantMessageId, '\n\n')
              }
              pendingToolTextSeparator = false
              accumulatedText += delta
              appendAgentAssistantMessageContent(conversationId, assistantMessageId, delta)
            }
          : undefined,
        onOutputItems: shouldStreamAssistantMessage
          ? (outputItems) => {
              if (controller.signal.aborted) return
              currentResponseOutputItems = canonicalizeBatchFunctionCallArguments(outputItems)
              updateAgentConversation(conversationId, (current) => ({
                ...current,
                rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseOutput: mergeResponseOutputItems(accumulatedOutputItems, currentResponseOutputItems) } : item),
              }))
            }
          : undefined,
        onImageToolStarted: shouldStreamAssistantMessage
          ? async ({ toolCallId }) => {
              if (controller.signal.aborted) return
              await ensureStreamingAgentTask(toolCallId)
            }
          : undefined,
        onImagePartialImage: shouldStreamAssistantMessage
          ? async ({ toolCallId, image, partialImageIndex }) => {
              if (controller.signal.aborted) return
              const taskId = await ensureStreamingAgentTask(toolCallId)
              if (controller.signal.aborted) return
              useStore.getState().setTaskStreamPreview(taskId, image, partialImageIndex)
              if (partialImageIndex === 0 || partialImageIndex == null) {
                void persistTaskStreamPartialImage(taskId, image)
              }
            }
          : undefined,
        onImageToolCompleted: shouldStreamAssistantMessage
          ? async (image) => {
              if (controller.signal.aborted) return
              await completeAgentImageTask(image)
            }
          : undefined,
        onImageToolFailed: shouldStreamAssistantMessage
          ? async ({ toolCallId, error }) => {
              if (controller.signal.aborted) return
              await ensureStreamingAgentTask(toolCallId)
              if (controller.signal.aborted) return
              failAgentImageTask(toolCallId, error)
            }
          : undefined,
      })
      if (controller.signal.aborted) throw createAgentAbortError()

      lastResponseId = result.responseId ?? lastResponseId
      currentResponseOutputItems = canonicalizeBatchFunctionCallArguments(
        currentResponseOutputItems.length ? currentResponseOutputItems : result.outputItems ?? [],
      )
      const deletedTasks = getDeletedAgentTasks()
      const currentRound = getLatestRound()
      if (currentRound) {
        currentResponseOutputItems = scrubResponseOutputForDeletedAgentTasks(
          currentRound,
          currentResponseOutputItems,
          deletedTasks,
          [...useStore.getState().tasks, ...deletedTasks],
        )
      }
      accumulatedOutputItems = mergeResponseOutputItems(accumulatedOutputItems, currentResponseOutputItems)
      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItems } : item),
      }))

      const responseText = result.text.trim()
      if (responseText && accumulatedText === textBeforeResponse) {
        const textToAppend = accumulatedText ? `\n\n${responseText}` : responseText
        accumulatedText += textToAppend
        if (shouldStreamAssistantMessage) appendAgentAssistantMessageContent(conversationId, assistantMessageId, textToAppend)
      }
      const newTextInThisResponse = accumulatedText.slice(textBeforeResponse.length).trim()
      if (newTextInThisResponse) textSegments.push(newTextInThisResponse)

      // Process built-in image_generation_call results (single images)
      for (const image of result.images) {
        if (image.toolCallId && taskIdByToolCallId.has(image.toolCallId)) {
          const completed = await completeAgentImageTask(image, result.rawResponsePayload)
          if (!completed.committed) continue
          const completedTaskId = completed.taskId
          const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
          if (promptRefIds.length > 0) {
            const promptRefs = await resolveReferenceImages(promptRefIds)
            if (promptRefs.imageIds.length > 0) {
              const latestTask = useStore.getState().tasks.find((t) => t.id === completedTaskId)
              if (latestTask) {
                const mergedInputIds = uniqueIds([...latestTask.inputImageIds, ...promptRefs.imageIds])
                if (mergedInputIds.length !== latestTask.inputImageIds.length) {
                  updateTaskInStore(completedTaskId, { inputImageIds: mergedInputIds })
                }
              }
            }
          }
          continue
        }
        const promptRefIds = uniqueIds(extractAgentReferenceIds(image.revisedPrompt ?? ''))
        const promptRefs = await resolveReferenceImages(promptRefIds)
        const stored = await storeImageWithSize(image.dataUrl, 'generated')
        cacheImage(stored.id, image.dataUrl)
        const actualParams = deriveAgentImageActualParams(image.actualParams, stored)
        const task: TaskRecord = {
          id: genId(),
          prompt: image.revisedPrompt ?? round?.prompt ?? userMessage.content,
          params: imageParams,
          apiProvider: imageProfile.provider,
          apiProfileId: imageProfile.id,
          apiProfileName: imageProfile.name,
          apiMode: imageProfile.apiMode,
          apiModel: imageProfile.model,
          inputImageIds: uniqueIds([...(round?.inputImageIds ?? []), ...promptRefs.imageIds]),
          maskTargetImageId: round?.maskTargetImageId ?? null,
          maskImageId: round?.maskImageId ?? null,
          outputImages: [stored.id],
          actualParams,
          actualParamsByImage: { [stored.id]: actualParams },
          revisedPromptByImage: image.revisedPrompt ? { [stored.id]: image.revisedPrompt } : undefined,
          rawResponsePayload: result.rawResponsePayload,
          status: 'done',
          error: null,
          createdAt: startedAt,
          finishedAt: Date.now(),
          elapsed: Date.now() - startedAt,
          sourceMode: 'agent',
          agentConversationId: conversationId,
          agentRoundId: roundId,
          agentMessageId: assistantMessageId,
          agentToolCallId: image.toolCallId,
          agentToolAction: image.action,
        }
        useStore.getState().setTasks([task, ...useStore.getState().tasks])
        attachTaskToAgentRound(task.id)
        await putTask(task)
      }

      if (result.rawResponsePayload && streamingTaskIds.length > 0) {
        for (const taskId of streamingTaskIds) {
          const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
          if (latestTask && !latestTask.rawResponsePayload) updateTaskInStore(taskId, { rawResponsePayload: result.rawResponsePayload })
        }
      }

      // Check for function calls that require continuation
      const imageFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'generate_image',
      )
      const batchFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'generate_image_batch',
      )
      const continueFunctionCalls = currentResponseOutputItems.filter(
        (item) => item.type === 'function_call' && item.name === 'continue_generation',
      )

      // Count built-in tool calls (image_generation, web_search) for budget tracking
      const responseToolCalls = countResponseToolCalls(currentResponseOutputItems)
      toolCallsUsed += responseToolCalls

      // Collect function_call_output items for all function calls that need responses
      const functionCallOutputs: ResponsesOutputItem[] = []

      if (imageFunctionCalls.length > 0) {
        for (const fc of imageFunctionCalls) {
          const output = await executeSingleImageFunctionCall(fc)
          if (output == null) continue
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output,
          })
        }
      }

      if (batchFunctionCalls.length > 0) {
        for (const fc of batchFunctionCalls) {
          const output = await executeBatchFunctionCall(fc)
          functionCallOutputs.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output,
          })
        }
      }

      for (const fc of continueFunctionCalls) {
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: JSON.stringify({ status: 'continued' }),
        })
      }

      const latestDeletedTasks = getDeletedAgentTasks()
      const cleanedConversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
      const latestRoundForCleanup = cleanedConversation?.rounds.find((item) => item.id === roundId)
      const outputBeforeFunctionResults = latestRoundForCleanup?.responseOutput ?? accumulatedOutputItems
      const mergedOutputItems = mergeResponseOutputItems(outputBeforeFunctionResults, functionCallOutputs)
      const accumulatedOutputItemsWithFunctionOutputs = latestRoundForCleanup
        ? scrubResponseOutputForDeletedAgentTasks(
            latestRoundForCleanup,
            mergedOutputItems,
            latestDeletedTasks,
            [...useStore.getState().tasks, ...latestDeletedTasks],
          )
        : mergedOutputItems
      const generatedOutputCallIds = new Set(functionCallOutputs.map((item) => item.call_id).filter(Boolean))
      const effectiveFunctionCallOutputs = accumulatedOutputItemsWithFunctionOutputs.filter(
        (item) => item.type === 'function_call_output' && item.call_id && generatedOutputCallIds.has(item.call_id),
      )

      // If no function calls need output → model decided the task is done → break
      if (effectiveFunctionCallOutputs.length === 0) {
        accumulatedOutputItems = accumulatedOutputItemsWithFunctionOutputs
        updateAgentConversation(conversationId, (current) => ({
          ...current,
          updatedAt: Date.now(),
          rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItems } : item),
        }))
        break
      }

      updateAgentConversation(conversationId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        rounds: current.rounds.map((item) => item.id === roundId ? { ...item, responseId: lastResponseId, responseOutput: accumulatedOutputItemsWithFunctionOutputs } : item),
      }))

      if (toolCallsUsed >= maxToolCalls) {
        reachedToolLimit = true
        break
      }

      // Build continuation input with function call outputs and available refs
      const continuationState = useStore.getState()
      const latestConversation = continuationState.agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
      if (!latestRound) break

      apiInputForTurn = await buildAgentContinuationInput({
        baseInput: apiInput,
        currentRound: latestRound,
        tasks: continuationState.tasks,
        currentRoundOutput: accumulatedOutputItemsWithFunctionOutputs,
        functionCallOutputs: effectiveFunctionCallOutputs,
        batchTaskIds: streamingTaskIds,
        toolCallsUsed,
        maxToolCalls,
        loadImage: ensureImageCached,
      })
      accumulatedOutputItems = accumulatedOutputItemsWithFunctionOutputs
      pendingToolTextSeparator = true
    }

    markAgentRoundTasksFailed(
      conversationId,
      roundId,
      requestSettings.agentApiConfigMode === 'hybrid' ? '自定义图像生成工具未返回图片' : '内置 image_generation 工具未返回图片',
      undefined,
      (task) => Boolean(task.agentToolCallId && !task.agentBatchCallId),
    )

    const latestTasks = useStore.getState().tasks
    const existingTaskIds = new Set(latestTasks.map((task) => task.id))
    const taskIds = streamingTaskIds.filter((taskId) => existingTaskIds.has(taskId))
    const outputIds = taskIds.flatMap((taskId) => latestTasks.find((task) => task.id === taskId)?.outputImages ?? [])
    const latestConversation = useStore.getState().agentConversations.find((item) => item.id === conversationId)
    const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
    const deletedTasks = getDeletedAgentTasks()
    const responseOutput = latestRound
      ? scrubResponseOutputForDeletedAgentTasks(latestRound, accumulatedOutputItems, deletedTasks, [...latestTasks, ...deletedTasks])
      : accumulatedOutputItems
    const limitNotice = reachedToolLimit ? `已达到最大工具调用次数（${maxToolCalls}），已停止自动续跑。` : ''
    const joinedText = textSegments.join('\n\n').trim()
    const finalContent = [joinedText, limitNotice]
      .filter(Boolean)
      .join(joinedText ? '\n\n' : '')
      || (taskIds.length > 0 || outputIds.length > 0 ? '图像已生成。' : '')

    const assistantMessage: AgentMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: finalContent,
      roundId,
      outputTaskIds: taskIds,
      createdAt: Date.now(),
    }

    updateAgentConversation(conversationId, (current) => ({
      ...current,
      updatedAt: Date.now(),
      rounds: current.rounds.map((round) =>
        round.id === roundId
          ? {
              ...round,
              assistantMessageId,
              outputTaskIds: taskIds,
              responseId: lastResponseId,
              responseOutput,
              status: 'done',
              error: null,
              finishedAt: Date.now(),
            }
          : round,
      ),
      messages: current.messages.some((message) => message.id === assistantMessageId)
        ? current.messages.map((message) => message.id === assistantMessageId ? assistantMessage : message)
        : [...current.messages, assistantMessage],
    }))

    useStore.getState().showToast(outputIds.length > 0 ? 'Agent 已生成图片' : 'Agent 已回复', 'success')
    showTaskCompletionNotification(
      outputIds.length > 0 ? 'Agent 已生成图片' : 'Agent 已回复',
      outputIds.length > 0 ? `Agent 回复已结束，共生成 ${outputIds.length} 张图片。` : 'Agent 回复已结束。',
    )
  } catch (err) {
    if (controller.signal.aborted) {
      if (markAgentRoundStopped(conversationId, roundId)) {
        useStore.getState().showToast('已停止生成', 'info')
      }
      return
    }

    if (isAgentRecoveryPauseError(err)) return

    let message = err instanceof Error ? err.message : String(err)
    const usesApiProxy = activeProfile.apiProxy ?? requestSettings.apiProxy
    const networkErrorHint = getApiRequestNetworkErrorHint(err, startedAt, usesApiProxy, activeProfile)
    if (networkErrorHint && !message.includes(IMAGE_FETCH_CORS_HINT)) {
      message += `\n${networkErrorHint}`
    }

    markAgentRoundTasksFailed(conversationId, roundId, message, getRawErrorPayload(err).rawResponsePayload)

    updateAgentConversation(conversationId, (current) => {
      const failedRound = current.rounds.find((round) => round.id === roundId)
      const existingAssistantMessage = failedRound?.assistantMessageId
        ? current.messages.find((item) => item.id === failedRound.assistantMessageId)
        : current.messages.find((item) => item.roundId === roundId && item.role === 'assistant')
      const errorContent = `请求失败：${message}`

      return {
        ...current,
        title: current.rounds.length === 1 && current.rounds[0].id === roundId ? '新对话' : current.title,
        updatedAt: Date.now(),
        rounds: current.rounds.map((round) =>
          round.id === roundId
            ? {
                ...round,
                ...(existingAssistantMessage ? { assistantMessageId: existingAssistantMessage.id } : {}),
                status: 'error',
                error: message,
                finishedAt: Date.now(),
              }
            : round,
        ),
        messages: existingAssistantMessage
          ? current.messages.map((item) => item.id === existingAssistantMessage.id ? { ...item, content: errorContent } : item)
          : [
              ...current.messages,
              {
                id: genId(),
                role: 'assistant',
                content: errorContent,
                roundId,
                createdAt: Date.now(),
              },
            ],
      }
    })
    useStore.getState().showToast(`Agent 请求失败：${message}`, 'error')
    showTaskCompletionNotification('Agent 回复失败', '请回到应用查看详情。', 'task-failure')
  } finally {
    if (agentRoundControllers.get(controllerKey) === controller) {
      agentRoundControllers.delete(controllerKey)
    }
    const deletedTasks = getDeletedActiveAgentTasks(conversationId, roundId, controller)
    try {
      const cleanup = scrubAgentOutputPayloadsForDeletedTasks(deletedTasks)
      if (cleanup.updatedTasks.length > 0 || cleanup.updatedConversations.length > 0) {
        await persistTaskDeletionCleanup([], cleanup)
      }
    } catch (err) {
      console.warn('清理已删除 Agent 任务的响应失败', err)
    } finally {
      for (const task of deletedTasks) {
        if (deletedActiveAgentTasks.get(task.id)?.controller === controller) deletedActiveAgentTasks.delete(task.id)
      }
    }
  }
}

async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const sopState = useSopStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const execution = Symbol(taskId)
  taskExecutions.set(taskId, execution)
  // 新一次执行换一个新控制器：旧的已结束，残留的 map 项会在这里被覆盖
  const abortController = new AbortController()
  taskAbortControllers.set(taskId, abortController)
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    const error = '找不到此任务所使用的 API 配置。'
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, error, Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    showTaskFailureNotification(task)
    taskExecutions.delete(taskId)
    return
  }
  const activeProfile = taskProfile ?? getActiveApiProfile(settings)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = taskProfile?.provider ?? task.apiProvider ?? activeProfile.provider
  let falRequestInfo: { requestId: string; endpoint: string } | null = task.falRequestId && task.falEndpoint
        ? { requestId: task.falRequestId, endpoint: task.falEndpoint }
    : null
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null

  if (
    taskProvider !== 'fal' &&
    !isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0) &&
    !usesConcurrentImageRequests(requestSettings, activeProfile, task.params, task.inputImageIds.length > 0)
  ) {
    scheduleOpenAIWatchdog(taskId, activeProfile.timeout, activeProfile)
  }

  try {
    // 获取输入图片 data URLs
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error('输入图片已不存在')
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    const requestPrompt = task.transparentOutput && task.transparentPrompt
      ? task.transparentPrompt
      : task.prompt

    // 尺寸为 auto 时要靠参考图定比例；SOP 任务没有输入图，但有参考图记录
    let ratioReferenceDataUrls = inputDataUrls
    if (!ratioReferenceDataUrls.length && task.sopReferenceImageIds?.length) {
      const ref = await ensureImageCached(task.sopReferenceImageIds[0])
      if (ref) ratioReferenceDataUrls = [ref]
    }

    // 后处理预留区：这张图出图后会按模板叠 Logo / 警示语，提示词里先让模型避开这些位置
    const postTemplateList = resolvePostTemplates(sopState.postTemplates, sopState.directions, task.sopDirectionId).templates
    const avoidHint = sopState.avoidOverlay === false
      ? ''
      : buildAvoidHintForTask(
        task,
        postTemplateList,
        ratioReferenceDataUrls,
      )

    // 渠道不支持这个尺寸时改按同比例更大的尺寸生成，出图后再缩回目标尺寸；
    // 有后处理模板时不做（模板字号按成品像素写死，先缩会错位），Codex CLI 只认 1K 也不做
    const postProcessOn = task.params.post_process !== false && postTemplateList.some((item) => item.enabled)
    const sizePlan = planGenerationSize(task.params.size, {
      postProcess: postProcessOn,
      allowResize: !activeProfile.codexCli,
    })
    const requestParams = sizePlan.scaled ? { ...task.params, size: sizePlan.requestSize } : task.params

    const result = await callImageApi({
      settings: requestSettings,
      // 有的渠道不严格遵守 size，画幅比例会乱跳，先把比例写进提示词；auto 时跟参考图一致
      prompt: withAvoidHint(
        withAspectRatioHint(
          replaceImageMentionsForApi(requestPrompt, inputDataUrls.length),
          requestParams.size,
          ratioReferenceDataUrls,
        ),
        avoidHint,
      ),
      params: requestParams,
      nativeTransparentBackground: task.params.transparent_output && !task.transparentOutput,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
      skipCodexCliSizePrompt: task.sourceMode === 'agent',
      onFalRequestEnqueued: (request) => {
        if (taskExecutions.get(taskId) !== execution) return
        falRequestInfo = request
        updateTaskInStore(taskId, {
          falRequestId: request.requestId,
          falEndpoint: request.endpoint,
          falRecoverable: false,
        })
      },
      onCustomTaskEnqueued: (request) => {
        if (taskExecutions.get(taskId) !== execution) return
        customTaskInfo = request
        updateTaskInStore(taskId, {
          customTaskId: request.taskId,
          customRecoverable: false,
        })
      },
      onPartialImage: (partial) => {
        if (taskExecutions.get(taskId) !== execution) return
        useStore.getState().setTaskStreamPreview(taskId, partial.image, partial.requestIndex)
        void persistTaskStreamPartialImage(taskId, partial.image, execution)
      },
      // 用户点停止 → 立刻掐断请求，不再干等超时、也不再继续烧 token
      signal: abortController.signal,
    })

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (taskExecutions.get(taskId) !== execution) return
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }

    // 存储输出图片
    const { outputIds, outputDataUrls, outputImageSizes, sourceImages, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
    const isAsyncCustomTask = taskProvider !== 'fal' && taskProvider !== 'openai' && Boolean(customTaskInfo)
    const actualParamsList = await resolveImageSizeParamsList(
      outputDataUrls,
      isAsyncCustomTask ? undefined : result.actualParamsList,
      outputImageSizes,
    )
    const actualParams = deriveGalleryActualParams(taskProvider, isAsyncCustomTask, result.actualParams, actualParamsList, outputIds.length)
    const shouldStoreRevisedPrompts = taskProvider !== 'fal' && !isAsyncCustomTask
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPrompts = activeProfile.codexCli && task.sourceMode !== 'agent'
      ? result.revisedPrompts?.map((prompt) => prompt == null ? prompt : stripInjectedCodexCliSizePrompt(prompt, requestPrompt, task.params.size))
      : result.revisedPrompts
    const revisedPromptByImage = shouldStoreRevisedPrompts ? mapRevisedPromptsByImage(outputIds, revisedPrompts) : undefined
    const promptWasRevised = shouldStoreRevisedPrompts && revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== requestPrompt.trim(),
    )
    const hasRevisedPromptValue = shouldStoreRevisedPrompts && revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (taskExecutions.get(taskId) === execution && taskProvider === 'openai' && activeProfile.apiMode === 'responses' && !activeProfile.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (taskExecutions.get(taskId) !== execution || !latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      if (taskExecutions.get(taskId) === execution) useStore.getState().setTaskStreamPreview(taskId)
      await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
      return
    }
    const partialImageIdsToClean = latestBeforeUpdate.streamPartialImageIds || []
    clearOpenAIWatchdogTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      sourceImages,
      transparentOriginalImages: transparentOriginalImageIds,
      outputErrors: result.failedRequests?.length ? result.failedRequests : undefined,
      streamPartialImageIds: undefined,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage,
      ...createTaskDonePatch(task, Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    void deleteUnreferencedImageIds(partialImageIdsToClean)

    // 出完图立刻排进后台：先质检、再算重复度，不阻塞下一个任务
    if (outputIds.length) {
      const doneTask = useStore.getState().tasks.find((item) => item.id === taskId)
      if (doneTask) {
        // 比对范围按设置在「同一张任务卡」与「同产品-方向」之间切
        const scope = useInspectConfig.getState().config.duplicateScope
        const peers = peersForTask(useStore.getState().tasks, doneTask, scope, 12)
        useClipStore.getState().enqueueTask(doneTask, peers, scope)
      }
    }

    const failedCount = result.failedRequests?.length ?? 0
    const completionMessage = failedCount > 0
      ? `生成完成：成功 ${outputIds.length} 张，失败 ${failedCount} 张`
      : `生成完成，共 ${outputIds.length} 张图片`
    // 批量任务只在整批结束时统一提示
    if (!batchTaskIds.has(taskId)) {
      useStore.getState().showToast(completionMessage, failedCount > 0 ? 'error' : 'success')
      if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `${completionMessage}。`)
    }
    // 自动交付：这一条提示词自己的成品图（同卡的多次交付落在同一个文件夹，同名覆盖）
    if (outputIds.length) {
      const doneTask = useStore.getState().tasks.find((item) => item.id === taskId)
      if (doneTask) scheduleAutoDeliver(doneTask)
    }
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    if (taskExecutions.get(taskId) !== execution) return
    clearOpenAIWatchdogTimer(taskId)
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestTask || latestTask.status !== 'running') return
    // 用户点了停止：任务已经被 stopTask 转成「已停止」，这里不能再当失败处理
    // （否则会盖掉文案、弹失败通知、还可能触发异步任务的重连查询）
    if (isUserAbort(err)) {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }
    useStore.getState().setTaskStreamPreview(taskId)
    const latestFalRequestInfo = falRequestInfo ?? (latestTask.falRequestId && latestTask.falEndpoint
      ? { requestId: latestTask.falRequestId, endpoint: latestTask.falEndpoint }
      : null)
    const latestCustomTaskInfo = customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    if (latestTask.apiProvider === 'fal' && latestFalRequestInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与 fal.ai 的连接已断开，之后会继续查询任务结果。', Date.now()),
        falRequestId: latestFalRequestInfo.requestId,
        falEndpoint: latestFalRequestInfo.endpoint,
        falRecoverable: true,
      })
      scheduleFalRecovery(taskId)
    } else if (latestCustomTaskInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与自定义异步任务的连接已断开，之后会继续查询任务结果。', Date.now()),
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
      })
      scheduleCustomRecovery(taskId)
    } else {
      let errorMessage = err instanceof Error ? err.message : String(err)
      const settings = useStore.getState().settings
      const profile = getTaskApiProfile(settings, latestTask)
      const usesApiProxy = profile?.apiProxy ?? settings.apiProxy
      const activeProfile = getActiveApiProfile(settings)
      const hintProfile = profile ?? {
        provider: latestTask.apiProvider ?? activeProfile.provider,
        apiMode: settings.apiMode,
        streamImages: activeProfile.streamImages,
        streamPartialImages: activeProfile.streamPartialImages,
      }
      const networkErrorHint = getApiRequestNetworkErrorHint(err, latestTask.startedAt ?? latestTask.createdAt, usesApiProxy, hintProfile)
      if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
        errorMessage += `\n${networkErrorHint}`
      }
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, errorMessage, Date.now()),
        ...getRawErrorPayload(err),
        falRecoverable: false,
        customRecoverable: false,
      })
      // 批量任务不自动打开失败详情，避免连续弹窗打断
      if (!batchTaskIds.has(taskId)) useStore.getState().setDetailTaskId(taskId)
      showTaskFailureNotification(task)
    }
  } finally {
    if (taskExecutions.get(taskId) === execution) {
      taskExecutions.delete(taskId)
      // 这次执行结束了，控制器也一起清掉，免得「停止」按到一个已经跑完的任务
      taskAbortControllers.delete(taskId)
    }
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    if (!taskExecutions.has(taskId)) {
      for (const imgId of task.inputImageIds) deleteCachedImage(imgId)
    }
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks, defaultFavoriteCollectionId } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...normalizeFavoritePatch(t, patch, defaultFavoriteCollectionId) } : t,
  )
  const task = updated.find((t) => t.id === taskId)
  setTasks(updated)
  maybeOpenSupportPrompt(tasks, updated, taskId)
  if (task) putTask(task)
}

export function createFavoriteCollection(name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName) return null
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return null
  }
  const state = useStore.getState()
  const existing = state.favoriteCollections.find((collection) => collection.name === normalizedName)
  if (existing) return existing
  const now = Date.now()
  const collection: FavoriteCollection = { id: genId(), name: normalizedName, createdAt: now, updatedAt: now }
  state.setFavoriteCollections([...state.favoriteCollections, collection])
  state.showToast(`已创建收藏夹「${normalizedName}」`, 'success')
  return collection
}

export function renameFavoriteCollection(collectionId: string, name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName || collectionId === ALL_FAVORITES_COLLECTION_ID) return
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return
  }
  const { favoriteCollections, setFavoriteCollections, showToast } = useStore.getState()
  setFavoriteCollections(favoriteCollections.map((collection) =>
    collection.id === collectionId ? { ...collection, name: normalizedName, updatedAt: Date.now() } : collection,
  ))
  showToast('收藏夹名称已更新', 'success')
}

export async function updateTasksFavoriteCollections(taskIds: string[], collectionIds: string[]) {
  const ids = normalizeFavoriteCollectionIds(collectionIds)
  const uniqueTaskIds = Array.from(new Set(taskIds)).filter(Boolean)
  if (!uniqueTaskIds.length) return
  const { tasks, setTasks, clearSelection, showToast, defaultFavoriteCollectionId } = useStore.getState()
  const idSet = new Set(uniqueTaskIds)
  const changedTaskIds = new Set<string>()
  const updated = tasks.map((task) => {
    if (!idSet.has(task.id)) return task
    if (sameFavoriteCollectionIds(getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId), ids)) return task
    changedTaskIds.add(task.id)
    return { ...task, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  })
  if (!changedTaskIds.size) {
    clearSelection()
    return
  }
  setTasks(updated)
  await Promise.all(updated.filter((task) => changedTaskIds.has(task.id)).map((task) => putTask(task)))
  clearSelection()
  showToast(ids.length ? '收藏夹已更新' : '已取消收藏', 'success')
}

export async function deleteFavoriteCollection(collectionId: string, deleteTasks = false) {
  const state = useStore.getState()
  const collection = state.favoriteCollections.find((item) => item.id === collectionId)
  const result = deleteFavoriteCollectionState({
    collections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: state.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: state.selectedFavoriteCollectionIds,
    selectedTaskIds: state.selectedTaskIds,
    tasks: state.tasks,
    collectionId,
    deleteTasks,
  })
  if (!collection || !result) return

  useStore.setState({
    favoriteCollections: result.collections,
    defaultFavoriteCollectionId: result.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: result.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: result.selectedFavoriteCollectionIds,
    selectedTaskIds: result.selectedTaskIds,
  })
  if (result.updatedTasks.length) {
    const patches = new Map(result.updatedTasks.map((task) => [task.id, task]))
    const updated = useStore.getState().tasks.map((task) => {
      const patch = patches.get(task.id)
      return patch ? { ...task, favoriteCollectionIds: patch.favoriteCollectionIds, isFavorite: patch.isFavorite } : task
    })
    useStore.getState().setTasks(updated)
    await Promise.all(updated.filter((task) => patches.has(task.id)).map((task) => putTask(task)))
  }
  if (result.taskIdsToDelete.length) await removeMultipleTasks(result.taskIdsToDelete)
  useStore.getState().showToast(`已删除收藏夹「${collection.name}」`, 'success')
}

/** 按重试方式新建任务或覆盖原任务；Agent 对话中的任务始终新建 */
/** 用户主动停止时写进任务的错误文案：界面上要能看出「这是你停的」，不是失败 */
export const TASK_STOPPED_MESSAGE = '已停止生成。'

/**
 * 停止一个正在生成的任务。
 *
 * 两件事同时做：
 * 1. 掐断网络请求（AbortController）—— 否则要干等到超时，期间还在烧 token；
 * 2. 作废执行标记（taskExecutions）—— 请求可能已经返回、正在存图的路上，
 *    标记一失效，后续那几步的检查点会全部 return，不会把半成品写进任务。
 *
 * 停止不算失败：任务转成「已停止」的错误态（可重试），不弹失败通知、不改交付。
 *
 * 关于 fal.ai：它的 SDK subscribe 不吃 signal，所以那边只能靠「执行标记作废 + 任务转成
 * 已停止」来阻止结果落地 —— 界面立刻显示已停止，但 fal 侧那一次调用可能仍会跑完
 * （不会写进任务、不会进交付）。OpenAI 兼容 / 自定义服务商那两条是真掐断。
 */
export async function stopTask(taskId: string): Promise<boolean> {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || task.status !== 'running') return false

  taskAbortControllers.get(taskId)?.abort(createUserAbortError())
  taskAbortControllers.delete(taskId)
  taskExecutions.delete(taskId)
  clearOpenAIWatchdogTimer(taskId)
  clearFalRecoveryTimer(taskId)
  clearCustomRecoveryTimer(taskId)

  updateTaskInStore(taskId, {
    status: 'error',
    error: TASK_STOPPED_MESSAGE,
    finishedAt: Date.now(),
    // 停止不是失败：把「可恢复」标记清掉，界面上不会出现「继续等待」这类按钮
    falRecoverable: false,
    customRecoverable: false,
  })
  useStore.getState().setTaskStreamPreview(taskId)
  useStore.getState().showToast('已停止生成，可随时重试', 'info')
  return true
}

export async function retryTask(task: TaskRecord, options: { overwrite?: boolean; keepProfile?: boolean } = {}) {
  const { settings, tasks } = useStore.getState()
  const source = tasks.find((item) => item.id === task.id)
  if (!source || source.status === 'running' || source.falRecoverable || source.customRecoverable) return
  const activeProfile = getActiveApiProfile(settings)
  /**
   * 用哪个 API 配置跑这一条。
   *
   * 手动「重试」用当前配置（用户可能就是想换个配置再试一次）；
   * 「断点继续」要沿用这张卡原来那份 —— 中途切过配置的话，接着跑出来的画风
   * 会跟前面几张对不上。原配置被删了才退回当前配置。
   */
  const runProfile = options.keepProfile
    ? (settings.profiles.find((item) => item.id === source.apiProfileId) ?? activeProfile)
    : activeProfile
  const runSettings = createSettingsForApiProfile(settings, runProfile)
  const normalizedParams = normalizeParamsForSettings(source.params, runSettings, { hasInputImages: source.inputImageIds.length > 0 })
  const shouldUseTransparentOutput = (normalizedParams.output_format === 'png' || normalizedParams.output_format === 'webp') && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output && runProfile.transparentBackgroundMethod === 'local'
    ? createTransparentOutputMeta(source.prompt.trim())
    : null
  /**
   * 覆盖还是新建：
   * - 默认听设置里的「重试方式」，用户在界面上点重试就按他的偏好来；
   * - 「断点继续」这种场景要原地接着跑，所以调用方可以显式传 overwrite，
   *   否则默认设置是 new，会把一条中断的任务变成「旧的失败卡 + 新的一张卡」。
   * agent 任务永远不覆盖：它挂在对话的某一轮上，换了 id 就对不上了。
   */
  const overwrite = !isAgentTask(source) && (
    options.overwrite ?? (
      settings.retryMode === 'overwriteAll' || (settings.retryMode === 'overwriteFailed' && source.status === 'error')
    )
  )
  const taskId = overwrite ? source.id : genId()
  const startedAt = Date.now()
  const newTask: TaskRecord = {
    ...(overwrite ? source : {}),
    id: taskId,
    prompt: source.prompt,
    params: taskParams,
    apiProvider: runProfile.provider,
    apiProfileId: runProfile.id,
    apiProfileName: runProfile.name,
    apiMode: runProfile.apiMode,
    apiModel: runProfile.model,
    inputImageIds: [...source.inputImageIds],
    maskTargetImageId: source.maskTargetImageId ?? null,
    maskImageId: source.maskImageId ?? null,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    outputErrors: undefined,
    transparentOriginalImages: undefined,
    actualParams: undefined,
    actualParamsByImage: undefined,
    revisedPromptByImage: undefined,
    rawImageUrls: undefined,
    rawResponsePayload: undefined,
    streamPartialImageIds: undefined,
    falRequestId: undefined,
    falEndpoint: undefined,
    falRecoverable: false,
    customTaskId: undefined,
    customRecoverable: false,
    status: 'running',
    error: null,
    createdAt: overwrite ? source.createdAt : startedAt,
    startedAt,
    finishedAt: null,
    elapsed: null,
  }

  if (overwrite) {
    taskExecutions.delete(taskId)
    // 覆盖后不再属于原批量，完成时应正常提示
    batchTaskIds.delete(taskId)
    clearOpenAIWatchdogTimer(taskId)
    clearFalRecoveryTimer(taskId)
    clearCustomRecoveryTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
  }
  useStore.getState().setTasks(overwrite
    ? tasks.map((item) => item.id === taskId ? newTask : item)
    : [newTask, ...tasks])
  await putTask(newTask)
  if (overwrite) {
    void deleteUnreferencedImageIds([
      ...source.outputImages,
      ...(source.transparentOriginalImages ?? []),
      ...(source.streamPartialImageIds ?? []),
    ])
  }

  executeTask(taskId)
}

/** 「断点继续」同时跑几条：和出图队列一个量级，别一次把接口打满 */
const RESUME_CONCURRENCY = 3

/**
 * 可以「继续」的任务：失败 / 中断，且一张图都没出来。
 *
 * - 出过图的不算：那一条已经拿到结果了，再跑一遍是重做，不是接着上次；
 * - fal / 自定义异步任务有 job id，重启后会自己接着查结果，不在这里重复提交；
 * - agent 任务挂在一轮对话上，重跑会打乱对话记录，也不算。
 */
export function isResumableTask(task: TaskRecord): boolean {
  if (task.deletedAt || task.sopPlaceholder) return false
  if (task.status !== 'error') return false
  if (task.outputImages?.length) return false
  if (task.falRecoverable || task.customRecoverable) return false
  if (isAgentTask(task)) return false
  return true
}

/** 有多少条可以继续（列表顶部那条提示用） */
export function countResumableTasks(tasks: TaskRecord[]): number {
  let count = 0
  for (const task of tasks) if (isResumableTask(task)) count += 1
  return count
}

/**
 * 断点继续：把中断 / 意外关掉软件后没跑完的任务，在原地接着跑。
 *
 * 提示词、参数、输入图都沿用原来那份，跑出来的还是同一批东西；
 * 用 overwrite 续在原任务上，不会多出一张重复的卡。
 *
 * 后台跑：几十条要跑很久，界面不该卡在这里等它跑完。
 */
export async function resumeInterruptedTasks(): Promise<number> {
  const pending = useStore.getState().tasks.filter(isResumableTask)
  if (!pending.length) {
    useStore.getState().showToast('没有需要继续的任务', 'info')
    return 0
  }
  let cursor = 0
  const run = async () => {
    while (cursor < pending.length) {
      const target = pending[cursor]
      cursor += 1
      // 期间可能被删掉、或已经手动重试过，跑之前再确认一次
      const latest = useStore.getState().tasks.find((item) => item.id === target.id)
      if (!latest || !isResumableTask(latest)) continue
      await retryTask(latest, { overwrite: true, keepProfile: true })
      await waitForTaskSettled(latest.id, () => false)
    }
  }
  void Promise.all(Array.from({ length: Math.min(RESUME_CONCURRENCY, pending.length) }, run))
  useStore.getState().showToast(`正在继续 ${pending.length} 个没跑完的任务`, 'success')
  return pending.length
}

/** 复用配置 */
/**
 * 复用配置时该还原哪个尺寸。
 *
 * 方舟（Seedream）会把不满足像素下限的尺寸换算一发：选 2K 的 3:4（1536×2048，314 万像素）
 * 实际发出去的是 1728×2304。这时 params.size 记的是「选的」，actualParams.size 才是「真正出的」。
 * 只还原「选的」，复用后输入栏还是 1536×2048，跟卡上的 1728×2304 对不上 ——
 * 看起来就像「复用没带上尺寸」。
 *
 * 只对 ark 生效：其它渠道的 actualParams.size 可能是「放大生成再缩回」用的中间尺寸，
 * 拿它还原会连带改变出图大小。
 */
function resolveReuseSize(task: TaskRecord): string {
  if (task.apiProvider === 'ark') {
    const actual = task.actualParams?.size
    if (actual && /^\d+x\d+$/.test(actual)) return actual
  }
  return task.params.size
}

export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setCustomCopy, setParams, setInputImages, setFixedImages, setVariableImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const taskProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const matchedProfile = taskProfile && (!isPresetConfigOnlyEnabled() || isPresetProfile(taskProfile.id)) ? taskProfile : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  // 复用当前配置时，任务所用模型仍在模型列表中则同步切换首页选中的模型；临时复用其他配置时模型只随复用状态生效
  const currentProfileRecord = normalizedSettings.profiles.find((item) => item.id === currentProfile.id)
  if (!shouldTemporarilyReuseProfile && task.apiModel && currentProfileRecord && currentProfileRecord.selectedModel !== task.apiModel && splitModelList(currentProfileRecord.model).includes(task.apiModel)) {
    useStore.getState().setSettings({
      profiles: normalizedSettings.profiles.map((item) => item.id === currentProfile.id ? { ...item, selectedModel: task.apiModel } : item),
    })
  }
  const reuseSettings = normalizeSettings(useStore.getState().settings)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(reuseSettings, matchedProfile) : reuseSettings

  // 尺寸单独取一次：方舟换过像素的卡要还原成真正出图的尺寸，而不是当初选的
  setParams(normalizeParamsForSettings(
    { ...task.params, size: resolveReuseSize(task) },
    paramsSettings,
    { hasInputImages: task.inputImageIds.length > 0 },
  ))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.model : null,
  )
  clearMaskDraft()

  /**
   * 还原输入框。
   *
   * 有 inputSnapshot（新任务）就按当时的模式与分池精确还原：
   *   plain    → 提示词 + 分池图片（固定图回固定图区、其余回参考图区）+ 融图/批量
   *   sop      → 切回 SOP 模式，参考图回输入区；提示词保留 task.prompt（模型生成的那条）
   *   variable → 切回变量模式，参考图 / 固定图 / 变量图各自回位；提示词保留 task.prompt
   *
   * 没有快照（老任务）时退回旧逻辑：参考图取 inputImageIds，变量模式的
   * inputImageIds 是「固定图 + 变量图」，按 variableFixedImageIds 拆回各自的池。
   */
  const snapshot = task.inputSnapshot
  const isVariableMode = snapshot ? snapshot.mode === 'variable' : Boolean(task.variableMode)
  const referenceIds = snapshot
    ? (task.sopReferenceImageIds ?? [])
    : (task.variableMode
        ? (task.sopReferenceImageIds ?? [])
        : (task.inputImageIds.length ? task.inputImageIds : (task.sopReferenceImageIds ?? [])))

  const loadImages = async (ids: string[]): Promise<InputImage[]> => {
    const out: InputImage[] = []
    for (const imgId of ids) {
      const dataUrl = await ensureImageCached(imgId)
      if (dataUrl) out.push({ id: imgId, dataUrl })
    }
    return out
  }

  /**
   * 取任务里记录的某张图 id → InputImage。
   * 快照里的 id 可能已被用户删图（孤儿清理），取不到就跳过，不让整个还原失败。
   */
  const loadOne = async (imgId: string): Promise<InputImage | null> => {
    const dataUrl = await ensureImageCached(imgId)
    return dataUrl ? { id: imgId, dataUrl } : null
  }

  // 参考图 / 变量图区（普通模式下就是输入框里的那些图）
  const inputIds = snapshot
    ? (snapshot.mode === 'plain' ? (snapshot.variableImageIds ?? []) : referenceIds)
    : referenceIds
  const restoredInputImages = await loadImages(inputIds)
  if (inputIds.length && restoredInputImages.length < inputIds.length) {
    // 老版本把参考图当孤儿图清掉了，还原不出来要说一声，否则看着像「点了没反应」
    showToast(`有 ${inputIds.length - restoredInputImages.length} 张参考图已被清理，没能还原`, 'info')
  }
  setInputImages(restoredInputImages)

  // 固定图区：有快照按快照，老任务在变量模式下才拆得出来；两种来源都要真的写回 store
  const fixedIds = snapshot
    ? (snapshot.fixedImageIds ?? [])
    : (isVariableMode ? (task.variableFixedImageIds ?? []) : [])
  {
    const fixedImgs: InputImage[] = []
    for (const imgId of fixedIds) {
      const img = await loadOne(imgId)
      if (img) fixedImgs.push(img)
    }
    setFixedImages(fixedImgs)
  }

  // 变量图区：快照里存的是整池；老任务只能退回「本条用到的那一张」
  if (isVariableMode) {
    const variableImgs: InputImage[] = []
    if (snapshot) {
      const fixedSet = new Set(fixedIds)
      for (const imgId of snapshot.variableImageIds ?? []) {
        if (fixedSet.has(imgId)) continue
        const img = await loadOne(imgId)
        if (img) variableImgs.push(img)
      }
    } else if (task.inputImageIds.length) {
      const fixedSet = new Set(task.variableFixedImageIds ?? [])
      for (const imgId of task.inputImageIds) {
        if (fixedSet.has(imgId)) continue
        const img = await loadOne(imgId)
        if (img) variableImgs.push(img)
      }
      // 更早的任务连 variableFixedImageIds 都没有，只能认 variableImageId 这一张
      if (!task.variableFixedImageIds?.length && task.variableImageId && !variableImgs.some((img) => img.id === task.variableImageId)) {
        const img = await loadOne(task.variableImageId)
        if (img) variableImgs.push(img)
      }
    }
    setVariableImages(variableImgs)
  } else if (snapshot) {
    // 非变量模式：清掉上一次复用留下的变量图，避免混进这一批
    setVariableImages([])
  }

  /**
   * 切回当时的模式。三种模式互斥：setSopMode / setVariableMode 的实现里
   * 会各自把另一个关掉（setSopMode(false) 同时把 variableMode 置 false），
   * 所以普通模式只调 setSopMode(false) 就够了。
   * 放在图片还原之后：模式一开，三分区面板会立刻按新的池渲染。
   */
  if (snapshot) {
    const sopState = useSopStore.getState()
    if (snapshot.mode === 'sop') {
      sopState.setSopMode(true)
    } else if (snapshot.mode === 'variable') {
      sopState.setVariableMode(true)
    } else {
      sopState.setSopMode(false)
      useStore.getState().setPlainImageMode(snapshot.plainImageMode ?? 'batch')
    }
    /**
     * 归属方向：恢复成当时所用的方向，出图才会落回同一个地方。
     * 方向可能已被删除，先确认还在树里再设，避免把归属指向一个不存在的节点。
     */
    const directionId = task.sopDirectionId
    if (directionId && sopState.directions.some((node) => node.id === directionId)) {
      sopState.setActiveDirection(directionId)
    }
  }

  /**
   * 输入框：三种模式统一还原「发送瞬间输入框里的原文」。
   *
   * 以前 SOP / 变量模式还原的是 task.prompt —— 那是模型写出来的最终提示词
   * （一长段，还带系统提示词/变量要求的口吻），而这两种模式下输入框根本不参与生成，
   * 塞进去只有噪音，也让人以为「输入框被换成了别的东西」。
   *
   * 快照里没记原文（老任务，或当时输入框是空的）时：普通模式退回 task.prompt 兜底，
   * SOP / 变量模式保持空 —— 那才是它们真实的输入状态。
   */
  // 没有快照的老任务：靠 variableMode / sopText 认出「当年是 SOP 或变量模式」，
  // 同样给空，不再把生成的提示词塞进一个不参与生成的输入框
  const legacyNonPlain = Boolean(task.variableMode || task.sopText)
  const restorePrompt = snapshot
    ? (snapshot.mode === 'plain' ? (snapshot.prompt ?? task.prompt) : (snapshot.prompt ?? ''))
    : (legacyNonPlain ? '' : task.prompt)
  /**
   * 「本次文案」那一栏：快照里记了就原样还原，没记（老任务）就清空。
   *
   * 不清空会出事：这一栏是「一直记住直到手动清掉」的，复用一张旧卡却留着
   * 上一批的文案，出图就会带着不该有的字。所以宁可给空。
   */
  setCustomCopy(snapshot?.customCopy ?? '')
  // 部分参考图可能已被删除，按图片 id 重新对齐提示词中的图片序号，避免评论和提及错位到其他图片
  setPrompt(remapImageMentionsForOrder(restorePrompt, inputIds.map((id) => ({ id, dataUrl: '' })), useStore.getState().inputImages))
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && useStore.getState().inputImages.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? `已临时复用该任务的 API 配置「${matchedProfile.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

function getAgentRoundDeletionTaskIds(conversation: AgentConversation, round: AgentRound, tasks: TaskRecord[]) {
  const messageIds = new Set(conversation.messages.filter((message) => message.roundId === round.id).map((message) => message.id))
  messageIds.add(round.userMessageId)
  if (round.assistantMessageId) messageIds.add(round.assistantMessageId)
  return uniqueIds([
    ...round.outputTaskIds,
    ...conversation.messages
      .filter((message) => messageIds.has(message.id))
      .flatMap((message) => message.outputTaskIds ?? []),
    ...tasks
      .filter((task) => task.agentRoundId === round.id || Boolean(task.agentMessageId && messageIds.has(task.agentMessageId)))
      .map((task) => task.id),
  ])
}

function hasRunningAgentDeletionWork(conversationId: string, roundIds: Set<string>, taskIds: Set<string>, state: AppState) {
  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  if (conversation?.rounds.some((round) => roundIds.has(round.id) && round.status === 'running')) return true
  if (state.tasks.some((task) => taskIds.has(task.id) && task.status === 'running')) return true
  for (const roundId of roundIds) {
    const key = getAgentRoundControllerKey(conversationId, roundId)
    const round = conversation?.rounds.find((item) => item.id === roundId)
    const controller = agentRoundControllers.get(key)
    if (controller && !controller.signal.aborted) return true
    if (agentRecoveryContinuations.has(key) && round?.status !== 'done' && round?.error !== AGENT_STOPPED_MESSAGE) return true
  }
  return false
}

function cleanDeletedAgentReferences(conversation: AgentConversation, taskIds: Set<string>, assistantMessageIds: Set<string>, now: number) {
  let changed = false
  const rounds = conversation.rounds.map((round) => {
    const outputTaskIds = round.outputTaskIds.filter((taskId) => !taskIds.has(taskId))
    const clearAssistantMessage = Boolean(round.assistantMessageId && assistantMessageIds.has(round.assistantMessageId))
    if (outputTaskIds.length === round.outputTaskIds.length && !clearAssistantMessage) return round
    changed = true
    return {
      ...round,
      ...(clearAssistantMessage ? { assistantMessageId: undefined } : {}),
      outputTaskIds,
    }
  })
  const messages = conversation.messages.map((message) => {
    if (!message.outputTaskIds?.some((taskId) => taskIds.has(taskId))) return message
    changed = true
    return { ...message, outputTaskIds: message.outputTaskIds.filter((taskId) => !taskIds.has(taskId)) }
  })
  return changed ? { ...conversation, rounds, messages, updatedAt: now } : conversation
}

async function deleteAgentRoundAndTasks(conversationId: string, roundId: string): Promise<AgentDeletionResult> {
  const state = useStore.getState()
  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const round = conversation?.rounds.find((item) => item.id === roundId)
  if (!conversation || !round) return 'not-found'

  const taskIds = new Set(getAgentRoundDeletionTaskIds(conversation, round, state.tasks))
  if (hasRunningAgentDeletionWork(conversationId, new Set([roundId]), taskIds, state)) return 'running'

  let deleted = false
  try {
    await removeTasks([...taskIds], (latest, deletedTaskIds) => {
      const latestConversation = latest.agentConversations.find((item) => item.id === conversationId)
      const latestRound = latestConversation?.rounds.find((item) => item.id === roundId)
      if (!latestConversation || !latestRound) return null

      const oldActivePath = getActiveAgentRounds(latestConversation)
      const nextConversation = deleteAgentRoundFromConversation(latestConversation, roundId)
      const newActivePath = getActiveAgentRounds(nextConversation)
      const removedMessageIds = new Set([
        latestRound.userMessageId,
        ...(latestRound.assistantMessageId ? [latestRound.assistantMessageId] : []),
        ...latestConversation.messages.filter((message) => message.roundId === roundId).map((message) => message.id),
      ])
      const removedAssistantMessageIds = new Set(latestConversation.messages
        .filter((message) => message.role === 'assistant' && removedMessageIds.has(message.id))
        .map((message) => message.id))
      if (latestRound.assistantMessageId) removedAssistantMessageIds.add(latestRound.assistantMessageId)
      const now = Date.now()
      const agentConversations = latest.agentConversations.map((item) => {
        const candidate = item.id === conversationId
          ? { ...nextConversation, messages: nextConversation.messages.filter((message) => !removedMessageIds.has(message.id)) }
          : item
        return cleanDeletedAgentReferences(candidate, deletedTaskIds, removedAssistantMessageIds, now)
      })
      const agentInputDrafts = remapAgentInputDraftMentionsForPathChange(latest.agentInputDrafts, conversationId, oldActivePath, newActivePath)
      deleted = true
      return {
        agentConversations,
        agentInputDrafts,
        ...(latest.activeAgentConversationId === conversationId && latest.appMode === 'agent'
          ? { prompt: remapAgentRoundMentionsForPathChange(latest.prompt, oldActivePath, newActivePath) }
          : {}),
        agentEditingRoundId: latest.agentEditingRoundId === roundId ? null : latest.agentEditingRoundId,
      }
    })
  } catch (err) {
    if (!deleted) throw err
    console.warn('Agent 轮次已删除，但持久化或图片清理失败', err)
    return 'deleted-with-warning'
  }
  return deleted ? 'deleted' : 'not-found'
}

async function deleteAgentAssistantMessageAndTasks(conversationId: string, messageId: string): Promise<AgentDeletionResult> {
  const state = useStore.getState()
  const conversation = state.agentConversations.find((item) => item.id === conversationId)
  const message = conversation?.messages.find((item) => item.id === messageId && item.role === 'assistant')
  if (!conversation || !message) return 'not-found'

  const round = conversation.rounds.find((item) => item.id === message.roundId)
  const taskIds = new Set(uniqueIds([
    ...(message.outputTaskIds ?? []),
    ...(round ? getAgentRoundDeletionTaskIds(conversation, round, state.tasks) : []),
    ...state.tasks.filter((task) => task.agentMessageId === messageId).map((task) => task.id),
  ]))
  const referencedRoundIds = new Set([
    message.roundId,
    ...conversation.rounds.filter((item) => item.assistantMessageId === messageId).map((item) => item.id),
  ])
  if (hasRunningAgentDeletionWork(conversationId, referencedRoundIds, taskIds, state)) return 'running'

  let deleted = false
  try {
    await removeTasks([...taskIds], (latest, deletedTaskIds) => {
      const latestConversation = latest.agentConversations.find((item) => item.id === conversationId)
      const latestMessage = latestConversation?.messages.find((item) => item.id === messageId && item.role === 'assistant')
      if (!latestConversation || !latestMessage) return null

      const now = Date.now()
      const assistantMessageIds = new Set([messageId])
      const agentConversations = latest.agentConversations.map((item) => {
        const candidate = item.id === conversationId
          ? { ...item, messages: item.messages.filter((current) => current.id !== messageId), updatedAt: now }
          : item
        return cleanDeletedAgentReferences(candidate, deletedTaskIds, assistantMessageIds, now)
      })
      deleted = true
      return { agentConversations }
    })
  } catch (err) {
    if (!deleted) throw err
    console.warn('Agent 消息已删除，但持久化或图片清理失败', err)
    return 'deleted-with-warning'
  }
  return deleted ? 'deleted' : 'not-found'
}

type TaskDeletionStateUpdater = (state: AppState, taskIds: Set<string>) => Partial<AppState> | null

async function removeTasks(taskIds: string[], updateState?: TaskDeletionStateUpdater) {
  const toDelete = new Set(taskIds)
  let deletedTasks: TaskRecord[] = []
  useStore.setState((state) => {
    deletedTasks = state.tasks.filter((task) => toDelete.has(task.id))
    const streamPreviews = { ...state.streamPreviews }
    const streamPreviewSlots = { ...state.streamPreviewSlots }
    for (const taskId of toDelete) {
      delete streamPreviews[taskId]
      delete streamPreviewSlots[taskId]
    }
    return {
      tasks: state.tasks.filter((task) => !toDelete.has(task.id)),
      selectedTaskIds: state.selectedTaskIds.filter((id) => !toDelete.has(id)),
      streamPreviews,
      streamPreviewSlots,
    }
  })
  if (deletedTasks.length === 0 && !updateState) return 0

  const deletedImageIds = new Set<string>()
  for (const task of deletedTasks) {
    // 只把生成的图列为清理候选：参考图属于用户素材，删卡不连带删图
    addTaskCleanupImageIds(deletedImageIds, task)
    const controller = task.agentConversationId && task.agentRoundId
      ? agentRoundControllers.get(getAgentRoundControllerKey(task.agentConversationId, task.agentRoundId))
      : undefined
    if (controller) deletedActiveAgentTasks.set(task.id, { task, controller })
    clearFalRecoveryTimer(task.id)
    clearCustomRecoveryTimer(task.id)
    clearOpenAIWatchdogTimer(task.id)
    taskExecutions.delete(task.id)
  }

  const cleanup = scrubAgentOutputPayloadsForDeletedTasks(deletedTasks)
  const domainUpdatedConversations: AgentConversation[] = []
  if (updateState) {
    useStore.setState((state) => {
      const patch = updateState(state, toDelete)
      if (!patch) return state
      if (patch.agentConversations) {
        const previousById = new Map(state.agentConversations.map((conversation) => [conversation.id, conversation]))
        domainUpdatedConversations.push(...patch.agentConversations.filter((conversation) => previousById.get(conversation.id) !== conversation))
      }
      return patch
    })
  }
  const updatedConversations = new Map(cleanup.updatedConversations.map((conversation) => [conversation.id, conversation]))
  for (const conversation of domainUpdatedConversations) updatedConversations.set(conversation.id, conversation)
  await persistTaskDeletionCleanup(deletedTasks.map((task) => task.id), {
    ...cleanup,
    updatedConversations: [...updatedConversations.values()],
  })
  await deleteUnreferencedImageIds(deletedImageIds)
  return deletedTasks.length
}

/** 删除多条任务 */
/** 把选中的任务展开成「所属 SOP 组的全部任务」，避免聚合卡只删掉代表任务 */
function expandSopGroupTaskIds(taskIds: string[]): string[] {
  const tasks = useStore.getState().tasks
  const selected = new Set(taskIds)
  const sopJobIds = new Set<string>()
  for (const task of tasks) {
    if (selected.has(task.id) && task.sopJobId) sopJobIds.add(task.sopJobId)
  }
  if (sopJobIds.size === 0) return taskIds
  const expanded = new Set(taskIds)
  for (const task of tasks) {
    if (task.sopJobId && sopJobIds.has(task.sopJobId)) expanded.add(task.id)
  }
  return [...expanded]
}

/**
 * 把任务卡放进回收站（伪删除）。
 *
 * 任务从 tasks 移到 trashedTasks：这样画廊、计数、筛选完全不用改，
 * 也不会影响任何既有逻辑。图片自带引用关系一并搬过去，
 * 清空回收站时才走真正的 removeTasks 并连带清图。
 */
export async function trashTasks(taskIds: string[]): Promise<string> {
  if (!taskIds.length) return ''
  const ids = expandSopGroupTaskIds(taskIds)
  const batchId = `trash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const deletedAt = Date.now()
  const moved: TaskRecord[] = []
  useStore.setState((state) => {
    const idSet = new Set(ids)
    const stay: TaskRecord[] = []
    for (const task of state.tasks) {
      if (!idSet.has(task.id)) {
        stay.push(task)
        continue
      }
      moved.push({ ...task, deletedAt, trashBatchId: batchId })
    }
    return {
      tasks: stay,
      trashedTasks: [...moved, ...state.trashedTasks],
      selectedTaskIds: state.selectedTaskIds.filter((id) => !idSet.has(id)),
    }
  })
  for (const task of moved) await putTask(task)
  if (moved.length) {
    const extra = ids.length > taskIds.length ? '（含同一 SOP 下的其余图片）' : ''
    useStore.getState().showToast(`已移入回收站 ${moved.length} 个任务${extra}`, 'success')
  }
  return moved.length ? batchId : ''
}

/** 从回收站恢复一批任务 */
export async function restoreTrashTasks(batchId: string) {
  const restored: TaskRecord[] = []
  useStore.setState((state) => {
    const remaining: TaskRecord[] = []
    for (const task of state.trashedTasks) {
      if (task.trashBatchId !== batchId) {
        remaining.push(task)
        continue
      }
      const next = { ...task, deletedAt: undefined, trashBatchId: undefined }
      restored.push(next)
    }
    return {
      tasks: [...restored, ...state.tasks],
      trashedTasks: remaining,
    }
  })
  for (const task of restored) await putTask(task)
  if (restored.length) useStore.getState().showToast(`已恢复 ${restored.length} 个任务`, 'success')
  return restored.length
}

/** 彻底删除一批任务（含图片），不可恢复 */
export async function purgeTrashTasks(batchId: string) {
  const list = useStore.getState().trashedTasks.filter((task) => task.trashBatchId === batchId)
  if (!list.length) return 0
  // 先从回收站移除，再走真正的删除流程（清图、清 Agent 引用等）
  useStore.setState((state) => ({
    trashedTasks: state.trashedTasks.filter((task) => task.trashBatchId !== batchId),
  }))
  const count = await deleteTasksPermanently(list)
  if (count) useStore.getState().showToast(`已彻底删除 ${count} 个任务`, 'success')
  return count
}

/** 清空任务卡回收站 */
export async function purgeAllTrashTasks() {
  const list = useStore.getState().trashedTasks
  if (!list.length) return 0
  useStore.setState({ trashedTasks: [] })
  const count = await deleteTasksPermanently(list)
  if (count) useStore.getState().showToast(`已清空回收站，彻底删除 ${count} 个任务`, 'success')
  return count
}

/**
 * 真正删除回收站里的任务。
 *
 * removeTasks 是按 tasks 里的 id 工作的，回收站任务已经不在 tasks 里，
 * 所以先把记录塞回 tasks 再调用，让清图与引用清理走同一套既有逻辑。
 */
async function deleteTasksPermanently(list: TaskRecord[]): Promise<number> {
  const ids = list.map((task) => task.id)
  const idSet = new Set(ids)
  useStore.setState((state) => ({ tasks: [...list, ...state.tasks] }))
  const count = await removeTasks(ids)
  // 兜底：万一 removeTasks 因某条记录缺失没删干净，别把它们留在 tasks 里
  useStore.setState((state) => ({ tasks: state.tasks.filter((task) => !idSet.has(task.id)) }))
  return count
}

export async function removeMultipleTasks(taskIds: string[]) {
  if (!taskIds.length) return

  const ids = expandSopGroupTaskIds(taskIds)
  const deletedCount = await removeTasks(ids)
  if (deletedCount === 0) return
  useStore.getState().showToast(
    ids.length > taskIds.length
      ? `已删除 ${deletedCount} 个任务（含同一 SOP 下的其余图片）`
      : `已删除 ${deletedCount} 个任务`,
    'success',
  )
}

/** 用户界面的「删除」入口：进回收站，可恢复 */
export async function trashTask(task: TaskRecord) {
  const ids = task.sopJobId
    ? useStore.getState().tasks.filter((item) => item.sopJobId === task.sopJobId).map((item) => item.id)
    : [task.id]
  if (!ids.length) return
  await trashTasks(ids)
}

/**
 * 把单张成品图放进「图片回收站」。
 *
 * 只记 id，不动 outputImages：那条数组的下标被 transparentOriginalImages 等字段依赖，
 * 真删元素会让映射错位。被回收的图不再交付、不在画廊出现，原图仍在，可还原。
 */
/**
 * 找出真正持有这张成品图的任务。
 *
 * 详情页把同一张卡（同 sopJobId）的多条任务拼成一个展示对象，`id` 是代表任务的，
 * 所以「代表任务」身上可能没有这张图 —— 直接按代表任务去写状态会永远滤不掉，
 * 表现就是「点了放入回收站没反应」。
 */
export function ownerTaskOfOutputImage(imageId: string): TaskRecord | undefined {
  return useStore.getState().tasks.find((item) => !item.deletedAt && item.outputImages?.includes(imageId))
}

export async function trashOutputImage(taskId: string, imageId: string) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !imageId) return
  const owner = task.outputImages.includes(imageId) ? task : ownerTaskOfOutputImage(imageId) ?? task
  const current = owner.trashedOutputImages ?? []
  if (current.includes(imageId)) return
  const next = { ...owner, trashedOutputImages: [...current, imageId] }
  useStore.setState((state) => ({
    tasks: state.tasks.map((item) => (item.id === owner.id ? next : item)),
  }))
  await putTask(next)
  // 交付过的图要把交付夹里的那份也撤掉；撤不掉要说出来，不能让人以为已经删干净
  const wasDelivered = Boolean(owner.deliveredFileNames?.[imageId] || owner.deliverFolder)
  const removed = await removeDeliveredFiles(owner, [imageId])
  useStore.getState().showToast(
    removed
      ? '已移入图片回收站，交付文件夹里的那一份也删掉了'
      : wasDelivered
        ? '已移入图片回收站，但交付文件夹里没找到这个文件（可能已被移动或改过交付地址）'
        : '已移入图片回收站，可在回收站里还原',
    removed ? 'success' : 'info',
  )
}

/**
 * 一次把多张成品图移入回收站（「一键清理不合格」用）。
 *
 * 逐张调用 trashOutputImage 会写 N 次库、弹 N 个 toast；
 * 而且卡片里的图可能分属多条任务，这里按「真正持有这张图的任务」分组写回。
 */
export async function trashOutputImages(taskId: string, imageIds: string[]): Promise<number> {
  const base = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!base || !imageIds.length) return 0

  const byOwner = new Map<string, string[]>()
  for (const id of imageIds) {
    if (!id) continue
    const owner = base.outputImages.includes(id) ? base : ownerTaskOfOutputImage(id)
    if (!owner) continue
    const list = byOwner.get(owner.id) ?? []
    list.push(id)
    byOwner.set(owner.id, list)
  }

  let total = 0
  let removedFiles = 0
  let deliveredCount = 0
  for (const [ownerId, ids] of byOwner) {
    const owner = useStore.getState().tasks.find((item) => item.id === ownerId)
    if (!owner) continue
    const current = new Set(owner.trashedOutputImages ?? [])
    const adding = ids.filter((id) => !current.has(id))
    if (!adding.length) continue
    const next = { ...owner, trashedOutputImages: [...current, ...adding] }
    useStore.setState((state) => ({
      tasks: state.tasks.map((item) => (item.id === ownerId ? next : item)),
    }))
    await putTask(next)
    for (const id of adding) {
      if (owner.deliveredFileNames?.[id] || owner.deliverFolder) deliveredCount += 1
    }
    removedFiles += await removeDeliveredFiles(owner, adding)
    total += adding.length
  }
  if (total) {
    const missed = deliveredCount - removedFiles
    useStore.getState().showToast(
      missed > 0
        ? `已把 ${total} 张移入图片回收站，交付文件夹里另有 ${missed} 张没找到（可能已被移动或改过交付地址）`
        : removedFiles > 0
          ? `已把 ${total} 张移入图片回收站，交付文件夹里的 ${removedFiles} 张也删掉了`
          : `已把 ${total} 张移入图片回收站，可在回收站里还原`,
      missed > 0 ? 'info' : 'success',
    )
  }
  return total
}

/**
 * 把图从交付文件夹里删掉。
 *
 * 进回收站的意思是「这张图对外下架」：库里留着可以还原，但交付文件夹是对外成品目录，
 * 不能还把这张图摆在那里。只删交付当时写出的那个文件——文件名交付时记过就直接用，
 * 老数据按卡的交付顺序推算；删不到（没交付过、交付地址改过、用户手动删过）不算失败。
 */
async function removeDeliveredFiles(task: TaskRecord, imageIds: string[]): Promise<number> {
  if (!isTauri || !imageIds.length) return 0
  let removed = 0
  try {
    const context = await buildDeliverContext()
    /**
     * 老任务没有 deliverDirPath：交付时用的是哪个根目录已经无从考证。
     * 把「默认保存目录」也当成一个候选 —— 用户后来改过方向交付目录的话，
     * 当年那批文件多半还留在默认目录里，只按当前配置算会一直删不到。
     */
    const extraDirs: string[] = []
    try {
      const defaultDir = (await getDefaultSaveDir())?.trim()
      if (defaultDir) extraDirs.push(defaultDir)
    } catch {
      // 读不到默认目录就算了，不影响主线
    }
    for (const imageId of imageIds) {
      const refs = await deliveredFileRefsOf(task, imageId, context)
      let done = false
      for (const ref of refs) {
        try {
          if (await removeDeliveredFile(ref.dir, ref.relative)) {
            done = true
            break
          }
        } catch (err) {
          console.warn('删除交付文件失败：', err)
        }
      }
      // 主路径全落空时，按同一个相对路径去默认目录里找一次
      if (!done && refs[0]) {
        for (const dir of extraDirs) {
          if (dir === refs[0].dir) continue
          try {
            if (await removeDeliveredFile(dir, refs[0].relative)) {
              done = true
              break
            }
          } catch (err) {
            console.warn('删除交付文件失败：', err)
          }
        }
      }
      if (done) removed += 1
    }
  } catch (err) {
    console.warn('删除交付文件失败：', err)
  }
  return removed
}

/**
 * 质检判不合格、但已经交付出去的图：按任务分组列出来。
 *
 * 人工改判优先于自动结论（和 failedOutputImages 一个口径）。
 * 纯函数，方便单测；真正删文件的是下面的 pruneFailedDeliveredImages。
 */
export function collectFailedOutputImages(
  tasks: TaskRecord[],
  qc: Record<string, { verdict?: string } | undefined>,
  imageIds?: string[],
): Array<{ task: TaskRecord; ids: string[] }> {
  const filter = imageIds?.length ? new Set(imageIds) : null
  const out: Array<{ task: TaskRecord; ids: string[] }> = []
  for (const task of tasks) {
    if (task.deletedAt) continue
    const ids: string[] = []
    for (const id of task.outputImages ?? []) {
      if (!id) continue
      if (filter && !filter.has(id)) continue
      const manual = task.qcVerdicts?.[id]
      const verdict = manual ?? qc[id]?.verdict
      if (verdict === 'fail') ids.push(id)
    }
    if (ids.length) out.push({ task, ids })
  }
  return out
}

/**
 * 质检出「不合格」之后，把已经交付到文件夹的那几张删掉。
 *
 * 生图一完成就自动交付，质检是排队异步跑的 —— 等质检出结果，文件早就写进交付目录了。
 * 之前只有「重新交付」时才跳过坏图，已经写出去的那份一直留在文件夹里。
 * 这里补上追溯：判 fail 就删文件（图片本体还在库里，可以还原/人工改判）。
 */
export async function pruneFailedDeliveredImages(imageIds?: string[]): Promise<number> {
  if (!isTauri) return 0
  const state = useStore.getState()
  const groups = collectFailedOutputImages(state.tasks, useClipStore.getState().qc, imageIds)
  let removed = 0
  for (const { task, ids } of groups) {
    // 没交付过的卡不用去碰交付目录
    if (!task.deliverFolder && !task.deliveredFileNames) continue
    removed += await removeDeliveredFiles(task, ids)
  }
  if (removed) {
    state.showToast(`已把 ${removed} 张质检不合格的图从交付文件夹删掉`, 'info')
  }
  return removed
}

/**
 * 把「这次交付实际写了哪些文件」记到对应任务上，供进回收站时精确删除。
 *
 * 文件名里带序号和尺寸，事后重算容易跟当时的实际写法错开，
 * 由交付结果直接回写最准确；图可能是兄弟任务持有的，按真正持有它的任务分组写。
 */
function recordDeliveredFiles(files?: Array<{ imageId: string; name: string }>, dir?: string) {
  if (!files?.length) return
  const tasks = useStore.getState().tasks
  const byTask = new Map<string, Record<string, string>>()
  for (const file of files) {
    const owner = tasks.find((item) => item.outputImages?.includes(file.imageId))
    if (!owner) continue
    const map = byTask.get(owner.id) ?? { ...(owner.deliveredFileNames ?? {}) }
    map[file.imageId] = file.name
    byTask.set(owner.id, map)
  }
  const dirPath = dir?.trim()
  for (const [taskId, names] of byTask) {
    // 顺手把「交付到哪个根目录」也记下来：进回收站删文件时按它找，比按当前配置重算准
    updateTaskInStore(taskId, {
      deliveredFileNames: names,
      ...(dirPath ? { deliverDirPath: dirPath } : {}),
    })
  }
}

/**
 * 人工改判某张图的质检结论。
 *
 * verdict 传 null 表示清除改判、回到自动结论。
 * 落库到任务上：自动质检只在内存里，交付过滤不能靠它。
 * 图属于同卡的哪条任务就写到哪条上（卡片在详情页是拼起来展示的）。
 */
export async function setImageQcVerdict(taskId: string, imageId: string, verdict: 'pass' | 'fail' | null) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !imageId) return
  const owner = task.outputImages.includes(imageId) ? task : ownerTaskOfOutputImage(imageId) ?? task
  const current = { ...(owner.qcVerdicts ?? {}) }
  if (verdict) current[imageId] = verdict
  else delete current[imageId]
  const next = { ...owner, qcVerdicts: Object.keys(current).length ? current : undefined }
  useStore.setState((state) => ({
    tasks: state.tasks.map((item) => (item.id === owner.id ? next : item)),
  }))
  await putTask(next)
  // 改判成不合格：已经交付出去的那份也要撤回来
  if (verdict === 'fail') await pruneFailedDeliveredImages([imageId])
  useStore.getState().showToast(
    verdict === 'fail' ? '已标为不合格，交付时会跳过这张' : verdict === 'pass' ? '已标为合格' : '已恢复按自动质检结论',
    'success',
  )
}

/**
 * 这张卡判为「不合格」的图。
 *
 * 人工改判优先于自动质检：改判成合格的就照交，改判成不合格的即使模型判合格也不交。
 */
export function failedOutputImages(task: TaskRecord): string[] {
  const qc = useClipStore.getState().qc
  const overrides = task.qcVerdicts ?? {}
  return (task.outputImages ?? []).filter((id) => {
    const manual = overrides[id]
    if (manual) return manual === 'fail'
    return qc[id]?.verdict === 'fail'
  })
}

/** 这张卡某张图的最终质检结论（人工改判优先），没有结论返回 null */
export function qcVerdictOf(task: TaskRecord, imageId: string): 'pass' | 'fail' | 'unsure' | null {
  const manual = task.qcVerdicts?.[imageId]
  if (manual) return manual
  return useClipStore.getState().qc[imageId]?.verdict ?? null
}

/** 从图片回收站还原若干张图 */
export async function restoreOutputImages(taskId: string, imageIds: string[]) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !imageIds.length) return
  const removing = new Set(imageIds)
  const remaining = (task.trashedOutputImages ?? []).filter((id) => !removing.has(id))
  const next = { ...task, trashedOutputImages: remaining.length ? remaining : undefined }
  useStore.setState((state) => ({
    tasks: state.tasks.map((item) => (item.id === taskId ? next : item)),
  }))
  await putTask(next)
  // 还原 = 重新上架：这张卡交付过就把文件补回去（没交付过的不用凭空建文件夹）
  if (isTauri && next.deliverFolder) {
    try {
      const context = await buildDeliverContext()
      const result = await deliverTaskCard(next, context)
      recordDeliveredFiles(result.files, result.dir)
    } catch (err) {
      console.warn('还原后补写交付文件失败：', err)
    }
  }
  useStore.getState().showToast(`已还原 ${imageIds.length} 张图片`, 'success')
}

/** 图片回收站里的全部条目：按任务卡分组，供回收站弹窗渲染 */
export function collectTrashedOutputImages(tasks: TaskRecord[]): Array<{ task: TaskRecord; imageIds: string[] }> {
  return tasks
    .filter((task) => (task.trashedOutputImages?.length ?? 0) > 0)
    .map((task) => ({ task, imageIds: task.trashedOutputImages ?? [] }))
}

/**
 * 彻底删除图片回收站里的图：从成品数组和按序对齐的原图数组里一起摘掉，再删图片本体。
 *
 * 三个数组（成品 / AI 原图 / 透明背景原图）是按下标对齐的，
 * 所以按「保留下来的下标」统一过滤，不能各自 filter，否则后面的图会错拿别人的原图。
 */
export async function purgeTrashedOutputImages(taskId: string, imageIds?: string[]): Promise<number> {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return 0
  const targets = new Set(imageIds?.length ? imageIds : task.trashedOutputImages ?? [])
  if (!targets.size) return 0

  const removedIds = task.outputImages.filter((id) => targets.has(id))
  const nextOutputs = task.outputImages.filter((id) => !targets.has(id))
  const nextTrashed = (task.trashedOutputImages ?? []).filter((id) => !targets.has(id))
  const keptIndexes: number[] = []
  task.outputImages.forEach((id, index) => {
    if (!targets.has(id)) keptIndexes.push(index)
  })
  // 长度对不上说明这份数组和成品不是同一次生成的，宁可不动它，也别按错位的下标删
  const pickAligned = (list?: string[]) => (
    list && list.length === task.outputImages.length ? keptIndexes.map((index) => list[index]) : list
  )
  const omitKeys = <T>(record: Record<string, T> | undefined) => {
    if (!record) return record
    const next: Record<string, T> = {}
    for (const [key, value] of Object.entries(record)) {
      if (!targets.has(key)) next[key] = value
    }
    return next
  }

  updateTaskInStore(taskId, {
    outputImages: nextOutputs,
    sourceImages: pickAligned(task.sourceImages),
    transparentOriginalImages: pickAligned(task.transparentOriginalImages),
    trashedOutputImages: nextTrashed.length ? nextTrashed : undefined,
    actualParamsByImage: omitKeys(task.actualParamsByImage),
    revisedPromptByImage: omitKeys(task.revisedPromptByImage),
  })
  await deleteUnreferencedImageIds(targets)
  return removedIds.length
}

/** 清空图片回收站：所有被回收的单图都彻底删掉 */
export async function purgeAllTrashedOutputImages(): Promise<number> {
  const entries = collectTrashedOutputImages(useStore.getState().tasks)
  let total = 0
  for (const entry of entries) {
    total += await purgeTrashedOutputImages(entry.task.id, entry.imageIds)
    // 只记了 id、图已经不在了的，顺手把标记清掉，别在回收站里永远挂着
    const latest = useStore.getState().tasks.find((item) => item.id === entry.task.id)
    if (latest?.trashedOutputImages?.length) {
      updateTaskInStore(entry.task.id, { trashedOutputImages: undefined })
    }
  }
  return total
}

/** 批量把选中的任务归到某个「产品-方向」下，传 null 表示清空归属 */
export async function assignTasksDirection(taskIds: string[], directionId: string | null) {
  if (!taskIds.length) return 0
  const idSet = new Set(taskIds)
  const changed: TaskRecord[] = []
  useStore.setState((state) => ({
    tasks: state.tasks.map((task) => {
      if (!idSet.has(task.id)) return task
      const next = { ...task, sopDirectionId: directionId ?? undefined }
      changed.push(next)
      return next
    }),
  }))
  for (const task of changed) await putTask(task)
  useStore.getState().showToast(
    directionId ? `已把 ${changed.length} 个任务归入所选方向` : `已清空 ${changed.length} 个任务的归属`,
    'success',
  )
  return changed.length
}

/** 批量设置渠道；传 null 表示清空（未指定） */
export async function assignTasksChannel(taskIds: string[], channel: string | null) {
  if (!taskIds.length) return 0
  const idSet = new Set(taskIds)
  const changed: TaskRecord[] = []
  useStore.setState((state) => ({
    tasks: state.tasks.map((task) => {
      if (!idSet.has(task.id)) return task
      const next = { ...task, channel: channel ?? undefined }
      changed.push(next)
      return next
    }),
  }))
  for (const task of changed) await putTask(task)
  useStore.getState().showToast(
    channel
      ? `已把 ${changed.length} 个任务设为「${channelLabel(channel)}」`
      : `已清空 ${changed.length} 个任务的渠道`,
    'success',
  )
  return changed.length
}

/** 删除所有失败任务 */
export async function clearFailedTasks(taskIds?: string[]) {  const targetTaskIds = taskIds ? new Set(taskIds) : null
  const failedTasks = useStore.getState().tasks
    .filter((task) => taskMatchesFilterStatus(task, 'error') && (!targetTaskIds || targetTaskIds.has(task.id)))
  const failedTaskIds = failedTasks
    .filter((task) => task.status === 'error')
    .map((task) => task.id)
  const partialFailedTaskIds = new Set(
    failedTasks
      .filter((task) => task.status !== 'error' && taskHasOutputErrors(task))
      .map((task) => task.id),
  )

  if (failedTaskIds.length) await removeMultipleTasks(failedTaskIds)
  if (partialFailedTaskIds.size) {
    const { tasks, setTasks, selectedTaskIds, setSelectedTaskIds, showToast } = useStore.getState()
    const updated = tasks.map((task) => partialFailedTaskIds.has(task.id) ? { ...task, outputErrors: undefined } : task)
    setTasks(updated)
    const nextSelectedTaskIds = selectedTaskIds.filter((id) => !partialFailedTaskIds.has(id))
    if (nextSelectedTaskIds.length !== selectedTaskIds.length) setSelectedTaskIds(nextSelectedTaskIds)
    await Promise.all(updated.filter((task) => partialFailedTaskIds.has(task.id)).map((task) => putTask(task)))
    showToast(`已清除 ${partialFailedTaskIds.size} 条部分失败记录`, 'success')
  }
}

/** 删除单条任务 */
/**
 * 底层删除：直接把任务从库里清掉（含图片）。
 * 大量既有逻辑（Agent 晚期响应清理、DB 记录校验等）依赖这个语义，不要改它。
 * 用户点「删除」走的是 trashTask / trashTasks（进回收站）。
 */
export async function removeTask(task: TaskRecord) {
  // SOP 卡片是一组任务，删除时整组一起清掉
  const ids = task.sopJobId
    ? useStore.getState().tasks.filter((item) => item.sopJobId === task.sopJobId).map((item) => item.id)
    : [task.id]
  const deletedCount = await removeTasks(ids)
  if (deletedCount === 0) return
  useStore.getState().showToast(ids.length > 1 ? `已删除该 SOP 下的 ${ids.length} 个任务` : '任务已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()
  // 清空后剩余的批量提示词已没有对应的任务、配置或图片，直接结束批量
  if (useStore.getState().batchProgress) endBatch(activeBatchId)
  // 排队的提交也一并丢掉，否则清空后又自己跑出来
  clearPendingSubmissions()

  if (options.clearTasks) {
    await dbClearTasks()
    await dbClearAgentConversations()
    await clearImages()
    clearImageCaches()
    setTasks([])
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
      supportPromptOpen: false,
      supportPromptSkippedForImportedData: false,
    })
    clearInputImages()
    clearMaskDraft()
  }

  if (options.clearConfig) {
    const presetConfig = getPresetConfig()
    useStore.setState({
      dismissedPresetProfileIds: [],
      dismissedPresetProviderIds: [],
      dismissedCodexCliPrompts: [],
      supportPromptDismissed: false,
    })
    if (presetConfig) {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS } })
      await useStore.getState().setPresetImportedSettings(presetConfig)
    } else {
      setSettings({ ...DEFAULT_SETTINGS })
    }
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast('所选数据已清空', 'success')
}

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done' || latest.error === AGENT_STOPPED_MESSAGE) return
  if (latest.status !== 'running' && !latest.customRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, sourceImages, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || latestBeforeUpdate.error === AGENT_STOPPED_MESSAGE || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.customRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    sourceImages,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    customRecoverable: false,
  })
  useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `自定义异步任务已恢复，共 ${outputIds.length} 张图片。`)
  else void continueRecoveredAgentRound(task.id)
  const recoveredCustomTask = useStore.getState().tasks.find((item) => item.id === task.id)
  if (recoveredCustomTask) scheduleAutoDeliver(recoveredCustomTask)
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = profile ? getCustomProviderDefinition(settings, profile.provider) : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  try {
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    const error = err instanceof Error ? err.message : String(err)
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, error, Date.now()),
      ...getRawErrorPayload(err),
      customRecoverable: false,
    })
    showTaskFailureNotification(task)
    if (isAgentTask(task)) void continueRecoveredAgentRound(taskId)
  }
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
  /** 提示词库：方向树、系统提示词、卖点、风格、后处理模板 */
  exportLibrary?: boolean
  /** 只导出这些业务方向下的任务卡；不传等于全部 */
  taskScope?: DirectionScope
}

/** 从任务里收出全部图片 id（含输入图、遮罩、中间步骤图） */
function collectTaskImageIds(tasks: TaskRecord[]) {
  const ids = new Set<string>()
  for (const task of tasks) {
    for (const id of task.outputImages || []) ids.add(id)
    for (const id of task.inputImageIds || []) ids.add(id)
    // AI 原图 / 参考图：导出后换台机器也要能「下载原图」「复用配置」
    for (const id of task.sourceImages || []) ids.add(id)
    for (const id of task.sopReferenceImageIds || []) ids.add(id)
    for (const id of task.transparentOriginalImages || []) ids.add(id)
    for (const id of task.streamPartialImageIds || []) ids.add(id)
    if (task.maskImageId) ids.add(task.maskImageId)
  }
  return [...ids]
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true, exportLibrary: true }) {
  // 导出全程可取消：网页版放弃后续下载，客户端丢弃正在写入的临时文件
  const signal = startDataProgress('export', true)
  let savedParts = 0
  try {
    const state = useStore.getState()
    if (options.exportTasks && hasActiveDataOperations(state.tasks, state.agentConversations)) throw new Error('有任务正在进行，完成或停止后再导出。')
    const allTasks = options.exportTasks ? await getAllTasks() : []
    // 选了具体业务方向时只带这部分任务，提示词库仍整份带（配置按产品存，拆开反而残缺）
    const scope = options.taskScope ?? ALL_SCOPE
    const tasks = filterTasksByScope(allTasks, useSopStore.getState().directions, scope)
    const taskIds = new Set(tasks.map((task) => task.id))
    // 选全部时维持原口径（导出图库里所有图）；选了具体方向才收窄到这些任务引用的图
    const imageIds = options.exportTasks
      ? (scope.all ? await getAllImageIds() : collectTaskImageIds(tasks))
      : []
    const { settings, agentConversations, favoriteCollections, defaultFavoriteCollectionId } = state
    const exportedAt = Date.now()
    // Agent 会话按轮次引用任务；任务被筛掉后这些会话读出来会是空的，一并去掉
    const scopedConversations = options.exportTasks
      ? getPersistableAgentConversations(agentConversations).filter((conversation) =>
          conversation.rounds.every((round) => round.outputTaskIds.every((id) => taskIds.has(id))))
      : []
    const params = {
      options,
      exportedAt,
      settings,
      tasks,
      imageTasks: tasks,
      favoriteCollections,
      defaultFavoriteCollectionId,
      agentConversations: scopedConversations,
      sopLibrary: options.exportLibrary ? collectSopLibrary() : undefined,
    }
    // 进度回调中检查取消，逐张读取时也能及时中断
    const imageSizes = await getExportImageSizes(imageIds, (done) => {
      throwIfAborted(signal)
      updateDataProgress('统计图片', done, imageIds.length, 'image')
    })
    throwIfAborted(signal)
    const plan = getExportZipPlan(params, imageSizes)
    const backupId = `${exportedAt}`
    // 客户端分卷备份时先选择目录，一次写入全部分卷，替代浏览器的多文件下载
    if (isTauri && plan.length > 1) updateDataProgress('选择保存位置')
    const dir = isTauri && plan.length > 1 ? await pickSaveDir() : null
    if (isTauri && plan.length > 1 && !dir) return
    let savedPath = ''
    const imageTotal = plan.reduce((sum, part) => sum + part.imageIds.length, 0)
    let imagesRead = 0

    for (let index = 0; index < plan.length; index++) {
      const partNumber = index + 1
      const partLabel = plan.length > 1 ? `（第 ${partNumber} / ${plan.length} 卷）` : ''
      throwIfAborted(signal)
      const { images, thumbnailsByImageId } = await readExportImages(plan[index].imageIds, (done) => {
        throwIfAborted(signal)
        updateDataProgress(`读取图片${partLabel}`, imagesRead + done, imageTotal, 'image')
      })
      imagesRead += plan[index].imageIds.length
      throwIfAborted(signal)
      updateDataProgress(`打包${partLabel}`)

      const result = await buildExportZip({
        ...params,
        tasks: plan[index].tasks,
        agentConversations: plan[index].agentConversations,
        images,
        thumbnailsByImageId,
        includeManifestData: plan[index].includeBaseData,
        backupPart: plan.length > 1 ? { id: backupId, index: partNumber, total: plan.length } : undefined,
      })
      const suffix = plan.length > 1 ? `_${String(plan.length).padStart(2, '0')}parts_part${String(partNumber).padStart(2, '0')}` : ''
      const fileName = `gpt-image-playground-backup_${formatExportFileTime(new Date(exportedAt))}${suffix}.zip`
      throwIfAborted(signal)
      updateDataProgress(`保存文件${partLabel}`)
      const saveOpts: SaveOptions = { signal, onProgress: (written, total) => updateDataProgress(`保存文件${partLabel}`, written, total, 'byte') }
      if (dir) {
        await saveFileToDir(dir, result.bytes, fileName, saveOpts)
        savedParts++
        continue
      }
      // 客户端直接传字节给 Rust 写入，不再复制一份 Blob
      const saved = await saveFile(isTauri ? result.bytes : createExportBlob(result.bytes), fileName, saveOpts)
      if (!saved) return
      savedParts++
      savedPath = saved
      if (partNumber < plan.length) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const msg = dir
      ? `已导出 ${plan.length} 个 ZIP 到 ${dir.path}`
      : plan.length > 1 ? `正在下载 ${plan.length} 个 ZIP，如被浏览器拦截，请允许多文件下载` : isTauri ? `已导出到 ${savedPath}` : '数据已导出'
    useStore.getState().showToast(msg, 'success')
  } catch (e) {
    if (signal.aborted) {
      useStore.getState().showToast(savedParts ? `已取消导出，已${isTauri ? '保存' : '下载'}的 ${savedParts} 个分卷不完整，可以删除` : '已取消导出', 'info')
      return
    }
    console.error('exportData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导出失败，${detail}` : '导出失败', 'error')
  } finally {
    endDataProgress()
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
  /** 提示词库：方向树、系统提示词、卖点、风格、后处理模板 */
  importLibrary?: boolean
  /** 只导入这些业务方向下的任务卡；不传等于全部 */
  taskScope?: DirectionScope
}

export async function restoreExplicitPresetConfig(ids: { providerIds: string[], profileIds: string[] }) {
  const presetProviderIds = getPresetProviderIds()
  const presetProfileIds = getPresetProfileIds()
  const providerIds = ids.providerIds.filter((id) => presetProviderIds.has(id))
  const profileIds = ids.profileIds.filter((id) => presetProfileIds.has(id))
  if (!providerIds.length && !profileIds.length) return false

  const state = useStore.getState()
  for (const id of providerIds) state.restorePresetProvider(id)
  for (const id of profileIds) state.restorePresetProfile(id)
  const presetConfig = getPresetConfig()
  if (presetConfig) await useStore.getState().setPresetImportedSettings(presetConfig)
  return true
}

/** 导入 ZIP 数据 */
export async function importData(input: File | File[], options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  // 只允许在解析备份阶段取消；开始写入后取消会留下半份数据
  const signal = startDataProgress('import', true)
  try {
    const state = useStore.getState()
    if (options.importTasks && hasActiveDataOperations(state.tasks, state.agentConversations)) throw new Error('有任务正在进行，完成或停止后再导入。')
    const files = Array.isArray(input) ? input : [input]
    if (!files.length) throw new Error('没有选择备份文件。')
    if (files.some((file) => file.size >= MAX_EXPORT_ZIP_BYTES)) {
      throw new Error('单个 ZIP 不能超过 2 GB，请使用分卷备份。')
    }

    const selected = [] as Array<{ file: File; manifest: Awaited<ReturnType<typeof readExportZipManifest>> }>
    for (const [idx, file] of files.entries()) {
      updateDataProgress('解析备份', idx, files.length > 1 ? files.length : 0, files.length > 1 ? 'file' : undefined)
      const manifest = await readExportZipManifest(new Uint8Array(await file.arrayBuffer()), options.importTasks)
      selected.push({ file, manifest })
      throwIfAborted(signal)
    }
    const multipart = selected.some((part) => part.manifest.backupPart != null)
    if (multipart) {
      if (selected.some((part) => !part.manifest.backupPart)) throw new Error('不能同时选择分卷备份和普通备份。')
      const first = selected[0].manifest.backupPart!
      const indexes = new Set(selected.map((part) => part.manifest.backupPart!.index))
      const validSet = selected.every((part) => {
        const backupPart = part.manifest.backupPart!
        return backupPart.id === first.id && backupPart.total === first.total && backupPart.index >= 1 && backupPart.index <= first.total
      })
      if (!validSet || indexes.size !== selected.length) throw new Error('所选分卷不属于同一份备份，或有重复。')
      if (options.importTasks && (selected.length !== first.total || indexes.size !== first.total)) {
        throw new Error(`分卷不全，请一次选择全部 ${first.total} 个 ZIP。`)
      }
      selected.sort((a, b) => a.manifest.backupPart!.index - b.manifest.backupPart!.index)
    }

    const settingsManifests = selected.filter((part) => part.manifest.settings)
    const libraryManifests = selected.filter((part) => part.manifest.sopLibrary)
    if (options.importConfig && !options.importTasks && !options.importLibrary && !settingsManifests.length) throw new Error('这份备份里没有配置。')
    if (options.importLibrary && !options.importTasks && !(options.importConfig && settingsManifests.length) && !libraryManifests.length) {
      throw new Error('这份备份里没有提示词库。')
    }
    const allImportedTasks = selected.flatMap((part) => part.manifest.tasks ?? [])
    // 范围按备份自带的业务树判断：本地方向树可能与来源不同，用本地树会筛错
    const backupDirections = selected
      .map((part) => part.manifest.sopLibrary?.directions)
      .find((list) => Boolean(list?.length)) ?? []
    const scope = options.taskScope ?? ALL_SCOPE
    const importedTasks = filterTasksByScope(allImportedTasks, backupDirections, scope)
    const importedTaskIds = new Set(importedTasks.map((task) => task.id))
    // 被筛掉的任务不写图片，省得把没选的方向也塞进图库
    const keptImageIds = new Set(collectTaskImageIds(importedTasks))
    const importedAgentConversations = scope.all
      ? selected.flatMap((part) => part.manifest.agentConversations ?? [])
      : selected.flatMap((part) => part.manifest.agentConversations ?? [])
          .filter((conversation) => conversation.rounds.every((round) => round.outputTaskIds.every((id) => importedTaskIds.has(id))))
    const hasTaskData = selected.some((part) => part.manifest.tasks != null || part.manifest.imageFiles != null)
    if (options.importTasks && !options.importConfig && !options.importLibrary && !scope.all && !importedTasks.length) {
      throw new Error('所选业务方向下没有任务卡。')
    }

    // 先关闭取消再检查，确保点了取消就不会进入写入阶段
    setDataProgressCancelable(false)
    throwIfAborted(signal)

    const importedImageIds: string[] = []
    if (options.importTasks && hasTaskData) {
      // 原图和缩略图合并计数，分片交替写入时进度条也只增不减
      const fileTotal = selected.reduce((sum, part) => sum + Object.keys(part.manifest.imageFiles ?? {}).length + Object.keys(part.manifest.thumbnailFiles ?? {}).length, 0)
      let filesDone = 0
      for (const [idx, part] of selected.entries()) {
        updateDataProgress(selected.length > 1 ? `读取备份（第 ${idx + 1} / ${selected.length} 个）` : '读取备份', filesDone, fileTotal, 'file')
        const { manifest, files: zipFiles } = await readExportZip(new Uint8Array(await part.file.arrayBuffer()))
        for (const [id, info] of Object.entries(manifest.imageFiles ?? {})) {
          // 先计入当前文件，写到最后一个时进度到 100%
          updateDataProgress('写入图片和缩略图', ++filesDone, fileTotal, 'file')
          // 按方向筛掉的任务，它的图不写进来
          if (!scope.all && !keptImageIds.has(id)) continue
          const dataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!dataUrl) continue
          await putImage({
            id,
            dataUrl,
            createdAt: info.createdAt,
            source: info.source,
            width: info.width,
            height: info.height,
          })
          cacheImage(id, dataUrl)
          importedImageIds.push(id)
        }

        for (const [id, info] of Object.entries(manifest.thumbnailFiles ?? {})) {
          updateDataProgress('写入图片和缩略图', ++filesDone, fileTotal, 'file')
          if (!scope.all && !keptImageIds.has(id)) continue
          const thumbnailDataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!thumbnailDataUrl) continue
          await putImageThumbnail({
            id,
            thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
          cacheThumbnail(id, {
            src: thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
        }
      }

      updateDataProgress('写入任务和会话')
      for (const task of importedTasks) {
        // startedAt 来自导入文件，非法值会让计时和“重试于”显示异常
        await putTask(Number.isFinite(task.startedAt) || task.startedAt === undefined ? task : { ...task, startedAt: undefined })
      }

      const tasks = await getAllTasks()
      const state = useStore.getState()
      const importedFavoriteCollections = selected.flatMap((part) => part.manifest.favoriteCollections ?? [])
      const mergedFavorites = mergeFavoriteCollections(state.favoriteCollections, importedFavoriteCollections)
      const favoriteCollections = mergedFavorites.collections
      const importedDefaultFavoriteCollectionId = selected
        .map((part) => part.manifest.defaultFavoriteCollectionId)
        .find((id) => id != null && favoriteCollections.some((collection) => collection.id === id))
      const defaultFavoriteCollectionId = mergedFavorites.importedCollections.length
        ? resolveDefaultFavoriteCollectionId(favoriteCollections, importedDefaultFavoriteCollectionId)
        : state.defaultFavoriteCollectionId
      const normalizedFavorites = normalizeLoadedFavoriteState(tasks, favoriteCollections, defaultFavoriteCollectionId)
      useStore.setState({
        tasks: normalizedFavorites.tasks,
        favoriteCollections: normalizedFavorites.collections,
        defaultFavoriteCollectionId: normalizedFavorites.defaultFavoriteCollectionId,
      })
      if (normalizedFavorites.changed) await Promise.all(normalizedFavorites.tasks.map((task) => putTask(task)))
      const normalizedAgentConversations = normalizeAgentConversations(importedAgentConversations)
        .filter((conversation) => !isEmptyAgentConversation(conversation))
      useStore.setState((state) => {
        const agentConversations = mergeImportedAgentConversations(state.agentConversations, normalizedAgentConversations)
        const activeAgentConversationId = state.activeAgentConversationId && agentConversations.some((conversation) => conversation.id === state.activeAgentConversationId)
          ? state.activeAgentConversationId
          : normalizedAgentConversations[0]?.id ?? agentConversations[0]?.id ?? null
        return {
          agentConversations,
          activeAgentConversationId,
        }
      })
      await replaceStoredAgentConversations(useStore.getState().agentConversations)
      skipSupportPromptForImportedData(tasks)
      void scheduleMissingThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && settingsManifests.length) {
      const state = useStore.getState()
      const providerIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.customProviders?.map((provider) => provider.id) ?? [],
      ))
      const profileIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.profiles.map((profile) => profile.id) ?? [],
      ))
      const presetProviderIds = getPresetProviderIds()
      const presetProfileIds = getPresetProfileIds()
      for (const id of providerIds) {
        if (presetProviderIds.has(id)) state.restorePresetProvider(id)
      }
      for (const id of profileIds) {
        if (presetProfileIds.has(id)) state.restorePresetProfile(id)
      }
      const current = useStore.getState()
      const settings = settingsManifests.reduce(
        (current, part) => mergeImportedSettings(current, part.manifest.settings, { preserveInternalIds: true }),
        current.settings,
      )
      current.setSettings(settings)
    }

    if (options.importLibrary && libraryManifests.length) {
      // 按 id 合并，同 id 以备份里的为准
      for (const part of libraryManifests) mergeSopLibrary(part.manifest.sopLibrary)
    }

    let msg = '导入完成'
    if (options.importTasks && hasTaskData) {
      msg = `已导入 ${importedTasks.length} 个任务`
    } else if (options.importConfig && settingsManifests.length) {
      msg = '配置已导入'
    } else if (options.importLibrary && libraryManifests.length) {
      msg = '提示词库已导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    if (signal.aborted) {
      useStore.getState().showToast('已取消导入', 'info')
      return false
    }
    console.error('importData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导入失败，${detail}` : '导入失败', 'error')
    return false
  } finally {
    endDataProgress()
  }
}

/**
 * 批量把文件转成输入图（拖拽/批量上传用）。
 *
 * 逐张 await 会让每张图片都走一遍「读取 → 存库 → setState → 整块重渲染」，
 * 二三十张就是几十次全量重渲染，界面直接卡住。这里改成：
 * 有限并发地读取转换，最后一次性追加到输入区，只触发一次更新。
 *
 * 单张失败不影响其他图片，失败数通过返回值里的 failed 告知调用方。
 */
export async function addImagesFromFiles(
  files: File[],
  options: { limit?: number; target?: 'input' | 'fixed' | 'variable'; concurrency?: number } = {},
): Promise<{ added: number; discarded: number; overflow: number; failed: number }> {
  const { limit, target = 'input', concurrency = 4 } = options
  const accepted = files.filter((file) => file.type.startsWith('image/'))
  const discarded = files.length - accepted.length

  const state = useStore.getState()
  const currentCount = target === 'fixed'
    ? state.fixedImages.length
    : target === 'variable'
      ? state.variableImages.length
      : state.inputImages.length
  const remaining = limit == null ? accepted.length : Math.max(0, limit - currentCount)
  const toAdd = accepted.slice(0, remaining)
  const overflow = accepted.length - toAdd.length

  const created: InputImage[] = []
  let failed = 0
  await runWithConcurrency(toAdd, Math.max(1, concurrency), async (file) => {
    try {
      const image = await createInputImageFromFile(file)
      if (image) created.push(image)
    } catch (err) {
      failed += 1
      console.warn('读取图片失败', file.name, err)
    }
  })

  const store = useStore.getState()
  const added = target === 'fixed'
    ? store.addFixedImages(created, limit)
    : target === 'variable'
      ? store.addVariableImages(created, limit)
      : store.addInputImages(created, limit)
  return { added, discarded, overflow, failed }
}

export async function createInputImageFromFile(file: File): Promise<InputImage | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await fileToDataUrl(file)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  return { id, dataUrl }
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await apiFetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

/** SOP 模式：把生成好的提示词批量提交，同一 sopJobId 在画廊里聚合成一张任务卡 */
export async function submitSopTasks(input: {
  sopJobId: string
  sopName: string
  systemPromptName: string
  /** 直接用存档 SOP 时的名字：写进任务卡，详情页据此显示来源 */
  savedSopName?: string
  sopText?: string
  directionId?: string
  referenceImageIds?: string[]
  prompts: string[]
  /**
   * 变量模式图生图：与 prompts 一一对应的输入图（固定图 + 变量图）。
   * 不传时 `inputImageIds` 为空，就是原来「纯靠提示词出图」的行为。
   */
  inputImagesPerPrompt?: InputImage[][]
  /** 变量模式图生图：每条提示词各自用到的变量图 id，详情页回看用 */
  variableImageIds?: Array<string | undefined>
  /**
   * 提示词序号从几开始。补充生图时这张卡已有若干条，
   * 不往后顺延会出现两个「第 1 条」，详情页排序和对照就乱了。
   */
  promptIndexOffset?: number
  /** 变量模式：附带骨架与逐维取值，SOP 模式不传 */
  variable?: {
    promptName: string
    specText: string
    /** 与 prompts 一一对应：填词用的策略名 + 各变量取值 */
    fills: Array<{ skeleton: string; assignments: Record<string, string> }>
  }
  /**
   * 发送瞬间的输入框快照（模式 / 分池图片），供「复用配置」还原输入框。
   * SOP 与变量模式的分池情况不同，由调用方按当时的模式构造。
   */
  inputSnapshot?: TaskInputSnapshot
  /**
   * 出图参数（尺寸 / 质量 / 后处理开关…）。
   *
   * 流水线要等反推、写提示词跑完才调到这里，那已经是几分钟之后 ——
   * 这期间用户改过的尺寸不该影响这一批（提示词里的预留区是按入队时尺寸算的），
   * 所以由调用方把入队那一刻的参数传进来，没传才退回当前全局参数。
   */
  params?: TaskParams
}): Promise<string[]> {
  const state = useStore.getState()
  const settings = state.settings
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  if (!profile) {
    state.showToast('还没有可用的接口配置', 'error')
    return []
  }

  const tasks: TaskRecord[] = input.prompts.map((prompt, index) => {
    const fill = input.variable?.fills[index]
    const promptImages = input.inputImagesPerPrompt?.[index] ?? []
    const fixedImageIds = input.variableImageIds?.[index]
      ? promptImages.filter((img) => img.id !== input.variableImageIds?.[index]).map((img) => img.id)
      : promptImages.map((img) => img.id)
    return {
      id: genId(),
      prompt,
      params: { ...(input.params ?? state.params), n: 1 },
      apiProvider: profile.provider,
      apiProfileId: profile.id,
      apiProfileName: profile.name,
      apiMode: profile.apiMode,
      apiModel: profile.model,
      inputImageIds: promptImages.map((img) => img.id),
      outputImages: [],
      status: 'running',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
      sopJobId: input.sopJobId,
      sopName: input.sopName,
      sopPromptIndex: (input.promptIndexOffset ?? 0) + index + 1,
      sopSystemPrompt: input.systemPromptName,
      sopLibraryName: input.savedSopName,
      sopText: input.sopText,
      sopDirectionId: input.directionId || undefined,
      // 与归属一样取提交瞬间的卖点：命名模板 {point} 用（SOP / 变量两条模式都走这里）
      sopPointName: pointNameForTask(input.directionId) || undefined,
      // 渠道不选在弹窗里，统一继承输入区当前的渠道筛选（「全部 / 未指定」不写）
      channel: channelForNewTask(useStore.getState().channelFilter),
      sopReferenceImageIds: input.referenceImageIds,
      variableMode: input.variable ? true : undefined,
      variablePromptName: input.variable?.promptName,
      variableSpecText: input.variable?.specText,
      variableSkeleton: fill?.skeleton,
      variableAssignments: fill?.assignments,
      variableImageId: input.variableImageIds?.[index],
      // 同一批的固定图都一样；存下来是为了复用配置时能拆回「固定图」区
      variableFixedImageIds: fixedImageIds.length ? fixedImageIds : undefined,
      /**
       * 快照整批共用一份。`prompt` 在这里是「本条填词/写出来的提示词」，
       * 不是用户输入框里的原文 —— 输入框原文由调用方放进 inputSnapshot.prompt
       * （见 sopPipeline / variablePipeline 的 inputPrompt），这一层不能拿它覆盖，
       * 否则复用配置会把模型生成的长提示词塞回输入框。
       */
      inputSnapshot: input.inputSnapshot,
    }
  })

  useStore.getState().setTasks([...tasks, ...useStore.getState().tasks])
  for (const task of tasks) void putTask(task)

  // 出图也限并发，避免几十条同时打满接口；界面不受影响
  const limit = Math.min(10, tasks.length)
  let cursor = 0
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor]
      cursor += 1
      executeTask(task.id)
      await waitForTaskSettled(task.id, () => false)
    }
  })
  await Promise.all(workers)

  useStore.getState().showToast(
    `${input.variable ? '变量模式' : 'SOP'} 已提交 ${tasks.length} 条提示词`,
    'success',
  )
  return tasks.map((task) => task.id)
}

/**
 * SOP 模式：先插一张占位卡，让用户点完发送就能看到进度。
 * stage 决定卡上的说法 —— 用存档 SOP 出图时并没有在反推，写「正在反推」会误导。
 */
export function createSopPlaceholder(
  sopJobId: string,
  label: string,
  directionId?: string,
  stage: 'reverse' | 'write' = 'reverse',
) {
  const state = useStore.getState()
  const task: TaskRecord = {
    id: genId(),
    prompt: `${label} · ${stage === 'write' ? '正在按 SOP 写提示词…' : '正在反推 SOP…'}`,
    params: { ...state.params, n: 1 },
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    sopJobId,
    sopName: label,
    sopPromptIndex: 0,
    sopDirectionId: directionId || undefined,
    // 占位卡也带上渠道，否则反推/写提示词这几分钟里，卡会被渠道筛选藏住
    channel: channelForNewTask(useStore.getState().channelFilter),
    sopPlaceholder: true,
  }
  useStore.getState().setTasks([task, ...useStore.getState().tasks])
  void putTask(task)
  return task.id
}

/** SOP 模式：拿到提示词后移除占位卡，真实任务已经就位 */
export async function removeSopPlaceholder(taskId: string) {
  await removeTasks([taskId])
}

/** SOP 模式：改写某张卡片依据的 SOP 全文，同组任务一起更新 */
export function updateSopText(sopJobId: string, sopName: string, sopText: string) {
  const state = useStore.getState()
  const targets = state.tasks.filter((task) => task.sopJobId === sopJobId)
  if (!targets.length) return
  state.setTasks(state.tasks.map((task) => (
    task.sopJobId === sopJobId ? { ...task, sopName, sopText } : task
  )))
  for (const task of targets) void putTask({ ...task, sopName, sopText })
}
