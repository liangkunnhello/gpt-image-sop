import type { AgentConversation, AgentInputDraft, AppMode, AppSettings, FavoriteCollection, InputImage, MaskDraft, PresetConfig, TaskParams } from '../types'
import { normalizePresetAgent, normalizeSettings } from './apiProfiles'
import { normalizeAgentConversations } from './agentConversationState'
import { ensureDefaultFavoriteCollection, normalizeFavoriteCollections, resolveDefaultFavoriteCollectionId } from './favoriteState'
import { cleanStaleAgentInputDrafts, getPersistableAgentInputDrafts, isEmptyAgentInputDraft, normalizeAgentInputDraft, normalizeAgentInputDrafts, normalizeAgentInputDraftsByKey, saveGalleryInputDraft } from './inputDraftState'
import { getPersistableAgentConversations, stripPersistedAgentConversations } from './agentResponseState'

export interface PersistedAppState {
  settings: AppSettings
  previousPresetConfig?: PresetConfig | null
  dismissedPresetProfileIds?: string[]
  dismissedPresetProviderIds?: string[]
  params: TaskParams
  /** 普通模式的发图方式，默认批量 */
  plainImageMode?: 'merge' | 'batch'
  prompt?: string
  inputImages?: InputImage[]
  /** 本次自定义文案：会一直被记住，直到用户手动清掉 */
  customCopy?: string
  dismissedCodexCliPrompts: string[]
  appMode: AppMode
  galleryInputDraft: AgentInputDraft | null
  agentConversations?: AgentConversation[]
  activeAgentConversationId: string | null
  agentInputDrafts: Record<string, AgentInputDraft>
  agentSidebarCollapsed: boolean
  agentAssetTab: 'references' | 'outputs'
  agentAssetPanelCollapsed: boolean
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  supportPromptDismissed: boolean
  supportPromptOpen: boolean
  supportPromptSkippedForImportedData: boolean
}

type PersistedStateSource = Omit<PersistedAppState, 'prompt' | 'inputImages' | 'agentConversations'> & {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  agentConversations: AgentConversation[]
}

type PersistedStateFallback = Pick<
  PersistedAppState,
  'settings' | 'params' | 'dismissedPresetProfileIds' | 'dismissedPresetProviderIds' | 'dismissedCodexCliPrompts' | 'favoriteCollections' | 'defaultFavoriteCollectionId'
> & {
  agentConversations: AgentConversation[]
}

export type NormalizedPersistedAppState = PersistedAppState & {
  previousPresetConfig: PresetConfig | null
  dismissedPresetProfileIds: string[]
  dismissedPresetProviderIds: string[]
  plainImageMode: 'merge' | 'batch'
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  agentConversations: AgentConversation[]
}

export interface PersistedStateMergePlan {
  state: NormalizedPersistedAppState
  hasLegacyAgentConversations: boolean
  shouldMigrateAgentConversations: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeParams(value: unknown, fallback: TaskParams): TaskParams {
  if (!isRecord(value)) return fallback
  return {
    size: typeof value.size === 'string' ? value.size : fallback.size,
    quality: value.quality === 'auto' || value.quality === 'low' || value.quality === 'medium' || value.quality === 'high' || value.quality === 'xhigh' || value.quality === 'max'
      ? value.quality
      : fallback.quality,
    output_format: value.output_format === 'png' || value.output_format === 'jpeg' || value.output_format === 'webp' ? value.output_format : fallback.output_format,
    output_compression: value.output_compression === null || (typeof value.output_compression === 'number' && Number.isFinite(value.output_compression))
      ? value.output_compression
      : fallback.output_compression,
    moderation: value.moderation === 'auto' || value.moderation === 'low' ? value.moderation : fallback.moderation,
    n: typeof value.n === 'number' && Number.isFinite(value.n) ? value.n : fallback.n,
    transparent_output: typeof value.transparent_output === 'boolean' ? value.transparent_output : fallback.transparent_output,
    post_process: typeof value.post_process === 'boolean' ? value.post_process : fallback.post_process,
    max_file_kb: typeof value.max_file_kb === 'number' && Number.isFinite(value.max_file_kb) && value.max_file_kb > 0
      ? value.max_file_kb
      : value.max_file_kb === null ? null : fallback.max_file_kb,
  }
}

export function createPersistedState(state: PersistedStateSource, includeLegacyAgentConversations = false): PersistedAppState {
  const settings = normalizeSettings(state.settings)
  const galleryInputDraft = saveGalleryInputDraft(state)
  return {
    settings,
    previousPresetConfig: state.previousPresetConfig ?? null,
    dismissedPresetProfileIds: state.dismissedPresetProfileIds ?? [],
    dismissedPresetProviderIds: state.dismissedPresetProviderIds ?? [],
    params: state.params,
    plainImageMode: state.plainImageMode ?? 'batch',
    ...(settings.persistInputOnRestart && (state.appMode === 'gallery' || galleryInputDraft)
      ? {
          prompt: galleryInputDraft?.prompt ?? '',
          inputImages: galleryInputDraft?.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) ?? [],
        }
      : {}),
    customCopy: state.customCopy ?? '',
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    appMode: state.appMode,
    galleryInputDraft: settings.persistInputOnRestart && galleryInputDraft
      ? { ...galleryInputDraft, inputImages: galleryInputDraft.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) }
      : null,
    ...(includeLegacyAgentConversations
      ? { agentConversations: getPersistableAgentConversations(state.agentConversations) }
      : {}),
    activeAgentConversationId: state.activeAgentConversationId,
    agentInputDrafts: settings.persistInputOnRestart ? getPersistableAgentInputDrafts(state) : {},
    agentSidebarCollapsed: state.agentSidebarCollapsed,
    agentAssetTab: state.agentAssetTab,
    agentAssetPanelCollapsed: state.agentAssetPanelCollapsed,
    favoriteCollections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    supportPromptDismissed: state.supportPromptDismissed,
    supportPromptOpen: state.supportPromptOpen,
    supportPromptSkippedForImportedData: state.supportPromptSkippedForImportedData,
  }
}

export function migratePersistedState(persistedState: unknown, _version?: number): unknown {
  if (!isRecord(persistedState)) return persistedState
  return {
    ...persistedState,
    agentConversations: stripPersistedAgentConversations(persistedState.agentConversations),
  }
}

export function normalizePersistedState(
  persistedState: unknown,
  fallback: PersistedStateFallback,
  now = Date.now(),
): PersistedStateMergePlan | null {
  if (!isRecord(persistedState)) return null

  const settings = normalizeSettings(persistedState.settings ?? fallback.settings)
  const previousPresetConfig = isRecord(persistedState.previousPresetConfig) && Array.isArray(persistedState.previousPresetConfig.profiles)
    ? (() => {
        const normalized = normalizeSettings(persistedState.previousPresetConfig)
        const agent = normalizePresetAgent(persistedState.previousPresetConfig.agent, normalized.profiles)
        return {
          customProviders: normalized.customProviders,
          profiles: persistedState.previousPresetConfig.profiles.length ? normalized.profiles : [],
          ...(agent ? { agent } : {}),
        }
      })()
    : null
  const hasLegacyAgentConversations = Array.isArray(persistedState.agentConversations)
  const agentConversations = hasLegacyAgentConversations
    ? normalizeAgentConversations(persistedState.agentConversations)
    : fallback.agentConversations
  const activeAgentConversationId = typeof persistedState.activeAgentConversationId === 'string' && (
    !hasLegacyAgentConversations || agentConversations.some((conversation) => conversation.id === persistedState.activeAgentConversationId)
  )
    ? persistedState.activeAgentConversationId
    : agentConversations[0]?.id ?? null
  const appMode = persistedState.appMode === 'agent' ? 'agent' : 'gallery'
  const galleryInputDraft = settings.persistInputOnRestart
    ? normalizeAgentInputDraft(persistedState.galleryInputDraft ?? {
        prompt: persistedState.prompt,
        inputImages: persistedState.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      }, now)
    : null
  const normalizedAgentInputDrafts = !settings.persistInputOnRestart
    ? {}
    : hasLegacyAgentConversations
      ? normalizeAgentInputDrafts(persistedState.agentInputDrafts, agentConversations)
      : normalizeAgentInputDraftsByKey(persistedState.agentInputDrafts)
  const cleanedAgentInputDrafts = cleanStaleAgentInputDrafts(normalizedAgentInputDrafts, activeAgentConversationId, now)
  const agentInputDrafts = appMode === 'agent' && activeAgentConversationId && !cleanedAgentInputDrafts[activeAgentConversationId] && settings.persistInputOnRestart && typeof persistedState.prompt === 'string'
    ? {
        ...cleanedAgentInputDrafts,
        [activeAgentConversationId]: normalizeAgentInputDraft({
          prompt: persistedState.prompt,
          inputImages: persistedState.inputImages,
          maskDraft: null,
          maskEditorImageId: null,
        }, now),
      }
    : cleanedAgentInputDrafts
  const restoredAgentDraft = settings.persistInputOnRestart && appMode === 'agent' && activeAgentConversationId
    ? agentInputDrafts[activeAgentConversationId] ?? null
    : null
  const favoriteCollections = Array.isArray(persistedState.favoriteCollections)
    ? ensureDefaultFavoriteCollection(normalizeFavoriteCollections(persistedState.favoriteCollections, now), now)
    : fallback.favoriteCollections
  const preferredDefaultFavoriteCollectionId = persistedState.defaultFavoriteCollectionId === null || typeof persistedState.defaultFavoriteCollectionId === 'string'
    ? persistedState.defaultFavoriteCollectionId
    : fallback.defaultFavoriteCollectionId

  return {
    state: {
      settings,
      previousPresetConfig,
      dismissedPresetProfileIds: normalizeStringArray(persistedState.dismissedPresetProfileIds, fallback.dismissedPresetProfileIds ?? []),
      dismissedPresetProviderIds: normalizeStringArray(persistedState.dismissedPresetProviderIds, fallback.dismissedPresetProviderIds ?? []),
      params: normalizeParams(persistedState.params, fallback.params),
      plainImageMode: persistedState.plainImageMode === 'merge' ? 'merge' : 'batch',
      dismissedCodexCliPrompts: normalizeStringArray(persistedState.dismissedCodexCliPrompts, fallback.dismissedCodexCliPrompts),
      appMode,
      galleryInputDraft: galleryInputDraft && !isEmptyAgentInputDraft(galleryInputDraft) ? galleryInputDraft : null,
      agentConversations,
      activeAgentConversationId,
      agentInputDrafts,
      agentSidebarCollapsed: Boolean(persistedState.agentSidebarCollapsed),
      agentAssetTab: persistedState.agentAssetTab === 'references' ? 'references' : 'outputs',
      agentAssetPanelCollapsed: Boolean(persistedState.agentAssetPanelCollapsed),
      favoriteCollections,
      defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(favoriteCollections, preferredDefaultFavoriteCollectionId),
      supportPromptDismissed: Boolean(persistedState.supportPromptDismissed),
      // 赞助弹窗自动弹出已关闭：恢复时强制为关闭，避免历史持久化值让弹窗重新出现
      supportPromptOpen: false,
      supportPromptSkippedForImportedData: Boolean(persistedState.supportPromptSkippedForImportedData),
      // 自定义文案不受「重启后恢复输入」开关约束：它是用户特意留着的一栏，
      // 不能因为关了输入恢复就每次重启都被清掉
      customCopy: typeof persistedState.customCopy === 'string' ? persistedState.customCopy : '',
      prompt: restoredAgentDraft ? restoredAgentDraft.prompt : galleryInputDraft?.prompt ?? '',
      inputImages: restoredAgentDraft ? restoredAgentDraft.inputImages : galleryInputDraft?.inputImages ?? [],
      maskDraft: restoredAgentDraft ? restoredAgentDraft.maskDraft : galleryInputDraft?.maskDraft ?? null,
      maskEditorImageId: restoredAgentDraft ? restoredAgentDraft.maskEditorImageId : galleryInputDraft?.maskEditorImageId ?? null,
    },
    hasLegacyAgentConversations,
    shouldMigrateAgentConversations: hasLegacyAgentConversations && agentConversations.length > 0,
  }
}

export function mergePersistedAgentConversations(stored: AgentConversation[], legacy: AgentConversation[]) {
  const merged = new Map<string, AgentConversation>()
  for (const conversation of stored) merged.set(conversation.id, conversation)
  for (const conversation of legacy) {
    const existing = merged.get(conversation.id)
    if (!existing || conversation.updatedAt >= existing.updatedAt) merged.set(conversation.id, conversation)
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
}
