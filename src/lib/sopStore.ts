import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SopDirectionNode, SopSystemPrompt } from '../types'
import type { PostTemplate } from './postTemplate'

/** 初始树按现有策略分类搭骨架，内容后续在界面里增删 */
const SEED_DIRECTIONS: SopDirectionNode[] = [
  { id: 'cat-insurance', parentId: null, name: '保险', kind: 'category' },
  { id: 'prod-million', parentId: 'cat-insurance', name: '百万医疗险', kind: 'product' },
  { id: 'dir-million-moon', parentId: 'prod-million', name: '月亮', kind: 'direction' },
  { id: 'dir-million-icon', parentId: 'prod-million', name: '图标', kind: 'direction' },
  { id: 'dir-million-illust', parentId: 'prod-million', name: '插画', kind: 'direction' },
  { id: 'dir-million-poster', parentId: 'prod-million', name: '大字报', kind: 'direction' },
  { id: 'dir-million-idea', parentId: 'prod-million', name: '内容创意', kind: 'direction' },
  { id: 'prod-jdb', parentId: 'cat-insurance', name: '京东保', kind: 'product' },
  { id: 'dir-jdb-flat', parentId: 'prod-jdb', name: '扁平插画', kind: 'direction' },
  { id: 'dir-jdb-poster', parentId: 'prod-jdb', name: '大字报', kind: 'direction' },
  { id: 'dir-jdb-real', parentId: 'prod-jdb', name: '真人海报', kind: 'direction' },
  { id: 'dir-jdb-3d', parentId: 'prod-jdb', name: '3D插画', kind: 'direction' },
  { id: 'dir-jdb-plane', parentId: 'prod-jdb', name: '平面海报', kind: 'direction' },
  { id: 'prod-modern', parentId: 'cat-insurance', name: '现代', kind: 'product' },
  { id: 'dir-modern-flat', parentId: 'prod-modern', name: '扁平插画', kind: 'direction' },
  { id: 'dir-modern-poster', parentId: 'prod-modern', name: '大字报', kind: 'direction' },
  { id: 'dir-modern-real', parentId: 'prod-modern', name: '真人海报', kind: 'direction' },
  { id: 'dir-modern-3d', parentId: 'prod-modern', name: '3D插画', kind: 'direction' },
  { id: 'dir-modern-plane', parentId: 'prod-modern', name: '平面海报', kind: 'direction' },
  { id: 'cat-app', parentId: null, name: 'APP-拉新', kind: 'category' },
  { id: 'prod-kuaishou', parentId: 'cat-app', name: '快手', kind: 'product' },
  { id: 'dir-ks-money', parentId: 'prod-kuaishou', name: '网赚', kind: 'direction' },
  { id: 'dir-ks-pet', parentId: 'prod-kuaishou', name: '萌宠', kind: 'direction' },
  { id: 'dir-ks-song', parentId: 'prod-kuaishou', name: '老歌', kind: 'direction' },
  { id: 'dir-ks-travel', parentId: 'prod-kuaishou', name: '旅游', kind: 'direction' },
  { id: 'dir-ks-food', parentId: 'prod-kuaishou', name: '美食', kind: 'direction' },
]

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 侧栏「未归属」筛选项的特殊值 */
export const UNASSIGNED_FILTER = '__unassigned__'

/** 卖点/风格选择「本次不使用」的特殊值 */
export const NO_PRESET = '__none__'

/** 卖点 / 风格预设：挂在产品节点下，同产品所有方向共享 */
export interface SopPreset {
  id: string
  productId: string
  kind: 'point' | 'style'
  name: string
  content: string
  updatedAt: number
}

export interface SopPick {
  pointId?: string
  styleId?: string
  /** 系统提示词（按方向存） */
  promptId?: string
}

/** 提示词库弹窗的三个分组，也用作 tab 的 key */
export type SopLibraryTab = 'prompt' | 'point' | 'style'

/** 三个分组的展示名，输入框按钮、tab、空状态文案共用 */
export const SOP_LIBRARY_LABEL: Record<SopLibraryTab, string> = {
  prompt: '系统提示词',
  point: '卖点',
  style: '风格',
}

interface SopState {
  /** SOP 模式开关，挂在输入框「更多」旁边 */
  sopMode: boolean
  directions: SopDirectionNode[]
  systemPrompts: SopSystemPrompt[]
  /** 后台队列进度，null 表示空闲 */
  progress: { queued: number; running: number; done: number; total: number; label: string } | null
  /** 侧栏当前选中的方向 */
  activeDirectionId: string
  /** 左侧栏筛选节点，null 表示看全部；可以是类目 / 产品 / 方向任意一层 */
  activeFilterId: string | null
  /** 左侧栏是否收起 */
  sidebarCollapsed: boolean
  presets: SopPreset[]
  /** 每个方向上次用过的卖点/风格，打开时自动带出 */
  lastPick: Record<string, SopPick>
  /** 用户右键指定的默认项，优先级高于上次记录 */
  defaultPick: Record<string, SopPick>
  /** 生成时忽略参考图上的 logo、合规说明、风险提示，默认开启 */
  ignoreCompliance: boolean
  /** 生成时使用参考图上的卖点文案，默认关闭，卖点以上方选择器为准 */
  useImageSellingPoints: boolean
  /** 避免按钮、悬浮球这类仿系统界面的可点击设计，默认开启 */
  avoidCtaDesign: boolean
  /** 每张任务卡生成几条提示词（=几张图），SOP 模式下唯一的数量来源 */
  promptsPerGroup: number
  /** 生成提示词时自动避让后处理预留区（Logo / 警示语），默认开启 */
  avoidOverlay: boolean
  /** 按产品存的后处理模板，同一产品可以有多套（按比例匹配） */
  postTemplates: Record<string, PostTemplate[]>
  /** 提示词库弹窗当前打开的分组，null 表示关闭。运行时状态，不落盘 */
  libraryTab: SopLibraryTab | null
  setLibraryTab: (tab: SopLibraryTab | null) => void
  setPromptsPerGroup: (value: number) => void
  setPostTemplates: (productId: string, templates: PostTemplate[]) => void
  setSopMode: (value: boolean) => void
  setIgnoreCompliance: (value: boolean) => void
  setUseImageSellingPoints: (value: boolean) => void
  setAvoidCtaDesign: (value: boolean) => void
  setAvoidOverlay: (value: boolean) => void
  setProgress: (value: SopState['progress']) => void
  setActiveDirection: (id: string) => void
  setActiveFilter: (id: string | null) => void
  setSidebarCollapsed: (value: boolean) => void
  addPreset: (productId: string, kind: SopPreset['kind'], name: string, content: string) => string
  updatePreset: (id: string, patch: Partial<Pick<SopPreset, 'name' | 'content'>>) => void
  removePreset: (id: string) => void
  setPick: (directionId: string, pick: SopPick) => void
  setDefaultPick: (directionId: string, pick: SopPick) => void
  addNode: (parentId: string | null, name: string, kind: SopDirectionNode['kind']) => string
  removeNode: (id: string) => void
  addSystemPrompt: (productId: string, name: string, content: string) => string
  updateSystemPrompt: (id: string, patch: Partial<Pick<SopSystemPrompt, 'name' | 'content'>>) => void
  removeSystemPrompt: (id: string) => void
}

export const useSopStore = create<SopState>()(
  persist(
    (set) => ({
      sopMode: false,
      directions: SEED_DIRECTIONS,
      systemPrompts: [],
      progress: null,
      activeDirectionId: 'dir-million-moon',
      activeFilterId: null,
      sidebarCollapsed: false,
      presets: [],
      lastPick: {},
      defaultPick: {},
      ignoreCompliance: true,
      useImageSellingPoints: false,
      avoidCtaDesign: true,
      promptsPerGroup: 5,
      avoidOverlay: true,
      postTemplates: {},
      libraryTab: null,
      setLibraryTab: (tab) => set({ libraryTab: tab }),
      setSopMode: (value) => set({ sopMode: value }),
      setPromptsPerGroup: (value) => set({ promptsPerGroup: Math.max(1, Math.min(30, Math.round(value) || 1)) }),
      setPostTemplates: (productId, templates) => set((state) => ({
        postTemplates: { ...state.postTemplates, [productId]: templates },
      })),
      setIgnoreCompliance: (value) => set({ ignoreCompliance: value }),
      setUseImageSellingPoints: (value) => set({ useImageSellingPoints: value }),
      setAvoidCtaDesign: (value) => set({ avoidCtaDesign: value }),
      setAvoidOverlay: (value) => set({ avoidOverlay: value }),
      setProgress: (value) => set({ progress: value }),
      setActiveDirection: (id) => set({ activeDirectionId: id }),
      setActiveFilter: (id) => set((state) => ({
        activeFilterId: id,
        // 选到方向时同步弹窗默认方向
        activeDirectionId: id && state.directions.find((node) => node.id === id)?.kind === 'direction' ? id : state.activeDirectionId,
      })),
      setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
      addPreset: (productId, kind, name, content) => {
        const id = newId(`preset-${kind}`)
        set((state) => ({
          presets: [...state.presets, { id, productId, kind, name, content, updatedAt: Date.now() }],
        }))
        return id
      },
      updatePreset: (id, patch) => {
        set((state) => ({
          presets: state.presets.map((item) => (
            item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item
          )),
        }))
      },
      removePreset: (id) => {
        set((state) => ({
          presets: state.presets.filter((item) => item.id !== id),
          lastPick: Object.fromEntries(Object.entries(state.lastPick).map(([key, pick]) => [
            key,
            { pointId: pick.pointId === id ? undefined : pick.pointId, styleId: pick.styleId === id ? undefined : pick.styleId },
          ])),
        }))
      },
      setPick: (directionId, pick) => {
        set((state) => ({ lastPick: { ...state.lastPick, [directionId]: pick } }))
      },
      setDefaultPick: (directionId, pick) => {
        set((state) => ({ defaultPick: { ...state.defaultPick, [directionId]: pick } }))
      },
      addNode: (parentId, name, kind) => {
        const id = newId(kind)
        set((state) => ({ directions: [...state.directions, { id, parentId, name, kind }] }))
        return id
      },
      removeNode: (id) => {
        set((state) => {
          // 连同子孙节点和挂在下面的系统提示词一起删掉
          const doomed = new Set([id])
          let grew = true
          while (grew) {
            grew = false
            for (const node of state.directions) {
              if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
                doomed.add(node.id)
                grew = true
              }
            }
          }
          return {
            directions: state.directions.filter((node) => !doomed.has(node.id)),
            // 系统提示词挂在产品上：删方向不动它，删产品/类目才跟着清
            systemPrompts: state.systemPrompts.filter((item) => !doomed.has(item.productId)),
          }
        })
      },
      addSystemPrompt: (productId, name, content) => {
        const id = newId('sys')
        set((state) => ({
          systemPrompts: [...state.systemPrompts, { id, productId, name, content, updatedAt: Date.now() }],
        }))
        return id
      },
      updateSystemPrompt: (id, patch) => {
        set((state) => ({
          systemPrompts: state.systemPrompts.map((item) =>
            item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
          ),
        }))
      },
      removeSystemPrompt: (id) => {
        set((state) => ({ systemPrompts: state.systemPrompts.filter((item) => item.id !== id) }))
      },
    }),
    {
      name: 'gpt-image-sop-store',
      // v2：系统提示词改产品级；v3：后处理模板改为「一个产品多套」；v4：字号改 px 并加描边
      version: 4,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<SopState>

        // v2：系统提示词补齐 productId
        if (version < 2 && state.systemPrompts?.length) {
          const byId = new Map((state.directions ?? []).map((node) => [node.id, node]))
          state.systemPrompts = state.systemPrompts
            .map((item) => {
              if (item.productId) return item
              const node = item.directionId ? byId.get(item.directionId) : undefined
              const productId = node?.kind === 'direction' ? node.parentId ?? '' : node?.id ?? ''
              return { ...item, productId }
            })
            .filter((item) => Boolean(item.productId))
        }

        // v3：单模板对象 → 模板数组
        if (version < 3 && state.postTemplates) {
          const normalized: Record<string, PostTemplate[]> = {}
          const raw = state.postTemplates as unknown as Record<string, PostTemplate | PostTemplate[]>
          for (const [productId, value] of Object.entries(raw)) {
            normalized[productId] = Array.isArray(value)
              ? value
              : [{ ...value, id: value.id ?? `tpl-${productId}`, label: value.label ?? '默认模板', isDefault: true }]
          }
          state.postTemplates = normalized
        }

        // v4：字号从「占画布宽度的比例」改成 px，并补上描边字段
        if (version < 4 && state.postTemplates) {
          const upgraded: Record<string, PostTemplate[]> = {}
          for (const [productId, list] of Object.entries(state.postTemplates)) {
            upgraded[productId] = list.map((tpl) => ({
              ...tpl,
              elements: (tpl.elements ?? []).map((element) => ({
                ...element,
                strokeColor: element.strokeColor ?? '#ffffff',
                strokeWidth: typeof element.strokeWidth === 'number' ? element.strokeWidth : 0,
                fontSize: element.fontSize < 1
                  ? Math.max(8, Math.round(element.fontSize * tpl.width))
                  : element.fontSize,
              })),
            }))
          }
          state.postTemplates = upgraded
        }

        return state as SopState
      },
      // 进度是运行时状态，不落盘
      partialize: (state) => ({ sopMode: state.sopMode, directions: state.directions, systemPrompts: state.systemPrompts, activeDirectionId: state.activeDirectionId, activeFilterId: state.activeFilterId, sidebarCollapsed: state.sidebarCollapsed, presets: state.presets, lastPick: state.lastPick, defaultPick: state.defaultPick, ignoreCompliance: state.ignoreCompliance, useImageSellingPoints: state.useImageSellingPoints, avoidCtaDesign: state.avoidCtaDesign, promptsPerGroup: state.promptsPerGroup, avoidOverlay: state.avoidOverlay, postTemplates: state.postTemplates }),
    },
  ),
)

/** 备份里的提示词库：方向树、系统提示词、卖点、风格、后处理模板 */
export interface SopLibraryExport {
  directions: SopDirectionNode[]
  systemPrompts: SopSystemPrompt[]
  presets: SopPreset[]
  postTemplates: Record<string, PostTemplate[]>
  lastPick: Record<string, SopPick>
  defaultPick: Record<string, SopPick>
  ignoreCompliance?: boolean
  useImageSellingPoints?: boolean
  avoidCtaDesign?: boolean
  promptsPerGroup?: number
  avoidOverlay?: boolean
}

/** 导出用：把提示词库整份取出来，不含运行时状态 */
export function collectSopLibrary(): SopLibraryExport {
  const state = useSopStore.getState()
  return {
    directions: state.directions,
    systemPrompts: state.systemPrompts,
    presets: state.presets,
    postTemplates: state.postTemplates,
    lastPick: state.lastPick,
    defaultPick: state.defaultPick,
    ignoreCompliance: state.ignoreCompliance,
    useImageSellingPoints: state.useImageSellingPoints,
    avoidCtaDesign: state.avoidCtaDesign,
    promptsPerGroup: state.promptsPerGroup,
    avoidOverlay: state.avoidOverlay,
  }
}

/** 按 id 合并：导入的同 id 覆盖本地，没见过的补进来 */
function mergeById<T extends { id: string }>(current: T[], incoming?: T[]): T[] {
  if (!incoming?.length) return current
  const map = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    if (!item?.id) continue
    map.set(item.id, item)
  }
  return [...map.values()]
}

/**
 * 导入备份里的提示词库。
 * 用合并而不是覆盖：换设备导入时本地空、等于全量恢复；
 * 两边都有内容时也不会把本地新建的提示词冲掉。
 */
export function mergeSopLibrary(library?: SopLibraryExport | null) {
  if (!library) return
  useSopStore.setState((state) => {
    const postTemplates = { ...state.postTemplates }
    for (const [productId, templates] of Object.entries(library.postTemplates ?? {})) {
      if (!productId || !Array.isArray(templates)) continue
      postTemplates[productId] = mergeById(postTemplates[productId] ?? [], templates)
    }
    return {
      directions: mergeById(state.directions, library.directions),
      systemPrompts: mergeById(state.systemPrompts, library.systemPrompts),
      presets: mergeById(state.presets, library.presets),
      postTemplates,
      lastPick: { ...state.lastPick, ...(library.lastPick ?? {}) },
      defaultPick: { ...state.defaultPick, ...(library.defaultPick ?? {}) },
      ignoreCompliance: library.ignoreCompliance ?? state.ignoreCompliance,
      useImageSellingPoints: library.useImageSellingPoints ?? state.useImageSellingPoints,
      avoidCtaDesign: library.avoidCtaDesign ?? state.avoidCtaDesign,
      promptsPerGroup: typeof library.promptsPerGroup === 'number' ? library.promptsPerGroup : state.promptsPerGroup,
      avoidOverlay: library.avoidOverlay ?? state.avoidOverlay,
    }
  })
}

/** 取某个方向的完整路径，例如「保险 / 百万医疗险 / 月亮」 */
export function directionPath(nodes: SopDirectionNode[], id: string): string {
  const names: string[] = []
  let cursor = nodes.find((node) => node.id === id)
  while (cursor) {
    names.unshift(cursor.name)
    const parentId = cursor.parentId
    cursor = parentId ? nodes.find((node) => node.id === parentId) : undefined
  }
  return names.join(' / ')
}

/** 收集某个节点及其全部子孙的 id，用于按层级筛选任务 */
export function collectSubtreeIds(nodes: SopDirectionNode[], rootId: string): Set<string> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        grew = true
      }
    }
  }
  return ids
}
