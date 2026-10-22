import type { SopDirectionNode, TaskRecord } from '../types'

/**
 * 导出/导入时按「业务 - 产品 - 方向」选择范围。
 *
 * 选中一个节点等于选中它整棵子树：勾了产品就该带上它下面所有方向，
 * 这和侧栏点击产品筛选任务的口径一致。
 */
export type DirectionScope =
  | { all: true }
  /** ids 只写用户实际点过的节点；子树展开在过滤时算 */
  | { all: false; ids: string[]; includeUnassigned: boolean }

/** 「未归属」在范围里的特殊标记，与 sopStore 的筛选项不是同一个值 */
export const SCOPE_UNASSIGNED = '__scope_unassigned__'

export const ALL_SCOPE: DirectionScope = { all: true }

export interface ScopeRow {
  id: string
  name: string
  depth: number
  kind: SopDirectionNode['kind']
  /** 主干上是否还有子节点，决定要不要画折叠箭头 */
  hasChildren: boolean
}

/** 任务卡标识：同一条 SOP 展开的多个任务只算一张卡 */
export function cardKeyOf(task: Pick<TaskRecord, 'id' | 'sopJobId'>) {
  return task.sopJobId ?? task.id
}

/**
 * 按层级顺序摊平业务树，供勾选列表渲染。
 * 已进回收站的节点不出现；父级不存在的脏数据当根节点处理，避免整枝消失。
 */
export function buildScopeRows(nodes: SopDirectionNode[]): ScopeRow[] {
  const alive = nodes.filter((node) => !node.deletedAt)
  const aliveIds = new Set(alive.map((node) => node.id))
  const childrenOf = new Map<string, SopDirectionNode[]>()
  const roots: SopDirectionNode[] = []
  for (const node of alive) {
    if (node.parentId && aliveIds.has(node.parentId)) {
      const list = childrenOf.get(node.parentId) ?? []
      list.push(node)
      childrenOf.set(node.parentId, list)
      continue
    }
    roots.push(node)
  }

  const rows: ScopeRow[] = []
  const walk = (node: SopDirectionNode, depth: number) => {
    const children = childrenOf.get(node.id) ?? []
    rows.push({ id: node.id, name: node.name, depth, kind: node.kind, hasChildren: children.length > 0 })
    for (const child of children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return rows
}

/** 选中节点 + 其全部子孙 */
export function scopeNodeIds(nodes: SopDirectionNode[], ids: Iterable<string>): Set<string> {
  const picked = new Set(ids)
  if (!picked.size) return picked
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const result = new Set(picked)
  let grew = true
  while (grew) {
    grew = false
    for (const node of nodes) {
      if (!node.parentId || result.has(node.id)) continue
      if (result.has(node.parentId) && byId.has(node.parentId)) {
        result.add(node.id)
        grew = true
      }
    }
  }
  return result
}

function isUnassigned(task: TaskRecord, nodes: SopDirectionNode[], aliveIds: Set<string>) {
  const id = task.sopDirectionId
  if (!id) return true
  if (!aliveIds.has(id)) return true
  return !nodes.some((node) => node.id === id)
}

/**
 * 任务是否落在选定范围内。
 * 方向被删或从未归属的卡片只在勾了「未归属」时导出，避免整理时把它们悄悄带出去。
 */
export function taskMatchesScope(task: TaskRecord, nodes: SopDirectionNode[], scope: DirectionScope): boolean {
  if (scope.all) return true
  const alive = nodes.filter((node) => !node.deletedAt)
  const unassigned = isUnassigned(task, alive, new Set(alive.map((node) => node.id)))
  if (unassigned) return scope.includeUnassigned
  const allowed = scopeNodeIds(alive, scope.ids)
  return Boolean(task.sopDirectionId && allowed.has(task.sopDirectionId))
}

export function filterTasksByScope(tasks: TaskRecord[], nodes: SopDirectionNode[], scope: DirectionScope): TaskRecord[] {
  if (scope.all) return tasks
  return tasks.filter((task) => taskMatchesScope(task, nodes, scope))
}

export interface ScopeCounts {
  /** 每张任务卡直接挂在哪：nodeId 或未归属 */
  byNode: Record<string, number>
  unassigned: number
  total: number
}

/** 统计每个节点自己的任务卡数（不含子树），渲染时由上层累加 */
export function countCardsByNode(tasks: TaskRecord[], nodes: SopDirectionNode[]): ScopeCounts {
  const alive = nodes.filter((node) => !node.deletedAt)
  const aliveIds = new Set(alive.map((node) => node.id))
  const seen = new Set<string>()
  const counts: ScopeCounts = { byNode: {}, unassigned: 0, total: 0 }
  for (const task of tasks) {
    const key = cardKeyOf(task)
    if (seen.has(key)) continue
    seen.add(key)
    counts.total += 1
    if (isUnassigned(task, alive, aliveIds)) {
      counts.unassigned += 1
      continue
    }
    const id = task.sopDirectionId as string
    counts.byNode[id] = (counts.byNode[id] ?? 0) + 1
  }
  return counts
}

/** 节点连同子树的卡数，树里每个节点显示这个数 */
export function subtreeCardCounts(nodes: SopDirectionNode[], counts: ScopeCounts): Record<string, number> {
  const alive = nodes.filter((node) => !node.deletedAt)
  const childrenOf = new Map<string, string[]>()
  for (const node of alive) {
    if (!node.parentId) continue
    const list = childrenOf.get(node.parentId) ?? []
    list.push(node.id)
    childrenOf.set(node.parentId, list)
  }
  const result: Record<string, number> = {}
  const sum = (id: string): number => {
    if (result[id] != null) return result[id]
    let total = counts.byNode[id] ?? 0
    for (const childId of childrenOf.get(id) ?? []) total += sum(childId)
    result[id] = total
    return total
  }
  for (const node of alive) sum(node.id)
  return result
}

/** 勾选状态：全选 / 部分（子节点有但没勾满）/ 未勾 */
export type CheckState = 'all' | 'some' | 'none'

export function nodeCheckState(nodes: SopDirectionNode[], selected: Iterable<string>, nodeId: string): CheckState {
  const alive = nodes.filter((node) => !node.deletedAt)
  const picked = new Set(selected)
  const ids = scopeNodeIds(alive, [nodeId])
  if (!ids.size) return 'none'
  let hit = 0
  for (const id of ids) if (picked.has(id)) hit += 1
  if (hit === 0) return 'none'
  if (hit === ids.size) return 'all'
  return 'some'
}

/**
 * 点一个节点：勾满时取消整枝，否则补齐整枝。
 * 补齐而不是只勾自己，用户看到的勾选状态才和「导出内容」一致。
 */
export function toggleScopeNode(nodes: SopDirectionNode[], selected: Iterable<string>, nodeId: string): string[] {
  const alive = nodes.filter((node) => !node.deletedAt)
  const picked = new Set(selected)
  const ids = scopeNodeIds(alive, [nodeId])
  if (nodeCheckState(alive, picked, nodeId) === 'all') {
    for (const id of ids) picked.delete(id)
    return [...picked]
  }
  for (const id of ids) picked.add(id)
  return [...picked]
}

/** 从备份或本地节点里取出这类节点的展示名，用于摘要文案 */
export function scopeSummary(nodes: SopDirectionNode[], scope: DirectionScope): string {
  if (scope.all) return '全部业务方向'
  const alive = nodes.filter((node) => !node.deletedAt)
  const picked = scopeNodeIds(alive, scope.ids)
  const byId = new Map(alive.map((node) => [node.id, node]))
  // 计数时只算勾选节点里最靠上的那些，否则产品 + 方向会被算成两个
  const topLevel = [...picked].filter((id) => {
    const node = byId.get(id)
    if (!node?.parentId) return true
    return !picked.has(node.parentId)
  })
  const parts = topLevel.map((id) => byId.get(id)?.name).filter(Boolean)
  const suffix = scope.includeUnassigned ? '，含未归属' : ''
  if (!parts.length) return scope.includeUnassigned ? '仅未归属' : '未选择任何方向'
  if (parts.length <= 2) return `${parts.join('、')}${suffix}`
  return `${parts.slice(0, 2).join('、')} 等 ${parts.length} 项${suffix}`
}
