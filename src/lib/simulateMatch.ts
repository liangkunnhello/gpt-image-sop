/**
 * 调试用：把「认不到本地图」的报表流水临时挂到本地素材上。
 *
 * 为什么需要它：导入的真实报表经常大批对不上本地图（平台不给 MD5，
 * 图片名称也未必留），这时台账里消耗几乎是 0，界面效果根本没法调。
 * 模拟关联让这些流水先挂到本地图片上，台账、统计、详情抽屉都能看出样子。
 *
 * 两条铁律：
 * 1. 只动**没匹配过**的流水，绝不覆盖真匹配的结果；
 * 2. 每条挂上去的记录都带 `simulated: true`，还原只认这个标记，
 *    即使之后又导入了几批真实报表，也不会被误删。
 */
import type { AssetRecord, SpendRecord } from './trackDb'
import { DEMO_PREFIX } from './demoData'

export interface SimulatePlan {
  /** 需要写回的流水（只有变化的那些） */
  spend: SpendRecord[]
  /** 需要写回的素材（只有变化的那些） */
  assets: AssetRecord[]
  /** 关联了多少条流水 */
  linkedRecords: number
  /** 关联了多少个平台素材 */
  linkedPlatforms: number
  /** 没有可挂的素材时为 0，界面据此提示「先建台账或出几张图」 */
  usedAssets: number
}

/** 还没有任何关联记录的空结果 */
const EMPTY: SimulatePlan = { spend: [], assets: [], linkedRecords: 0, linkedPlatforms: 0, usedAssets: 0 }

/**
 * 挑选可挂载的本地素材。
 *
 * 优先真实素材，一个都没有时才退回演示素材 —— 演示素材是可以一键清除的，
 * 真实流水挂到上面，清完就变成指向不存在素材的悬空记录。
 */
function pickTargets(assets: AssetRecord[]): AssetRecord[] {
  const real = assets.filter((asset) => !asset.id.startsWith(DEMO_PREFIX))
  return real.length ? real : assets
}

/**
 * 生成模拟关联计划（不写库，纯函数）。
 *
 * 分配方式：把未匹配的流水按平台素材聚合成一组，按累计消耗降序，
 * 轮流分配给候选素材。之所以不随机，是因为随机会让「高消耗素材」看起来是随机的，
 * 排查界面时容易误判；轮流分配至少能让排行有稳定的形状。
 */
export function planSimulateMatches(spend: SpendRecord[], assets: AssetRecord[]): SimulatePlan {
  const targets = pickTargets(assets)
  if (!targets.length) return EMPTY

  // 1) 未匹配的平台素材，按累计消耗降序
  const groups = new Map<string, { platformId: string; spend: number }>()
  for (const record of spend) {
    if (record.assetId) continue
    const entry = groups.get(record.platformId) ?? { platformId: record.platformId, spend: 0 }
    entry.spend += record.spend
    groups.set(record.platformId, entry)
  }
  if (!groups.size) return EMPTY

  const ordered = [...groups.values()].sort((a, b) => b.spend - a.spend)
  const assign = new Map<string, AssetRecord>()
  ordered.forEach((group, index) => {
    assign.set(group.platformId, targets[index % targets.length])
  })

  // 2) 流水按平台改挂
  const changedSpend: SpendRecord[] = []
  for (const record of spend) {
    if (record.assetId) continue
    const target = assign.get(record.platformId)
    if (!target) continue
    changedSpend.push({ ...record, assetId: target.id, simulated: true })
  }

  // 3) 素材补平台 ID（同一个素材可能被挂多个平台，用 Set 去重）
  const pidsByAsset = new Map<string, Set<string>>()
  for (const [platformId, target] of assign) {
    const bucket = pidsByAsset.get(target.id) ?? new Set<string>()
    bucket.add(platformId)
    pidsByAsset.set(target.id, bucket)
  }
  const changedAssets: AssetRecord[] = []
  for (const [assetId, pids] of pidsByAsset) {
    const asset = targets.find((item) => item.id === assetId)
    if (!asset) continue
    const merged = [...asset.platformIds]
    for (const pid of pids) if (!merged.includes(pid)) merged.push(pid)
    changedAssets.push({ ...asset, platformIds: merged })
  }

  return {
    spend: changedSpend,
    assets: changedAssets,
    linkedRecords: changedSpend.length,
    linkedPlatforms: ordered.length,
    usedAssets: pidsByAsset.size,
  }
}

/**
 * 当前有多少条模拟关联（界面用来决定显示「模拟关联」还是「还原」）。
 */
export function countSimulated(spend: SpendRecord[]): number {
  return spend.reduce((count, record) => count + (record.simulated ? 1 : 0), 0)
}

/**
 * 还原模拟关联：把 `simulated` 的流水退回到未匹配状态，并从素材上摘掉这些平台 ID。
 *
 * 判断「该不该摘」的关键：这个平台 ID 是不是还被**非模拟**的记录引用着。
 * 如果之前手工绑定过同一个平台 ID，那它在真记录里也有，就不能摘 ——
 * 否则还原一次会把人工绑定的成果一起清掉。
 */
export function planRestoreMatches(spend: SpendRecord[], assets: AssetRecord[]): SimulatePlan {
  const simulated = spend.filter((record) => record.simulated)
  if (!simulated.length) return EMPTY

  // 真记录（非模拟）占用的「素材 + 平台」组合
  const kept = new Set<string>()
  for (const record of spend) {
    if (record.simulated || !record.assetId) continue
    kept.add(`${record.assetId}__${record.platformId}`)
  }

  const simulatedPairs = new Map<string, Set<string>>()
  for (const record of simulated) {
    if (!record.assetId) continue
    const bucket = simulatedPairs.get(record.assetId) ?? new Set<string>()
    bucket.add(record.platformId)
    simulatedPairs.set(record.assetId, bucket)
  }

  const restoredSpend: SpendRecord[] = simulated.map((record) => {
    const next = { ...record }
    delete next.assetId
    delete next.simulated
    return next
  })

  const restoredAssets: AssetRecord[] = []
  for (const [assetId, pids] of simulatedPairs) {
    const asset = assets.find((item) => item.id === assetId)
    if (!asset) continue
    const platformIds = asset.platformIds.filter(
      (pid) => !pids.has(pid) || kept.has(`${assetId}__${pid}`),
    )
    restoredAssets.push({ ...asset, platformIds })
  }

  return {
    spend: restoredSpend,
    assets: restoredAssets,
    linkedRecords: restoredSpend.length,
    linkedPlatforms: new Set(simulated.map((item) => item.platformId)).size,
    usedAssets: simulatedPairs.size,
  }
}
