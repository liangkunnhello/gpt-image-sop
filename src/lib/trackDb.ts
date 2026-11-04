/**
 * 素材投放跟踪的数据层（track 分支专用）。
 *
 * 四类实体：
 * - **素材台账（AssetRecord）**：一张图一条。主键直接用图片内容哈希 `imageId`
 *   —— 主版本的 `images.id` 本来就是 SHA-256，同图天然去重，不需要另算 MD5。
 * - **消耗流水（SpendRecord）**：平台素材 × 投放日 一条，来自报表导入。
 * - **任务卡血缘（LineageRecord）**：卡与卡的衍生关系，自动记录 + 手动补挂。
 * - **导入批次（ImportRecord）**：每次导入的对账信息（行数、消耗合计、匹配情况）。
 *
 * 存储刻意做成 `id + JSON` 的单表结构（与 tasks 一致）：
 * 客户端走 SQLite、网页走 IndexedDB，两端共用同一套读写代码；
 * 新增字段只改 JSON，不用改 schema。聚合在前端内存里算。
 */
import { isTauri } from './platform'
import { openDB, STORE_TRACK_ASSETS, STORE_TRACK_IMPORTS, STORE_TRACK_LINEAGE, STORE_TRACK_SPEND } from './idb'

/** 素材在生命周期里所处的位置 */
export type AssetStage =
  /** 已生成，还没进报表 */
  | 'created'
  /** 已投放，报表里出现过 */
  | 'running'
  /** 消耗下滑中 */
  | 'declining'
  /** 长期无消耗 */
  | 'stale'

export interface AssetRecord {
  /** 图片内容哈希，等于 images.id */
  id: string
  /** 来源任务卡 */
  taskId?: string
  /** 血缘根卡（同一母体衍生出来的共用这个 id） */
  rootCardId?: string
  /** 母素材：这张图是从哪张图衍生/改造来的 */
  parentAssetId?: string
  /**
   * 投放平台给的素材 ID 列表。
   * 一张图可能同时投多个平台，也可能被平台重新上传成不同 ID，所以是数组。
   */
  platformIds: string[]
  /** 报表里出现过的图片名称，用于反查和展示 */
  reportNames: string[]
  createdAt: number
  /** 第一次在报表里出现的时间 */
  firstSeenAt?: number
  /** 最后一次有消耗的日期（YYYY-MM-DD） */
  lastSpendDate?: string
  /** 手动标注，优先级高于自动判定 */
  stageOverride?: AssetStage
  note?: string
}

export interface SpendRecord {
  /** `${platformId}__${date}`，保证同一素材同一天只留一条（重复导入会覆盖而不是叠加） */
  id: string
  platformId: string
  /** 匹配到的本地素材哈希；没匹配上就是 undefined，进「待认领」 */
  assetId?: string
  /** 投放日 YYYY-MM-DD */
  date: string
  spend: number
  /** 报表里的媒体（如「腾讯广告升级版」） */
  media?: string
  /** 报表里的产品名 */
  productName?: string
  /** 报表里的设计 / 优化师，用于按人汇总 */
  designer?: string
  optimizer?: string
  /** 是否异常标记 */
  abnormal?: boolean
  /** 来源批次，便于整批撤销 */
  importId: string
}

export interface LineageRecord {
  /** `${cardId}__${parentCardId}` */
  id: string
  cardId: string
  parentCardId: string
  /** 关系类型：衍生 / 拆解 / 重制 / 手动 */
  relation: 'derive' | 'split' | 'rebuild' | 'manual'
  createdAt: number
}

export interface ImportRecord {
  id: string
  fileName: string
  importedAt: number
  /** 报表里读到的总行数 */
  rowCount: number
  /** 报表里的消耗合计，用于对账 */
  totalSpend: number
  /** 成功匹配到本地素材的行数 */
  matchedCount: number
  /** 匹配不上、进待认领的行数 */
  unmatchedCount: number
}

type TrackKind = 'assets' | 'spend' | 'lineage' | 'imports'

const STORE_BY_KIND: Record<TrackKind, string> = {
  assets: STORE_TRACK_ASSETS,
  spend: STORE_TRACK_SPEND,
  lineage: STORE_TRACK_LINEAGE,
  imports: STORE_TRACK_IMPORTS,
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

/** 读整张表。数据量在几万行以内，一次性读进内存后所有聚合都在内存里做 */
export async function trackGetAll<T>(kind: TrackKind): Promise<T[]> {
  if (isTauri) {
    const raw = await call<T[] | string>('track_get_all', { kind })
    // Tauri 端返回的是 Response（已解析成对象）；个别环境可能给字符串，两种都兼容
    if (typeof raw === 'string') return raw ? (JSON.parse(raw) as T[]) : []
    return raw ?? []
  }
  const db = await openDB()
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(STORE_BY_KIND[kind], 'readonly')
    const req = tx.objectStore(STORE_BY_KIND[kind]).getAll()
    req.onsuccess = () => resolve((req.result ?? []) as T[])
    req.onerror = () => reject(req.error)
  })
}

export async function trackPut(kind: TrackKind, id: string, data: unknown): Promise<void> {
  if (isTauri) {
    await call('track_put', { kind, id, data: JSON.stringify(data) })
    return
  }
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BY_KIND[kind], 'readwrite')
    tx.objectStore(STORE_BY_KIND[kind]).put(data)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 批量写入。导入报表时几千行逐条 await 会把主线程拖住，这里合并事务 */
export async function trackPutMany(kind: TrackKind, items: Array<{ id: string; data: unknown }>): Promise<void> {
  if (!items.length) return
  if (isTauri) {
    // Tauri 侧命令是逐条的，串行提交即可：写的是同一个 SQLite，每次都是独立事务，
    // 比一条大事务慢一点，但胜在失败能定位到具体哪条
    for (const item of items) {
      await call('track_put', { kind, id: item.id, data: JSON.stringify(item.data) })
    }
    return
  }
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BY_KIND[kind], 'readwrite')
    const store = tx.objectStore(STORE_BY_KIND[kind])
    for (const item of items) store.put(item.data)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function trackDelete(kind: TrackKind, id: string): Promise<void> {
  if (isTauri) {
    await call('track_delete', { kind, id })
    return
  }
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BY_KIND[kind], 'readwrite')
    tx.objectStore(STORE_BY_KIND[kind]).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function trackClear(kind: TrackKind): Promise<void> {
  if (isTauri) {
    await call('track_clear', { kind })
    return
  }
  const db = await openDB()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_BY_KIND[kind], 'readwrite')
    tx.objectStore(STORE_BY_KIND[kind]).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 消耗流水的稳定主键：同一平台素材同一天只应有一条 */
export function spendId(platformId: string, date: string) {
  return `${platformId}__${date}`
}

export function lineageId(cardId: string, parentCardId: string) {
  return `${cardId}__${parentCardId}`
}
