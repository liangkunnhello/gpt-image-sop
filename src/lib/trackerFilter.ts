/**
 * 投放跟踪的筛选逻辑：日期范围 + 产品树（业务线 / 产品 / 方向）。
 *
 * 全部是纯函数，不碰存储也不碰 React —— 时间边界和树归属最容易出错，
 * 单独拿出来测试比在组件里点着验靠谱。
 */
import type { AssetRecord, SpendRecord } from './trackDb'
import type { SopDirectionNode, TaskRecord } from '../types'

/** 未归属任何方向的任务卡，挂在树梢的伪节点上 */
export const UNASSIGNED_NODE_ID = '__unassigned__'

export interface DateRange {
  /** 起始日 YYYY-MM-DD，空串表示不限 */
  from: string
  /** 结束日 YYYY-MM-DD，含当天 */
  to: string
}

export type RangePreset = 'today' | '7d' | '30d' | 'all'

/** 本地时区的今天。用 toISOString 会按 UTC 算，晚上会差一天 */
export function todayString(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 在 YYYY-MM-DD 上加减天数 */
export function shiftDate(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/**
 * 快捷区间。
 *
 * 「近 7 天」含今天：今天是 11-05 时是 10-30 ~ 11-05。
 * 这样和平台后台的「最近 7 天」口径一致，对账时不会差一天。
 */
export function presetRange(preset: RangePreset, today: string = todayString()): DateRange {
  if (preset === 'all') return { from: '', to: '' }
  if (preset === 'today') return { from: today, to: today }
  const days = preset === '7d' ? 6 : 29
  return { from: shiftDate(today, -days), to: today }
}

/** 日期是否落在区间内（两端都含，空值表示不限） */
export function inRange(date: string, range: DateRange): boolean {
  if (range.from && date < range.from) return false
  if (range.to && date > range.to) return false
  return true
}

export function filterSpendByRange(spend: SpendRecord[], range: DateRange): SpendRecord[] {
  if (!range.from && !range.to) return spend
  return spend.filter((record) => inRange(record.date, range))
}

/** 给界面显示的一句话 */
export function rangeLabel(range: DateRange): string {
  if (!range.from && !range.to) return '全部时间'
  if (range.from && range.to && range.from === range.to) return range.from
  return `${range.from || '最早'} ~ ${range.to || '今天'}`
}

/** 产品树节点 */
export interface TreeNode {
  id: string
  name: string
  kind: 'category' | 'product' | 'direction' | 'unassigned'
  children: TreeNode[]
  /** 该节点（含所有子孙方向）挂着的任务卡数 */
  taskCount: number
}

/**
 * 从方向节点表 + 任务卡建三层树。
 *
 * 只统计「真的挂在这个方向上」的卡：`sopDirectionId` 指向已删除节点的卡，
 * 会落到「未归属」里 —— 否则用户会看到一批算不进任何筛选的隐形卡。
 */
export function buildProductTree(
  directions: SopDirectionNode[],
  tasks: TaskRecord[],
  /**
   * 还有多少素材「没有对应的任务卡」（演示数据、任务卡已删的老数据）。
   *
   * 这类素材在树上找不到位置，但又在台账里占着消耗。不算进「未归属」的话，
   * 用户点任何一个方向都会发现「数字对不上」，也无从筛选它们。
   */
  extraUnassigned = 0,
  /**
   * 没有任务卡、但靠 `directionId` 归到某个方向的素材数（方向 id → 数量）。
   *
   * 这些素材不进任务计数，可点进去又能看到它们 —— 不补进节点数字的话，
   * 会出现「方向显示 0，点开有一堆图」的怪现象。
   */
  extraDirectionCounts?: Map<string, number>,
): TreeNode[] {
  const alive = directions.filter((node) => !node.deletedAt)
  const aliveIds = new Set(alive.map((node) => node.id))

  const nodes = new Map<string, TreeNode>()
  for (const node of alive) {
    nodes.set(node.id, { id: node.id, name: node.name, kind: node.kind, children: [], taskCount: 0 })
  }

  const roots: TreeNode[] = []
  for (const node of alive) {
    const self = nodes.get(node.id)
    if (!self) continue
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(self)
    else roots.push(self)
  }

  // 任务卡挂到所属方向上
  let unassigned = 0
  for (const task of tasks) {
    const dirId = task.sopDirectionId
    const node = dirId && aliveIds.has(dirId) ? nodes.get(dirId) : undefined
    if (!node) {
      unassigned += 1
      continue
    }
    node.taskCount += 1
  }

  // 外部素材补进所属方向的计数（它们没有任务卡，靠 directionId 归属）
  if (extraDirectionCounts) {
    for (const [directionId, count] of extraDirectionCounts) {
      const node = nodes.get(directionId)
      if (node) node.taskCount += count
    }
  }

  // 自底向上汇总：父节点的计数要含子孙，否则筛选「产品」时会看到 0
  const sumUp = (node: TreeNode): number => {
    let total = node.kind === 'direction' ? node.taskCount : 0
    for (const child of node.children) total += sumUp(child)
    node.taskCount = total
    return total
  }
  for (const root of roots) sumUp(root)

  /*
   * 「未归属」放最前而不是最后：演示数据和早期没挂方向的卡全在这里，
   * 排到几十个方向节点之后，用户根本翻不到，第一次打开会以为「筛什么都没数据」。
   */
  const totalUnassigned = unassigned + Math.max(0, extraUnassigned)
  if (totalUnassigned > 0) {
    roots.unshift({ id: UNASSIGNED_NODE_ID, name: '未归属方向', kind: 'unassigned', children: [], taskCount: totalUnassigned })
  }
  return roots
}

/** 按 id 找节点（深度优先） */
export function findTreeNode(roots: TreeNode[], id: string): TreeNode | null {
  const stack = [...roots]
  while (stack.length) {
    const node = stack.pop() as TreeNode
    if (node.id === id) return node
    stack.push(...node.children)
  }
  return null
}

/**
 * 选中某个节点后，能覆盖到的素材。
 *
 * 为什么以**素材**为单位判断归属，而不是先算任务卡再筛素材：
 * 演示数据和早期老数据的 `taskId` 在任务列表里根本不存在，
 * 先按任务卡筛就会把它们整批丢掉 —— 表现为「点了任何方向，台账都空了」。
 * 这类素材没有方向，属于「未归属」。
 *
 * 返回全部素材表示「不限」。
 */
export function scopeAssetsForNode(
  assets: AssetRecord[],
  tasks: TaskRecord[],
  directions: SopDirectionNode[],
  tree: TreeNode[],
  nodeId: string | null,
): AssetRecord[] {
  if (!nodeId) return assets

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const aliveIds = new Set(directions.filter((node) => !node.deletedAt).map((node) => node.id))

  /**
   * 素材所属方向：找不到任务卡 / 没挂方向 / 方向已删，都算没有方向。
   *
   * 优先看任务卡（卡上改方向，归属立刻跟着走）；任务卡没有方向时，
   * 再看素材自己的 `directionId` —— 那是 NAS 接进来的外部素材按分类路径自动归属的，
   * 它们没有任务卡，不认这个字段就永远进不了任何方向。
   */
  const directionOf = (asset: AssetRecord): string | undefined => {
    const task = asset.taskId ? taskById.get(asset.taskId) : undefined
    const fromTask = task?.sopDirectionId
    if (fromTask && aliveIds.has(fromTask)) return fromTask
    const own = asset.directionId
    return own && aliveIds.has(own) ? own : undefined
  }

  if (nodeId === UNASSIGNED_NODE_ID) {
    return assets.filter((asset) => !directionOf(asset))
  }

  const node = findTreeNode(tree, nodeId)
  if (!node) return assets

  // 该节点下所有方向（含子孙）
  const directionIds = new Set<string>()
  const stack: TreeNode[] = [node]
  while (stack.length) {
    const current = stack.pop() as TreeNode
    if (current.kind === 'direction') directionIds.add(current.id)
    stack.push(...current.children)
  }

  return assets.filter((asset) => {
    const dirId = directionOf(asset)
    return Boolean(dirId && directionIds.has(dirId))
  })
}

/**
 * 按筛选后的素材保留流水。
 *
 * 默认把未匹配的流水（`assetId` 为空）一并剔除：素材已被筛掉，
 * 再把这些流水算进合计，就会出现「列表里 0 张图、合计却有 30 万」。
 *
 * `keepUnmatched` 给素材报表用：报表要回答「钱花在哪个素材上」，
 * 认不到本地图的平台素材同样是素材，不能凭空消失 —— 否则导入一批
 * 对不上命名的报表，报表页就是空的。台账和合计仍走默认的严格口径。
 */
export function filterSpendByAssets(
  spend: SpendRecord[],
  assets: AssetRecord[],
  keepUnmatched = false,
): SpendRecord[] {
  const allow = new Set(assets.map((asset) => asset.id))
  return spend.filter((record) => {
    if (!record.assetId) return keepUnmatched
    return allow.has(record.assetId)
  })
}
