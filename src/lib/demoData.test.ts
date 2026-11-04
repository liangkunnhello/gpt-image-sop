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
