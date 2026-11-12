/**
 * 「同一张图存了多份」的识别与合并。
 *
 * 背景：素材主键是图片 id，但 id 不总是文件内容哈希 ——
 * 生成图入库后，后处理会按模板尺寸重写文件，id 不跟着变；之后 NAS 导入同一张成品图，
 * 又按真实内容哈希建了一条素材，于是同一张图在台账里被拆成两条、消耗也被拆开。
 *
 * 处理策略：
 * - 便宜的前置筛：先按图片字节数分桶，只有同字节数的桶里 ≥2 条才真正读文件算 sha256
 *   （1 万多条素材全读一遍要 2GB+，没必要）；
 * - 只把「确实重复」的那几条的哈希写回素材（`contentHash`），其余不落库；
 * - 展示层用 `hashOfAsset()` 取分组键：有 contentHash 用它，否则退回素材 id。
 */

/** 参与去重判断的素材最小信息 */
export interface AssetRef {
  id: string
  /** 真实图片 id；缺省即等于 id */
  imageId?: string
  /** 已算过的内容哈希（sha256），命中就不重复算 */
  contentHash?: string
}

export interface DuplicatePlan {
  /** 素材 id → 内容哈希（只含确认重复的那几条） */
  hashById: Map<string, string>
  /** 需要写回素材记录的 contentHash */
  updates: Array<{ assetId: string; contentHash: string }>
}

/**
 * 找出重复内容的素材。
 *
 * @param assets 全部素材
 * @param bytesById 图片 id → 字节数（来自 image_stats，一次 IPC 拿全）
 * @param computeHash 读文件并算 sha256；读不到返回 undefined
 */
export async function planDuplicateHashes(
  assets: AssetRef[],
  bytesById: Map<string, number>,
  computeHash: (imageId: string) => Promise<string | undefined>,
): Promise<DuplicatePlan> {
  const hashById = new Map<string, string>()
  const updates: Array<{ assetId: string; contentHash: string }> = []

  // 已经算过的直接用；同时按字节数把「可能要算」的素材分桶
  const buckets = new Map<number, AssetRef[]>()
  for (const asset of assets) {
    if (asset.contentHash) {
      hashById.set(asset.id, asset.contentHash)
      continue
    }
    const imageId = asset.imageId || asset.id
    const size = bytesById.get(imageId)
    if (size === undefined) continue
    const list = buckets.get(size) ?? []
    list.push(asset)
    buckets.set(size, list)
  }

  for (const [, sameSize] of buckets) {
    // 字节数不同内容必然不同，只有同尺寸的才有必要比
    if (sameSize.length < 2) continue
    const byHash = new Map<string, AssetRef[]>()
    for (const asset of sameSize) {
      const imageId = asset.imageId || asset.id
      let hash = hashById.get(asset.id)
      if (!hash) {
        hash = await computeHash(imageId)
        if (!hash) continue
      }
      const list = byHash.get(hash) ?? []
      list.push(asset)
      byHash.set(hash, list)
    }
    for (const [hash, group] of byHash) {
      if (group.length < 2) continue
      for (const asset of group) {
        hashById.set(asset.id, hash)
        if (asset.contentHash !== hash) updates.push({ assetId: asset.id, contentHash: hash })
      }
    }
  }

  return { hashById, updates }
}

/** 分组键：有内容哈希用它，否则退回素材 id */
export function hashOfAsset(asset: AssetRef, hashById: Map<string, string>): string {
  return hashById.get(asset.id) || asset.contentHash || asset.id
}

/**
 * 把消耗记录里的素材 id 换成内容哈希分组键。
 *
 * 换完之后 `aggregateByAsset` 自然就把同一张图的多次投放合并成一行，
 * 台账卡片与报表行也就能用同一个键对齐。
 */
export function remapSpendAssetIds<T extends { assetId?: string }>(
  records: T[],
  hashById: Map<string, string>,
): T[] {
  if (!hashById.size) return records
  return records.map((record) => {
    if (!record.assetId) return record
    const key = hashById.get(record.assetId)
    return key && key !== record.assetId ? { ...record, assetId: key } : record
  })
}

/** 同内容素材合并后的展示单元 */
export interface AssetGroup<T> {
  /** 分组键（内容哈希） */
  key: string
  /** 代表素材：字段已合并（platformIds / reportNames 取并集），点开详情用它 */
  asset: T
  members: T[]
}

/**
 * 按内容把素材分组。
 *
 * 合并后卡片上的「N 个ID」「报表名」应当是整组的，所以代表的 platformIds / reportNames
 * 取并集；其余字段（缩略图、任务卡、血缘）仍取代表自己的。
 * 组内顺序按传入顺序，代表即第一个。
 */
export function groupAssetsByContent<T extends AssetRef & {
  platformIds?: string[]
  reportNames?: string[]
}>(assets: T[], hashById: Map<string, string>): Array<AssetGroup<T>> {
  const groups = new Map<string, T[]>()
  for (const asset of assets) {
    const key = hashOfAsset(asset, hashById)
    const list = groups.get(key) ?? []
    list.push(asset)
    groups.set(key, list)
  }
  return [...groups.entries()].map(([key, members]) => {
    if (members.length === 1) return { key, asset: members[0], members }
    const platformIds = [...new Set(members.flatMap((item) => item.platformIds ?? []))]
    const reportNames = [...new Set(members.flatMap((item) => item.reportNames ?? []))]
    return {
      key,
      asset: { ...members[0], platformIds, reportNames },
      members,
    }
  })
}
