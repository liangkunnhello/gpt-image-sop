import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_RULES,
  aggregateByAsset,
  aggregateByCard,
  aggregateByDate,
  buildAssetsFromTasks,
  judgeStage,
  mergeAssets,
} from './assetLedger'
import type { AssetRecord, SpendRecord } from './trackDb'
import type { TaskRecord } from '../types'

function task(patch: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    prompt: 'p',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...patch,
  } as TaskRecord
}

function spend(patch: Partial<SpendRecord> & { id: string; date: string; spend: number }): SpendRecord {
  return {
    platformId: 'pid',
    importId: 'imp',
    ...patch,
  } as SpendRecord
}

describe('buildAssetsFromTasks', () => {
  it('每张已出的图建一条，主键用图片哈希', () => {
    const assets = buildAssetsFromTasks([
      task({ id: 't1', outputImages: ['h1', 'h2'] }),
    ])
    expect(assets.map((item) => item.id).sort()).toEqual(['h1', 'h2'])
    expect(assets[0].taskId).toBe('t1')
  })

  it('没出图的任务不建记录', () => {
    expect(buildAssetsFromTasks([task({ id: 't1', outputImages: [] })])).toEqual([])
  })

  it('进回收站的任务不建记录', () => {
    expect(buildAssetsFromTasks([task({ id: 't1', outputImages: ['h1'], deletedAt: 1 })])).toEqual([])
  })

  it('血缘根取 sopJobId，没有就用任务自己', () => {
    const assets = buildAssetsFromTasks([
      task({ id: 't1', sopJobId: 'job-1', outputImages: ['h1'] }),
      task({ id: 't2', outputImages: ['h2'] }),
    ])
    expect(assets.find((item) => item.id === 'h1')?.rootCardId).toBe('job-1')
    expect(assets.find((item) => item.id === 'h2')?.rootCardId).toBe('t2')
  })

  it('同一张图出现在多个任务里只留一条', () => {
    const assets = buildAssetsFromTasks([
      task({ id: 't1', outputImages: ['h1'] }),
      task({ id: 't2', outputImages: ['h1'] }),
    ])
    expect(assets).toHaveLength(1)
  })
})

describe('mergeAssets 重新建档不能丢投放数据', () => {
  const scanned: AssetRecord[] = [
    { id: 'h1', taskId: 't1', rootCardId: 'job-1', platformIds: [], reportNames: [], createdAt: 100 },
    { id: 'h2', taskId: 't2', rootCardId: 'job-2', platformIds: [], reportNames: [], createdAt: 100 },
  ]

  it('已有素材的平台 ID、最后消耗日、血缘父级都保留', () => {
    const existing: AssetRecord[] = [
      {
        id: 'h1',
        taskId: 't1',
        rootCardId: 'job-1',
        platformIds: ['p1', 'p2'],
        reportNames: ['海报A'],
        createdAt: 1,
        lastSpendDate: '2026-11-03',
        firstSeenAt: 50,
        parentAssetId: 'h0',
        stageOverride: 'declining',
        note: '留着',
      },
    ]
    const merged = mergeAssets(existing, scanned)
    const h1 = merged.find((item) => item.id === 'h1')!
    // 这几项只可能来自导入或人工，重新建档时被清掉就等于丢历史
    expect(h1.platformIds).toEqual(['p1', 'p2'])
    expect(h1.lastSpendDate).toBe('2026-11-03')
    expect(h1.firstSeenAt).toBe(50)
    expect(h1.parentAssetId).toBe('h0')
    expect(h1.stageOverride).toBe('declining')
    expect(h1.note).toBe('留着')
  })

  it('新扫出来的素材会被补进来', () => {
    const merged = mergeAssets([], scanned)
    expect(merged).toHaveLength(2)
  })
})

describe('judgeStage 生命周期', () => {
  it('没有消耗 = 未投放', () => {
    expect(judgeStage({ totalSpend: 0, activeDays: 0 }, [], '2026-11-04')).toBe('created')
  })

  it('投放天数不足阈值时算投放中（数据不够判断趋势）', () => {
    const records = [spend({ id: 'a', date: '2026-11-03', spend: 100 })]
    expect(judgeStage({ totalSpend: 100, activeDays: 1, lastDate: '2026-11-03' }, records, '2026-11-04')).toBe('running')
  })

  it('最近明显掉量判衰退', () => {
    const records = [
      spend({ id: '1', date: '2026-10-26', spend: 1000 }),
      spend({ id: '2', date: '2026-10-27', spend: 1000 }),
      spend({ id: '3', date: '2026-10-28', spend: 1000 }),
      spend({ id: '4', date: '2026-10-29', spend: 100 }),
      spend({ id: '5', date: '2026-10-30', spend: 100 }),
      spend({ id: '6', date: '2026-10-31', spend: 100 }),
    ]
    const stage = judgeStage({ totalSpend: 3300, activeDays: 6, lastDate: '2026-10-31' }, records, '2026-11-01')
    expect(stage).toBe('declining')
  })

  it('投放稳定时不判衰退', () => {
    const records = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']
      .map((date, index) => spend({ id: String(index), date, spend: 500 }))
    expect(judgeStage({ totalSpend: 3000, activeDays: 6, lastDate: '2026-10-31' }, records, '2026-11-01')).toBe('running')
  })

  it('从 0 起量的新素材不该被判衰退', () => {
    const records = ['2026-10-29', '2026-10-30', '2026-10-31'].map((date, index) =>
      spend({ id: String(index), date, spend: 300 }))
    expect(judgeStage({ totalSpend: 900, activeDays: 3, lastDate: '2026-10-31' }, records, '2026-11-01')).toBe('running')
  })

  it('超过 staleDays 没消耗算已停投', () => {
    const last = '2026-10-01'
    const gap = LIFECYCLE_RULES.staleDays + 3
    const today = new Date(Date.parse(`${last}T00:00:00Z`) + gap * 86400000).toISOString().slice(0, 10)
    const records = [spend({ id: 'a', date: last, spend: 100 })]
    expect(judgeStage({ totalSpend: 100, activeDays: 1, lastDate: last }, records, today)).toBe('stale')
  })
})

describe('aggregateByAsset', () => {
  it('消耗求和、按天去重计数、日均按有消耗的天算', () => {
    const records = [
      spend({ id: '1', assetId: 'h1', date: '2026-11-01', spend: 100 }),
      spend({ id: '2', assetId: 'h1', date: '2026-11-01', spend: 50 }),
      spend({ id: '3', assetId: 'h1', date: '2026-11-02', spend: 150 }),
    ]
    const stats = aggregateByAsset(records, '2026-11-03').get('h1')!
    expect(stats.totalSpend).toBe(300)
    // 同一天两行只算一天
    expect(stats.activeDays).toBe(2)
    expect(stats.dailyAverage).toBe(150)
    expect(stats.firstDate).toBe('2026-11-01')
    expect(stats.lastDate).toBe('2026-11-02')
  })

  it('没匹配到素材的流水不参与按素材聚合', () => {
    const stats = aggregateByAsset([spend({ id: '1', date: '2026-11-01', spend: 100 })])
    expect(stats.size).toBe(0)
  })

  it('金额保留两位小数，不留浮点尾巴', () => {
    const records = [
      spend({ id: '1', assetId: 'h1', date: '2026-11-01', spend: 0.1 }),
      spend({ id: '2', assetId: 'h1', date: '2026-11-02', spend: 0.2 }),
    ]
    expect(aggregateByAsset(records).get('h1')!.totalSpend).toBe(0.3)
  })
})

describe('aggregateByDate', () => {
  it('按日期升序，并统计当天有消耗的素材数', () => {
    const rows = aggregateByDate([
      spend({ id: '1', assetId: 'h1', date: '2026-11-02', spend: 10 }),
      spend({ id: '2', assetId: 'h2', date: '2026-11-02', spend: 20 }),
      spend({ id: '3', assetId: 'h1', date: '2026-11-01', spend: 5 }),
    ])
    expect(rows.map((item) => item.date)).toEqual(['2026-11-01', '2026-11-02'])
    expect(rows[1].spend).toBe(30)
    expect(rows[1].assetCount).toBe(2)
  })
})

describe('aggregateByCard', () => {
  it('按血缘根汇总卡内素材消耗', () => {
    const assets: AssetRecord[] = [
      { id: 'h1', rootCardId: 'job-1', platformIds: [], reportNames: [], createdAt: 1 },
      { id: 'h2', rootCardId: 'job-1', platformIds: [], reportNames: [], createdAt: 1 },
      { id: 'h3', rootCardId: 'job-2', platformIds: [], reportNames: [], createdAt: 1 },
    ]
    const byAsset = aggregateByAsset([
      spend({ id: '1', assetId: 'h1', date: '2026-11-01', spend: 100 }),
      spend({ id: '2', assetId: 'h2', date: '2026-11-01', spend: 50 }),
    ])
    const byCard = aggregateByCard(assets, byAsset)
    expect(byCard.get('job-1')!.totalSpend).toBe(150)
    expect(byCard.get('job-1')!.assetCount).toBe(2)
    expect(byCard.get('job-1')!.activeAssetCount).toBe(2)
    // 没投放的卡也要出现，消耗为 0
    expect(byCard.get('job-2')!.totalSpend).toBe(0)
  })
})
