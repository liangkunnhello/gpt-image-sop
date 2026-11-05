/**
 * 演示数据：让空库也能看到界面长什么样。
 *
 * 存在的理由：track 版是独立数据目录，新装上是空的，
 * 没导入过报表就看不到台账、统计、血缘的效果。
 *
 * **所有记录的 id 都以 `demo-` 开头**，清除时按前缀删，不会碰真实数据。
 *
 * 图片优先绑定本地已有的真实图片（传入 pool）：素材的 `id` 仍是 demo- 前缀，
 * 真实图片哈希另存在 `imageId` 里，这样既能显示缩略图、又能一键清除。
 * 池子里没有图时才退回编造哈希（缩略图显示灰块）。
 */
import type { AssetRecord, ImportRecord, LineageRecord, SpendRecord } from './trackDb'
import { lineageId, spendId } from './trackDb'

/** 演示数据的统一前缀，清除时按它删 */
export const DEMO_PREFIX = 'demo-'

export function isDemoId(id: string) {
  return id.startsWith(DEMO_PREFIX)
}

/** 可以挂给演示素材的本地真实图片 */
export interface DemoImageRef {
  /** 图片内容哈希，等于 images.id */
  imageId: string
  /** 这张图来自哪张任务卡 */
  taskId: string
}

/** 固定种子的伪随机，保证每次生成同一批数据，便于对照和复现 */
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function dateOffset(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number)
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function fakeHash(rand: () => number): string {
  let out = ''
  for (let i = 0; i < 64; i += 1) out += '0123456789abcdef'[Math.floor(rand() * 16)]
  return `${DEMO_PREFIX}${out}`
}

/**
 * 去掉重复和空值。
 *
 * 同一张图可能出现在多张卡的 outputImages 里（复用配置再生成会引用同一张），
 * 不去重的话台账里会出现好几条指向同一张图的「不同素材」。
 */
function normalizePool(pool: DemoImageRef[]): DemoImageRef[] {
  const out: DemoImageRef[] = []
  const seen = new Set<string>()
  for (const item of pool) {
    if (!item?.imageId || seen.has(item.imageId)) continue
    seen.add(item.imageId)
    out.push(item)
  }
  return out
}

/** 消耗趋势形态 —— 目的是把四种生命周期阶段都演示出来 */
type Trend = 'rising' | 'flat' | 'declining' | 'stopped' | 'idle'

export interface DemoBundle {
  assets: AssetRecord[]
  spend: SpendRecord[]
  lineage: LineageRecord[]
  imports: ImportRecord[]
  /** 实际挂上本地真实图片的素材数，界面用来提示「有没有图可看」 */
  withRealImage: number
}

/**
 * 生成一批演示数据。
 *
 * 结构刻意贴近真实场景：
 * - 5 张任务卡，第 2 张是从第 1 张衍生的、第 3 张是从第 2 张衍生的（一条三代血缘链）；
 * - 另有第 4 张从第 1 张分叉出去，演示「一个母版衍生出多个方向」；
 * - 每张卡 6~10 个素材，趋势覆盖上升/平稳/衰退/停投/未投放五种。
 *
 * @param today 基准日（YYYY-MM-DD），测试里传固定值才能断言
 * @param pool  本地真实图片池。传进来就把演示素材挂到这些图上（缩略图能显示），
 *              不传则用编造哈希（缩略图灰块）。池子按卡均分，一张图只用一次。
 */
export function buildDemoBundle(today: string, pool: DemoImageRef[] = []): DemoBundle {
  const rand = makeRandom(20261104)
  /**
   * 假哈希用独立的随机序列。
   *
   * 原先和金额共用 rand：挂上真实图片后不再生成假哈希，随机数消耗得少，
   * 后面的金额和日期就整体偏移了 —— 表现为「填两次演示数据、金额不一样」，
   * 固定种子可复现这个承诺就破了。
   */
  const hashRand = makeRandom(77123401)
  const images = normalizePool(pool)
  const cards = [
    { id: `${DEMO_PREFIX}card-a`, count: 8, trend: 'rising' as Trend, parent: undefined },
    { id: `${DEMO_PREFIX}card-b`, count: 7, trend: 'flat' as Trend, parent: `${DEMO_PREFIX}card-a` },
    { id: `${DEMO_PREFIX}card-c`, count: 6, trend: 'declining' as Trend, parent: `${DEMO_PREFIX}card-b` },
    { id: `${DEMO_PREFIX}card-d`, count: 6, trend: 'stopped' as Trend, parent: `${DEMO_PREFIX}card-a` },
    { id: `${DEMO_PREFIX}card-e`, count: 5, trend: 'idle' as Trend, parent: undefined },
  ]

  const assets: AssetRecord[] = []
  const spend: SpendRecord[] = []
  const lineage: LineageRecord[] = []
  const now = Date.now()
  let withRealImage = 0

  cards.forEach((card, cardIndex) => {
    if (card.parent) {
      lineage.push({
        id: lineageId(card.id, card.parent),
        cardId: card.id,
        parentCardId: card.parent,
        relation: 'derive',
        createdAt: now,
      })
    }

    /*
     * 把图片池按卡均分，而不是全局循环取。
     * 均分之后「同一张卡下的素材」看起来才像同一次生成的产物；
     * 全局轮询会让 card-a 和 card-c 交替用图，翻台账时很出戏。
     */
    /*
     * 池子至少每卡一张时才均分；不够分就各卡共用全池（会复用图，但不会出现
     * 「某些卡完全没图、缩略图一片灰」）。均分本身是为了让同一张卡下的素材
     * 看起来像同一次生成的产物。
     */
    const shareable = images.length >= cards.length
    const start = shareable ? Math.round((cardIndex * images.length) / cards.length) : 0
    const end = shareable ? Math.round(((cardIndex + 1) * images.length) / cards.length) : images.length
    const own = images.slice(start, end)

    for (let index = 0; index < card.count; index += 1) {
      // 池子够就一条一张；不够才回绕复用（复用会让图重复，但总比全灰块强）
      const local = own.length ? own[index % own.length] : undefined
      const imageId = local ? local.imageId : fakeHash(hashRand)
      if (local) withRealImage += 1

      /*
       * 主键必须带 demo- 前缀（清除靠它），又要保证唯一：
       * 带上卡标识和序号，即使池子回绕复用同一张图也不会撞主键。
       */
      const assetId = local
        ? `${DEMO_PREFIX}img-${imageId.slice(0, 12)}-${card.id.slice(-1)}-${index}`
        : imageId

      const platformId = `${DEMO_PREFIX}pid-${Math.floor(rand() * 900000 + 100000)}`
      assets.push({
        id: assetId,
        // 挂真实图时才写 imageId：真实素材这个字段是空的（id 本身就是哈希）
        imageId: local ? imageId : undefined,
        // 来源卡用真实任务卡，详情抽屉里才查得到提示词；血缘仍走 demo 命名空间
        taskId: local ? local.taskId : `${card.id}-task`,
        rootCardId: card.id,
        platformIds: card.trend === 'idle' ? [] : [platformId],
        reportNames: [],
        createdAt: now - 20 * 86400000,
        firstSeenAt: card.trend === 'idle' ? undefined : now - 14 * 86400000,
      })

      // 未投放的素材不产生流水
      if (card.trend === 'idle') continue

      const days = card.trend === 'stopped' ? 5 : 14
      // 起点日期：停投的往前挪，让「距最后消耗超过 7 天」这条规则能命中
      const startOffset = card.trend === 'stopped' ? -20 : -13
      const base = 200 + rand() * 800

      for (let day = 0; day < days; day += 1) {
        const progress = day / Math.max(1, days - 1)
        let factor = 1
        if (card.trend === 'rising') factor = 0.35 + progress * 1.4
        else if (card.trend === 'flat') factor = 0.9 + rand() * 0.2
        else if (card.trend === 'declining') factor = 1.6 - progress * 1.3
        else if (card.trend === 'stopped') factor = 1.2 - progress * 0.4
        // 每个素材的体量拉开差距，排行看着才像真的
        const scale = 0.3 + rand() * 1.7
        const amount = Math.round(base * factor * scale * 100) / 100
        if (amount <= 0) continue
        const date = dateOffset(today, startOffset + day)
        spend.push({
          id: spendId(platformId, date),
          platformId,
          assetId,
          date,
          spend: amount,
          media: index % 2 === 0 ? '腾讯广告升级版' : '巨量引擎升级版',
          productName: '百万医疗险（演示）',
          designer: ['陈皇', '梁坤', '杨紫成'][index % 3],
          optimizer: ['后期陈皇', '欧阳凯丰', '杨亚东'][index % 3],
          importId: `${DEMO_PREFIX}import-1`,
        })
      }
    }
  })

  const totalSpend = Math.round(spend.reduce((sum, item) => sum + item.spend, 0) * 100) / 100
  const imports: ImportRecord[] = [
    {
      id: `${DEMO_PREFIX}import-1`,
      fileName: '素材报表明细（演示数据）.xlsx',
      importedAt: now,
      rowCount: spend.length,
      totalSpend,
      matchedCount: new Set(spend.map((item) => item.platformId)).size,
      unmatchedCount: 0,
    },
  ]

  return { assets, spend, lineage, imports, withRealImage }
}
