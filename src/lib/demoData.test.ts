import { describe, expect, it } from 'vitest'
import { DEMO_PREFIX, buildDemoBundle, isDemoId } from './demoData'
import { aggregateByAsset, buildLineageMap, descendantCards } from './assetLedger'

const TODAY = '2026-11-04'
const bundle = buildDemoBundle(TODAY)

describe('演示数据可一键清除', () => {
  it('四张表的 id 全部带 demo- 前缀', () => {
    // 清除是按前缀删的，只要漏一条就会残留成「删不掉的脏数据」
    expect(bundle.assets.every((item) => isDemoId(item.id))).toBe(true)
    expect(bundle.spend.every((item) => isDemoId(item.id))).toBe(true)
    expect(bundle.lineage.every((item) => isDemoId(item.id))).toBe(true)
    expect(bundle.imports.every((item) => isDemoId(item.id))).toBe(true)
    expect(DEMO_PREFIX).toBe('demo-')
  })

  it('spend 的 platformId 也带前缀（待认领页按它分组，混进真实 ID 会串数据）', () => {
    expect(bundle.spend.every((item) => isDemoId(item.platformId))).toBe(true)
  })
})

describe('演示数据要覆盖全部生命周期阶段', () => {
  const stats = aggregateByAsset(bundle.spend, TODAY)
  const stages = new Set([...stats.values()].map((item) => item.stage))

  it('投放中 / 衰退中 / 已停投 都出现', () => {
    expect(stages.has('running')).toBe(true)
    expect(stages.has('declining')).toBe(true)
    expect(stages.has('stale')).toBe(true)
  })

  it('也有完全没消耗的素材（台账里显示「未投放」）', () => {
    const idle = bundle.assets.filter((item) => !stats.has(item.id))
    expect(idle.length).toBeGreaterThan(0)
  })
})

describe('演示数据的血缘', () => {
  const map = buildLineageMap(bundle.lineage)

  it('有一条三代链（a → b → c）', () => {
    const chain = descendantCards(`${DEMO_PREFIX}card-a`, map)
    expect(chain).toContain(`${DEMO_PREFIX}card-b`)
    expect(chain).toContain(`${DEMO_PREFIX}card-c`)
  })

  it('有一个母版分叉出两个方向（a → b、a → d）', () => {
    const a = map.get(`${DEMO_PREFIX}card-a`)!
    expect(a.children.length).toBeGreaterThanOrEqual(2)
  })

  it('家族合计能把多张卡加起来（详情页要展示的数）', () => {
    const family = descendantCards(`${DEMO_PREFIX}card-a`, map)
    expect(family.length).toBeGreaterThanOrEqual(4)
  })
})

describe('演示数据的规模与稳定性', () => {
  it('素材与流水都有一定量，界面才看得出效果', () => {
    expect(bundle.assets.length).toBeGreaterThanOrEqual(25)
    expect(bundle.spend.length).toBeGreaterThanOrEqual(200)
  })

  it('同一基准日反复生成的结果完全一致（固定种子，便于对照截图）', () => {
    const again = buildDemoBundle(TODAY)
    expect(again.assets.map((item) => item.id)).toEqual(bundle.assets.map((item) => item.id))
    expect(again.spend.reduce((sum, item) => sum + item.spend, 0))
      .toBeCloseTo(bundle.spend.reduce((sum, item) => sum + item.spend, 0), 6)
  })

  it('消耗金额都为正数、日期落在基准日前后合理范围内', () => {
    expect(bundle.spend.every((item) => item.spend > 0)).toBe(true)
    expect(bundle.spend.every((item) => item.date <= TODAY)).toBe(true)
  })

  it('导入记录里的合计与流水一致（统计页要拿它对账）', () => {
    const total = bundle.spend.reduce((sum, item) => sum + item.spend, 0)
    expect(bundle.imports[0].totalSpend).toBeCloseTo(total, 2)
  })
})

/**
 * 挂本地真实图片。
 *
 * 演示数据原先用编造哈希，缩略图永远是灰块，看不出「这张图长什么样」。
 * 现在可以把素材挂到本地已有的图上 —— 但主键必须还是 demo- 前缀，
 * 否则「一键清除」会认不出这些记录，反而把真实素材删掉。
 */
describe('演示素材挂本地真实图片', () => {
  /** 造一个池子：40 张图，来自 5 张卡 */
  const pool = Array.from({ length: 40 }, (_, i) => ({
    imageId: `real-hash-${String(i).padStart(3, '0')}`,
    taskId: `real-task-${Math.floor(i / 8)}`,
  }))

  it('有图可挂时，imageId 是真实哈希，主键仍是 demo- 前缀', () => {
    const withImages = buildDemoBundle(TODAY, pool)
    const linked = withImages.assets.filter((item) => item.imageId)
    expect(linked.length).toBe(withImages.withRealImage)
    expect(linked.length).toBeGreaterThan(0)
    for (const asset of linked) {
      expect(isDemoId(asset.id)).toBe(true)
      expect(asset.imageId).toMatch(/^real-hash-/)
    }
  })

  it('挂上真实图后，来源任务卡也是真实卡（详情里才查得到提示词）', () => {
    const withImages = buildDemoBundle(TODAY, pool)
    const linked = withImages.assets.filter((item) => item.imageId)
    expect(linked.every((item) => item.taskId?.startsWith('real-task-'))).toBe(true)
  })

  it('池子够用时一张图只用一次，台账里不会出现重复图', () => {
    const withImages = buildDemoBundle(TODAY, pool)
    const used = withImages.assets.map((item) => item.imageId).filter(Boolean)
    expect(new Set(used).size).toBe(used.length)
  })

  it('池子不够用时按需复用，但主键仍然唯一、每个素材都挂得上图', () => {
    const small = pool.slice(0, 7)
    const withImages = buildDemoBundle(TODAY, small)
    // 32 个素材全部能挂图（复用）
    expect(withImages.withRealImage).toBe(withImages.assets.length)
    const ids = withImages.assets.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('不传池子时退回编造哈希，且不留 imageId（缩略图灰块是有意的）', () => {
    const plain = buildDemoBundle(TODAY)
    expect(plain.withRealImage).toBe(0)
    expect(plain.assets.every((item) => !item.imageId)).toBe(true)
    expect(plain.assets.every((item) => isDemoId(item.id))).toBe(true)
  })

  it('同一张图在池子里出现多次会被去重', () => {
    const dup = [
      { imageId: 'same-hash', taskId: 't1' },
      { imageId: 'same-hash', taskId: 't2' },
      { imageId: 'other-hash', taskId: 't2' },
    ]
    const withImages = buildDemoBundle(TODAY, dup)
    expect(withImages.withRealImage).toBe(withImages.assets.length)
    expect(new Set(withImages.assets.map((item) => item.imageId)).size).toBe(2)
  })

  it('挂图不影响消耗与血缘（换的只是展示层）', () => {
    const plain = buildDemoBundle(TODAY)
    const withImages = buildDemoBundle(TODAY, pool)
    expect(withImages.spend.length).toBe(plain.spend.length)
    expect(withImages.lineage.length).toBe(plain.lineage.length)
    const plainTotal = plain.spend.reduce((sum, item) => sum + item.spend, 0)
    const linkedTotal = withImages.spend.reduce((sum, item) => sum + item.spend, 0)
    expect(linkedTotal).toBeCloseTo(plainTotal, 6)
  })
})
