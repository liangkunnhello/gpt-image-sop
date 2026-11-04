/**
 * 素材台账：把「任务卡 + 图片」整理成可跟踪的素材记录，并做消耗聚合。
 *
 * 为什么单独一层：
 * - 建档要遍历全部任务卡和图片，逻辑放组件里会跟渲染混在一起；
 * - 聚合（按素材 / 按卡 / 按日）是纯计算，抽出来才好测。
 */
import type { TaskRecord } from '../types'
import type { AssetRecord, AssetStage, SpendRecord } from './trackDb'

/** 判定生命周期用的阈值。写成常量便于以后调 */
export const LIFECYCLE_RULES = {
  /** 冷启动：投放天数不超过这个值 */
  coldDays: 3,
  /** 衰退：最近 N 天的日均消耗对比前 N 天，跌幅超过这个比例 */
  declineDays: 3,
  declineRatio: 0.4,
  /** 停止：距最后一次消耗超过 N 天 */
  staleDays: 7,
}

/**
 * 从任务卡建素材记录。
 *
 * 只收「已出图」的任务：`outputImages` 为空说明这张卡没出成功，没有素材可跟踪。
 * `rootCardId` 取 `sopJobId`（同一张卡内多条任务同属一个血缘根），
 * 没有 `sopJobId` 的单任务卡用它自己。
 */
export function buildAssetsFromTasks(tasks: TaskRecord[]): AssetRecord[] {
  const out = new Map<string, AssetRecord>()
  for (const task of tasks) {
    if (task.deletedAt) continue
    for (const imageId of task.outputImages ?? []) {
      if (!imageId) continue
      const existing = out.get(imageId)
      if (existing) continue
      out.set(imageId, {
        id: imageId,
        taskId: task.id,
        rootCardId: task.sopJobId || task.id,
        platformIds: [],
        reportNames: [],
        createdAt: task.finishedAt ?? task.createdAt,
      })
    }
  }
  return [...out.values()]
}

/**
 * 把已有台账和新扫出来的素材合并。
 *
 * **已有记录里的投放数据不能被清掉** —— 重新建档只是补新图，
 * 平台 ID、最后消耗日这些历史信息必须保留，否则每建一次档就丢一次投放记录。
 */
export function mergeAssets(existing: AssetRecord[], scanned: AssetRecord[]): AssetRecord[] {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const asset of scanned) {
    const old = byId.get(asset.id)
    if (!old) {
      byId.set(asset.id, asset)
      continue
    }
    byId.set(asset.id, {
      ...asset,
      // 这几项只可能来自导入或人工，扫描结果里没有，必须沿用旧的
      platformIds: old.platformIds,
      reportNames: old.reportNames,
      firstSeenAt: old.firstSeenAt,
      lastSpendDate: old.lastSpendDate,
      parentAssetId: old.parentAssetId,
      rootCardId: old.rootCardId ?? asset.rootCardId,
      stageOverride: old.stageOverride,
      note: old.note,
    })
  }
  return [...byId.values()]
}

export interface AssetStats {
  assetId: string
  /** 累计消耗 */
  totalSpend: number
  /** 有消耗的天数 */
  activeDays: number
  firstDate?: string
  lastDate?: string
  /** 最近 7 天消耗，用于看趋势 */
  recentSpend: number
  /** 日均消耗（按有消耗的天数算，避免被没投的天稀释） */
  dailyAverage: number
  stage: AssetStage
}

function dateMinusDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() - days)
  return dt.toISOString().slice(0, 10)
}

/**
 * 判定生命周期阶段。
 *
 * 口径（都是可调的常量，见 LIFECYCLE_RULES）：
 * - 没有任何消耗 → created（已生成，未投放）
 * - 投放不足 coldDays 天 → running（冷启动，数据量不够判断趋势）
 * - 最近 declineDays 天的日均比之前 declineDays 天跌超过 declineRatio → declining
 * - 距最后消耗超过 staleDays 天 → stale（基本可以判定衰退停投）
 * - 其余 → running
 */
export function judgeStage(
  stats: { totalSpend: number; activeDays: number; lastDate?: string },
  records: SpendRecord[],
  today = new Date().toISOString().slice(0, 10),
): AssetStage {
  if (!stats.totalSpend || !stats.lastDate) return 'created'
  const gapDays = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${stats.lastDate}T00:00:00Z`)) / 86400000,
  )
  if (gapDays > LIFECYCLE_RULES.staleDays) return 'stale'
  if (stats.activeDays < LIFECYCLE_RULES.coldDays) return 'running'

  const recentFrom = dateMinusDays(stats.lastDate, LIFECYCLE_RULES.declineDays - 1)
  const prevFrom = dateMinusDays(stats.lastDate, LIFECYCLE_RULES.declineDays * 2 - 1)
  const prevTo = dateMinusDays(stats.lastDate, LIFECYCLE_RULES.declineDays)
  let recent = 0
  let previous = 0
  for (const record of records) {
    if (record.date >= recentFrom && record.date <= stats.lastDate) recent += record.spend
    if (record.date >= prevFrom && record.date <= prevTo) previous += record.spend
  }
  // 之前有量、最近明显掉下去才算衰退；从 0 起量的新素材不该被判衰退
  if (previous > 0 && recent < previous * (1 - LIFECYCLE_RULES.declineRatio)) return 'declining'
  return 'running'
}

/** 按素材聚合。返回值以 assetId 为键，没消耗的素材不在里面 */
export function aggregateByAsset(records: SpendRecord[], today?: string): Map<string, AssetStats> {
  const grouped = new Map<string, SpendRecord[]>()
  for (const record of records) {
    if (!record.assetId) continue
    const list = grouped.get(record.assetId) ?? []
    list.push(record)
    grouped.set(record.assetId, list)
  }

  const out = new Map<string, AssetStats>()
  for (const [assetId, list] of grouped) {
    const dates = [...new Set(list.map((item) => item.date))].sort()
    const totalSpend = list.reduce((sum, item) => sum + item.spend, 0)
    const lastDate = dates[dates.length - 1]
    const recentFrom = lastDate ? dateMinusDays(lastDate, 6) : ''
    const recentSpend = list
      .filter((item) => item.date >= recentFrom)
      .reduce((sum, item) => sum + item.spend, 0)
    const activeDays = dates.length
    out.set(assetId, {
      assetId,
      totalSpend: Math.round(totalSpend * 100) / 100,
      activeDays,
      firstDate: dates[0],
      lastDate,
      recentSpend: Math.round(recentSpend * 100) / 100,
      dailyAverage: activeDays ? Math.round((totalSpend / activeDays) * 100) / 100 : 0,
      stage: judgeStage({ totalSpend, activeDays, lastDate }, list, today),
    })
  }
  return out
}

/** 按任务卡聚合：一张卡里所有素材的消耗之和 */
export function aggregateByCard(
  assets: AssetRecord[],
  byAsset: Map<string, AssetStats>,
): Map<string, { cardId: string; totalSpend: number; assetCount: number; activeAssetCount: number }> {
  const out = new Map<string, { cardId: string; totalSpend: number; assetCount: number; activeAssetCount: number }>()
  for (const asset of assets) {
    const cardId = asset.rootCardId ?? asset.taskId ?? 'unknown'
    const stat = byAsset.get(asset.id)
    const entry = out.get(cardId) ?? { cardId, totalSpend: 0, assetCount: 0, activeAssetCount: 0 }
    entry.assetCount += 1
    if (stat) {
      entry.totalSpend += stat.totalSpend
      entry.activeAssetCount += 1
    }
    out.set(cardId, entry)
  }
  for (const entry of out.values()) entry.totalSpend = Math.round(entry.totalSpend * 100) / 100
  return out
}

/** 按日聚合：某天所有素材消耗之和。日期升序，方便画趋势 */
export function aggregateByDate(records: SpendRecord[]): Array<{ date: string; spend: number; assetCount: number }> {
  const out = new Map<string, { date: string; spend: number; assetCount: number }>()
  const seen = new Map<string, Set<string>>()
  for (const record of records) {
    const entry = out.get(record.date) ?? { date: record.date, spend: 0, assetCount: 0 }
    entry.spend += record.spend
    out.set(record.date, entry)
    const set = seen.get(record.date) ?? new Set<string>()
    if (record.assetId) set.add(record.assetId)
    seen.set(record.date, set)
  }
  for (const [date, entry] of out) {
    entry.spend = Math.round(entry.spend * 100) / 100
    entry.assetCount = seen.get(date)?.size ?? 0
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** 阶段的中文名，界面直接用 */
export const STAGE_LABEL: Record<AssetStage, string> = {
  created: '未投放',
  running: '投放中',
  declining: '衰退中',
  stale: '已停投',
}
