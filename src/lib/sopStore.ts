import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SopDirectionNode, SopSystemPrompt, VariablePrompt } from '../types'
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
  /** 变量模式：变量提示词（按方向存），与系统提示词并行互不影响 */
  variablePromptId?: string
}

/** 提示词库弹窗的分组，也用作 tab 的 key */
export type SopLibraryTab = 'prompt' | 'variable' | 'point' | 'style'

/** 各分组的展示名，输入框按钮、tab、空状态文案共用 */
export const SOP_LIBRARY_LABEL: Record<SopLibraryTab, string> = {
  prompt: '系统提示词',
  variable: '变量提示词',
  point: '卖点',
  style: '风格',
}

interface SopState {
  /** SOP 模式开关，挂在输入框「更多」旁边 */
  sopMode: boolean
  /** 变量模式开关：与 sopMode 互斥，同一时刻只能开一个 */
  variableMode: boolean
  directions: SopDirectionNode[]
  systemPrompts: SopSystemPrompt[]
  /** 变量提示词库：与系统提示词并行的一套，只描述提取策略 */
  variablePrompts: VariablePrompt[]
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
  /** 变量模式：每张卡最多产出几条提示词，实际条数受组合池容量限制 */
  variablesPerCard: number
  /** 生成提示词时自动避让后处理预留区（Logo / 警示语），默认开启 */
  avoidOverlay: boolean
  /** 按产品存的后处理模板，同一产品可以有多套（按比例匹配） */
  postTemplates: Record<string, PostTemplate[]>
  /** 提示词库弹窗当前打开的分组，null 表示关闭。运行时状态，不落盘 */
  libraryTab: SopLibraryTab | null
  /** 回收站弹窗是否打开。运行时状态，不落盘 */
  trashOpen: boolean
  setTrashOpen: (value: boolean) => void
  /** 有值表示该节点已进回收站；全量节点含已删除的，界面只渲染未删除的 */
  activeNodes: () => SopDirectionNode[]
  trashedNodes: () => SopDirectionNode[]
  setLibraryTab: (tab: SopLibraryTab | null) => void
  setPromptsPerGroup: (value: number) => void
  setVariablesPerCard: (value: number) => void
  setPostTemplates: (productId: string, templates: PostTemplate[]) => void
  setSopMode: (value: boolean) => void
  setVariableMode: (value: boolean) => void
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
  /**
   * 伪删除：连同全部子孙进回收站。
   * 传入 batchId 可与任务卡回收站共用一个批次，便于「恢复方向时任务卡一起回来」；
   * 不传则自动生成。
   */
  trashNode: (id: string, batchId?: string) => string
  /** 移动节点到新的父级；不合法时返回错误文案 */
  moveNode: (id: string, parentId: string | null) => string
  /** 重命名 */
  renameNode: (id: string, name: string) => void
  /** 按批次恢复 */
  restoreTrashBatch: (batchId: string) => void
  /** 按批次永久删除（连提示词预设一起清） */
  purgeTrashBatch: (batchId: string) => void
  /** 清空回收站里的全部节点 */
  purgeAllTrash: () => void
  removeNode: (id: string) => void
  addSystemPrompt: (productId: string, name: string, content: string) => string
  updateSystemPrompt: (id: string, patch: Partial<Pick<SopSystemPrompt, 'name' | 'content'>>) => void
  removeSystemPrompt: (id: string) => void
  addVariablePrompt: (productId: string, name: string, content: string) => string
  updateVariablePrompt: (id: string, patch: Partial<Pick<VariablePrompt, 'name' | 'content'>>) => void
  removeVariablePrompt: (id: string) => void
}

export const useSopStore = create<SopState>()(
  persist(
    (set, get) => ({
      sopMode: false,
      variableMode: false,
      directions: SEED_DIRECTIONS,
      systemPrompts: [],
      variablePrompts: [],
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
      variablesPerCard: 5,
      avoidOverlay: true,
      postTemplates: {},
      libraryTab: null,
      trashOpen: false,
      setTrashOpen: (value) => set({ trashOpen: value }),
      setLibraryTab: (tab) => set({ libraryTab: tab }),
      // 两个模式互斥：开一个就把另一个关掉，避免提交时走错分支
      setSopMode: (value) => set({ sopMode: value, variableMode: false }),
      setVariableMode: (value) => set({ variableMode: value, sopMode: false }),
      setPromptsPerGroup: (value) => set({ promptsPerGroup: Math.max(1, Math.min(30, Math.round(value) || 1)) }),
      setVariablesPerCard: (value) => set({ variablesPerCard: Math.max(1, Math.min(30, Math.round(value) || 1)) }),
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
      trashNode: (id, batchId) => {
        const finalBatchId = batchId ?? `trash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        set((state) => {
          // 连子孙一起进回收站：整棵子树共用同一个 batchId，恢复时一起回来
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
          const deletedAt = Date.now()
          return {
            directions: state.directions.map((node) => (
              doomed.has(node.id) && !node.deletedAt
                ? { ...node, deletedAt, trashBatchId: finalBatchId, trashParentId: node.parentId }
                : node
            )),
            // 正在用的归属/筛选被删掉时，退回「全部」，否则界面会指向一个不存在的节点
            activeFilterId: state.activeFilterId && doomed.has(state.activeFilterId) ? null : state.activeFilterId,
            activeDirectionId: doomed.has(state.activeDirectionId)
              ? state.directions.find((node) => node.kind === 'direction' && !node.deletedAt && !doomed.has(node.id))?.id
                ?? state.activeDirectionId
              : state.activeDirectionId,
          }
        })
        return finalBatchId
      },
      moveNode: (id, parentId) => {
        const state = get()
        const node = state.directions.find((item) => item.id === id)
        if (!node) return '找不到这个节点'
        if (parentId === id) return '不能移动到自身下面'
        const target = parentId ? state.directions.find((item) => item.id === parentId) : null
        if (parentId && (!target || target.deletedAt)) return '目标节点不存在'

        // 严格三级：类目挂顶层、产品挂类目、方向挂产品
        const expectedParentKind = node.kind === 'category' ? null : node.kind === 'product' ? 'category' : 'product'
        if (expectedParentKind === null && target) return '类目只能放在最顶层'
        if (expectedParentKind && target?.kind !== expectedParentKind) {
          return node.kind === 'product' ? '产品只能放在类目下' : '方向只能放在产品下'
        }

        // 不能挂到自己的子孙下面，否则子树会脱离整棵树
        let cursor = target
        while (cursor) {
          if (cursor.id === id) return '不能移动到自身的子节点下'
          const pid: string | null = cursor.parentId
          cursor = pid ? state.directions.find((item) => item.id === pid) : null
        }
        if (node.parentId === parentId) return ''

        set((prev) => ({
          directions: prev.directions.map((item) => (item.id === id ? { ...item, parentId } : item)),
        }))
        return ''
      },
      renameNode: (id, name) => {
        const trimmed = name.trim()
        if (!trimmed) return
        set((state) => ({
          directions: state.directions.map((node) => (node.id === id ? { ...node, name: trimmed } : node)),
        }))
      },
      restoreTrashBatch: (batchId) => {
        set((state) => {
          // 同一批里的节点会一起恢复，所以「父级可用」要把本批也算进去，
          // 否则父级也在这批里时会被误判成已被彻底删掉，子节点被挂到顶层
          const batchIds = new Set(
            state.directions.filter((node) => node.trashBatchId === batchId).map((node) => node.id),
          )
          const alive = new Set(
            state.directions
              .filter((node) => !node.deletedAt || batchIds.has(node.id))
              .map((node) => node.id),
          )
          return {
            directions: state.directions.map((node) => {
              if (node.trashBatchId !== batchId) return node
              // 原父级已被彻底删掉时，退回顶层，避免恢复出一棵挂不上的子树
              const parentOk = !node.trashParentId || alive.has(node.trashParentId)
              return {
                ...node,
                parentId: parentOk ? (node.trashParentId ?? null) : null,
                deletedAt: undefined,
                trashBatchId: undefined,
                trashParentId: undefined,
              }
            }),
          }
        })
      },
      purgeTrashBatch: (batchId) => {
        set((state) => {
          const doomed = new Set(
            state.directions.filter((node) => node.trashBatchId === batchId).map((node) => node.id),
          )
          return {
            directions: state.directions.filter((node) => !doomed.has(node.id)),
            // 提示词与模板挂在产品上，真正删除时才跟着清
            systemPrompts: state.systemPrompts.filter((item) => !doomed.has(item.productId)),
            variablePrompts: state.variablePrompts.filter((item) => !doomed.has(item.productId)),
          }
        })
      },
      purgeAllTrash: () => {
        set((state) => {
          const doomed = new Set(state.directions.filter((node) => node.deletedAt).map((node) => node.id))
          return {
            directions: state.directions.filter((node) => !node.deletedAt),
            systemPrompts: state.systemPrompts.filter((item) => !doomed.has(item.productId)),
            variablePrompts: state.variablePrompts.filter((item) => !doomed.has(item.productId)),
          }
        })
      },
      // 兼容旧调用：现在一律走伪删除，不再物理删
      removeNode: (id) => {
        get().trashNode(id)
      },
      activeNodes: () => get().directions.filter((node) => !node.deletedAt),
      trashedNodes: () => get().directions.filter((node) => Boolean(node.deletedAt)),
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
      addVariablePrompt: (productId, name, content) => {
        const id = newId('var')
        set((state) => ({
          variablePrompts: [...state.variablePrompts, { id, productId, name, content, updatedAt: Date.now() }],
        }))
        return id
      },
      updateVariablePrompt: (id, patch) => {
        set((state) => ({
          variablePrompts: state.variablePrompts.map((item) =>
            item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
          ),
        }))
      },
      removeVariablePrompt: (id) => {
        set((state) => ({ variablePrompts: state.variablePrompts.filter((item) => item.id !== id) }))
      },
    }),
    {
      name: 'gpt-image-sop-store',
      // v2：系统提示词改产品级；v3：后处理模板改为「一个产品多套」；v4：字号改 px 并加描边；v5：变量提示词库；v6：节点伪删除
      version: 6,
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
      partialize: (state) => ({ sopMode: state.sopMode, variableMode: state.variableMode, directions: state.directions, systemPrompts: state.systemPrompts, variablePrompts: state.variablePrompts, activeDirectionId: state.activeDirectionId, activeFilterId: state.activeFilterId, sidebarCollapsed: state.sidebarCollapsed, presets: state.presets, lastPick: state.lastPick, defaultPick: state.defaultPick, ignoreCompliance: state.ignoreCompliance, useImageSellingPoints: state.useImageSellingPoints, avoidCtaDesign: state.avoidCtaDesign, promptsPerGroup: state.promptsPerGroup, variablesPerCard: state.variablesPerCard, avoidOverlay: state.avoidOverlay, postTemplates: state.postTemplates }),
    },
  ),
)

/** 备份里的提示词库：方向树、系统提示词、变量提示词、卖点、风格、后处理模板 */
export interface SopLibraryExport {
  directions: SopDirectionNode[]
  systemPrompts: SopSystemPrompt[]
  variablePrompts?: VariablePrompt[]
  presets: SopPreset[]
  postTemplates: Record<string, PostTemplate[]>
  lastPick: Record<string, SopPick>
  defaultPick: Record<string, SopPick>
  ignoreCompliance?: boolean
  useImageSellingPoints?: boolean
  avoidCtaDesign?: boolean
  promptsPerGroup?: number
  variablesPerCard?: number
  avoidOverlay?: boolean
}

/** 导出用：把提示词库整份取出来，不含运行时状态 */
export function collectSopLibrary(): SopLibraryExport {
  const state = useSopStore.getState()
  return {
    directions: state.directions,
    systemPrompts: state.systemPrompts,
    variablePrompts: state.variablePrompts,
    presets: state.presets,
    postTemplates: state.postTemplates,
    lastPick: state.lastPick,
    defaultPick: state.defaultPick,
    ignoreCompliance: state.ignoreCompliance,
    useImageSellingPoints: state.useImageSellingPoints,
    avoidCtaDesign: state.avoidCtaDesign,
    promptsPerGroup: state.promptsPerGroup,
    variablesPerCard: state.variablesPerCard,
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
      variablePrompts: mergeById(state.variablePrompts, library.variablePrompts),
      presets: mergeById(state.presets, library.presets),
      postTemplates,
      lastPick: { ...state.lastPick, ...(library.lastPick ?? {}) },
      defaultPick: { ...state.defaultPick, ...(library.defaultPick ?? {}) },
      ignoreCompliance: library.ignoreCompliance ?? state.ignoreCompliance,
      useImageSellingPoints: library.useImageSellingPoints ?? state.useImageSellingPoints,
      avoidCtaDesign: library.avoidCtaDesign ?? state.avoidCtaDesign,
      promptsPerGroup: typeof library.promptsPerGroup === 'number' ? library.promptsPerGroup : state.promptsPerGroup,
      variablesPerCard: typeof library.variablesPerCard === 'number' ? library.variablesPerCard : state.variablesPerCard,
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
