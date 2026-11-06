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
import { openDB } from './idb'

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
  /**
   * 素材记录主键。
   *
   * 真实素材就是图片内容哈希（`images.id`）；演示素材是 `demo-` 开头的编造 id。
   * 这样演示数据才能按前缀一键清除 —— 所以**不能**把图片哈希当主键，
   * 否则清除逻辑会认不出来。
   */
  id: string
  /**
   * 真实图片哈希，用于加载缩略图和原图。
   *
   * 演示素材用这个字段挂到本地真实图片上（`id` 仍是 demo- 前缀），
   * 真实素材不填，缺省即等于 `id`（见 `assetImageId`）。
   */
  imageId?: string
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
  /**
   * 归属方向（`SopDirectionNode.id`，kind=direction）。
   *
   * 本地生成的素材靠 `taskId` → 任务卡的 `sopDirectionId` 找归属；
   * 从 NAS 接进来的外部素材根本没有任务卡，只能单独存一个方向。
   * 取归属时的优先级：任务卡 > 这个字段（见 `scopeAssetsForNode`）。
   */
  directionId?: string
  /**
   * 归属是怎么来的：
   * - `auto`：按 NAS 分类路径（产品/方向目录名）自动匹配出来的
   * - `manual`：人工改过，之后自动匹配不再覆盖
   */
  directionSource?: 'auto' | 'manual'
  /**
   * NAS 上的分类路径（如 `["保险","京东保","图标","横版"]`）。
   *
   * 留着它是为了「方向树改了以后能重算归属」——只存匹配结果的话，
   * 产品改名或方向拆分之后就没法重新对上了。
   */
  dirPath?: string[]
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
  /**
   * 报表里的图片名称（原样保留）。
   *
   * 匹配不上本地图时，这是**唯一**能用于展示和人工辨认的线索 ——
   * 只靠平台素材 ID 的一串数字，待认领和素材报表里根本看不出是哪个素材。
   */
  assetName?: string
  /** 报表里的媒体（如「腾讯广告升级版」） */
  media?: string
  /** 报表里的产品名 */
  productName?: string
  /**
   * 报表里的预览地址。
   *
   * 留着是为了「按图匹配」的兜底和第 3 级人工认领时能看图确认 ——
   * 现在只存不用，但原始地址丢了就再也找不回来了（报表文件会覆盖）。
   */
  previewUrl?: string
  /** 报表里的设计 / 优化师，用于按人汇总 */
  designer?: string
  optimizer?: string
  /** 是否异常标记 */
  abnormal?: boolean
  /** 来源批次，便于整批撤销 */
  importId: string
  /**
   * 调试用：这条关联是「模拟」出来的，不是真匹配。
   *
   * 导入的报表常常大批对不上本地图，台账看不到消耗就调不了界面。
   * 模拟关联把未匹配的流水临时挂到本地图片上，靠这个标记一键还原 ——
   * 还原只认这个标记，绝不会动真匹配出来的关联。
   */
  simulated?: boolean
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

/**
 * IndexedDB 里的 store 名，**必须与 `idb.ts` 建表时用的名字一致**。
 *
 * 这里刻意不 import idb.ts 的常量：idb 被不少测试 mock 过，
 * 一旦让 trackDb 依赖它的具名导出，那些只 mock 了 openDB 的测试就会报
 * 「No STORE_TRACK_* export is defined on the mock」。
 * 名字一致性由 trackDb.test.ts 里的用例守着。
 */
const STORE_BY_KIND: Record<TrackKind, string> = {
  assets: 'trackAssets',
  spend: 'trackSpend',
  lineage: 'trackLineage',
  imports: 'trackImports',
}

/** 导出给测试用：确认这里的 store 名与 idb.ts 建表时用的常量一致 */
export const TRACK_STORE_NAMES = STORE_BY_KIND

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

/**
 * 按日期区间读消耗流水。
 *
 * 不带区间就是全量 —— 但客户端**必须**带：几百万行会被拼成一个几 GB 的字符串传进 webview，
 * 直接 OOM。报表本来就是按天看的，按区间取才合理，也能走 track_spend_date 索引。
 *
 * 网页版没有索引可用（IndexedDB 只能 getAll），拿全量后在内存里过滤；
 * 那条路径只用于本地调试，不作为主要使用方式。
 */
export async function trackSpendRange<T extends { date?: string }>(
  from: string,
  to: string,
): Promise<T[]> {
  if (isTauri) {
    const raw = await call<T[] | string>('track_spend_query', {
      from: from || null,
      to: to || null,
    })
    if (typeof raw === 'string') return raw ? (JSON.parse(raw) as T[]) : []
    return raw ?? []
  }
  const all = await trackGetAll<T>('spend')
  if (!from && !to) return all
  return all.filter((item) => {
    const date = item.date ?? ''
    if (from && date < from) return false
    if (to && date > to) return false
    return true
  })
}

/**
 * 库里最新一条流水的日期（可能为空）。
 *
 * 用来回答「我明明导入了，为什么数字没变」：很多时候数据已经进库了，
 * 只是当前筛选区间的上限比它早。界面拿这个值跟区间上界比一比就能提示出来，
 * 不用用户自己去猜日期。
 */
export async function trackSpendLatest(): Promise<string | null> {
  if (isTauri) {
    const raw = await call<string | null>('track_spend_latest')
    return raw || null
  }
  const all = await trackGetAll<{ date?: string }>('spend')
  let latest = ''
  for (const item of all) {
    const date = item.date ?? ''
    if (date > latest) latest = date
  }
  return latest || null
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
    /*
     * 整批走一个事务。
     *
     * 原来是逐条 invoke：每条一个独立事务，导入 8000 行报表就是 8000 次 fsync，
     * 客户端上要十几秒。改成单事务批量插入后是亚秒级。
     * 代价是失败时整批回滚（拿不到「具体哪条坏」），但写入前已经校验过 JSON，
     * 实际出错基本只剩磁盘满这类整批都写不了的情况。
     */
    await call('track_put_many', {
      kind,
      items: items.map((item) => ({ id: item.id, data: JSON.stringify(item.data) })),
    })
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

/**
 * 记一条任务卡血缘。
 *
 * 为什么不让调用方自己拼：血缘是「顺手记一笔」的事，失败了不该影响出图，
 * 所以这里统一吞掉异常只打日志。主键用「子卡 + 母卡」保证同一对关系不会重复记。
 */
export async function recordLineage(
  cardId: string,
  parentCardId: string,
  relation: LineageRecord['relation'],
): Promise<void> {
  if (!cardId || !parentCardId || cardId === parentCardId) return
  try {
    const record: LineageRecord = {
      id: lineageId(cardId, parentCardId),
      cardId,
      parentCardId,
      relation,
      createdAt: Date.now(),
    }
    await trackPut('lineage', record.id, record)
  } catch (err) {
    // 血缘记不上不影响出图，但要留痕便于排查
    console.warn('记录任务卡血缘失败：', err)
  }
}

/** 消耗流水的稳定主键：同一平台素材同一天只应有一条 */
export function spendId(platformId: string, date: string) {
  return `${platformId}__${date}`
}

export function lineageId(cardId: string, parentCardId: string) {
  return `${cardId}__${parentCardId}`
}
