import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SopDirectionNode, SopSystemPrompt } from '../types'

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
  setSopMode: (value: boolean) => void
  setIgnoreCompliance: (value: boolean) => void
  setUseImageSellingPoints: (value: boolean) => void
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
  addSystemPrompt: (directionId: string, name: string, content: string) => string
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
      setSopMode: (value) => set({ sopMode: value }),
      setIgnoreCompliance: (value) => set({ ignoreCompliance: value }),
      setUseImageSellingPoints: (value) => set({ useImageSellingPoints: value }),
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
            systemPrompts: state.systemPrompts.filter((item) => !doomed.has(item.directionId)),
          }
        })
      },
      addSystemPrompt: (directionId, name, content) => {
        const id = newId('sys')
        set((state) => ({
          systemPrompts: [...state.systemPrompts, { id, directionId, name, content, updatedAt: Date.now() }],
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
      // 进度是运行时状态，不落盘
      partialize: (state) => ({ sopMode: state.sopMode, directions: state.directions, systemPrompts: state.systemPrompts, activeDirectionId: state.activeDirectionId, activeFilterId: state.activeFilterId, sidebarCollapsed: state.sidebarCollapsed, presets: state.presets, lastPick: state.lastPick, defaultPick: state.defaultPick, ignoreCompliance: state.ignoreCompliance, useImageSellingPoints: state.useImageSellingPoints }),
    },
  ),
)

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
