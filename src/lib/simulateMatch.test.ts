import { describe, expect, it } from 'vitest'
import type { AssetRecord, SpendRecord } from './trackDb'
import { countSimulated, planRestoreMatches, planSimulateMatches } from './simulateMatch'

function asset(id: string, platformIds: string[] = []): AssetRecord {
  return { id, platformIds, reportNames: [], createdAt: 0 }
}

function spend(id: string, platformId: string, spendValue: number, assetId?: string): SpendRecord {
  return {
    id,
    platformId,
    assetId,
    date: '2026-11-03',
    spend: spendValue,
    importId: 'imp-1',
  }
}

describe('planSimulateMatches 模拟关联', () => {
  it('未匹配的流水全部挂到本地素材上', () => {
    const assets = [asset('hash-a'), asset('hash-b')]
    const spendList = [
      spend('1', 'pid-1', 100),
      spend('2', 'pid-1', 50),
      spend('3', 'pid-2', 80),
    ]
    const plan = planSimulateMatches(spendList, assets)

    expect(plan.linkedRecords).toBe(3)
    expect(plan.linkedPlatforms).toBe(2)
    expect(plan.spend.every((item) => Boolean(item.assetId))).toBe(true)
    expect(plan.spend.every((item) => item.simulated === true)).toBe(true)
  })

  it('真匹配过的流水一个字都不动（不能覆盖真结果）', () => {
    const assets = [asset('hash-a'), asset('hash-b')]
    const spendList = [
      spend('1', 'pid-real', 100, 'hash-a'),
      spend('2', 'pid-new', 80),
    ]
    const plan = planSimulateMatches(spendList, assets)

    expect(plan.spend).toHaveLength(1)
    expect(plan.spend[0].id).toBe('2')
  })

  it('素材已有同一平台 ID 时不重复追加', () => {
    const assets = [asset('hash-a', ['pid-1'])]
    const plan = planSimulateMatches([spend('1', 'pid-1', 100)], assets)
    expect(plan.assets[0].platformIds).toEqual(['pid-1'])
  })

  it('优先挂到真实素材，避免指向上会被清除的演示素材', () => {
    const assets = [asset('demo-img-x'), asset('hash-real')]
    const plan = planSimulateMatches([spend('1', 'pid-1', 10)], assets)
    expect(plan.spend[0].assetId).toBe('hash-real')
  })

  it('一个真实素材都没有时才用演示素材', () => {
    const assets = [asset('demo-img-x')]
    const plan = planSimulateMatches([spend('1', 'pid-1', 10)], assets)
    expect(plan.spend[0].assetId).toBe('demo-img-x')
  })

  it('没有素材时返回空计划，不抛错', () => {
    const plan = planSimulateMatches([spend('1', 'pid-1', 10)], [])
    expect(plan.linkedRecords).toBe(0)
    expect(plan.spend).toEqual([])
    expect(plan.usedAssets).toBe(0)
  })

  it('全部已匹配时返回空计划', () => {
    const plan = planSimulateMatches([spend('1', 'pid-1', 10, 'hash-a')], [asset('hash-a')])
    expect(plan.linkedRecords).toBe(0)
  })
})

describe('planRestoreMatches 还原模拟关联', () => {
  it('模拟记录退回未匹配，标记被清掉', () => {
    const restored = planRestoreMatches(
      [{ ...spend('1', 'pid-1', 10), assetId: 'hash-a', simulated: true }],
      [asset('hash-a', ['pid-1'])],
    )
    expect(restored.spend[0].assetId).toBeUndefined()
    expect(restored.spend[0].simulated).toBeUndefined()
    expect(restored.assets[0].platformIds).toEqual([])
  })

  it('真匹配的记录不会被还原波及', () => {
    const restored = planRestoreMatches(
      [
        spend('1', 'pid-real', 100, 'hash-a'),
        { ...spend('2', 'pid-sim', 10), assetId: 'hash-b', simulated: true },
      ],
      [asset('hash-a', ['pid-real']), asset('hash-b', ['pid-sim'])],
    )
    expect(restored.spend).toHaveLength(1)
    expect(restored.spend[0].id).toBe('2')
    // hash-a 的平台 ID 原样保留
    expect(restored.assets.find((item) => item.id === 'hash-a')).toBeUndefined()
  })

  it('同一平台 ID 也被真记录引用时，不从素材上摘掉', () => {
    const restored = planRestoreMatches(
      [
        spend('1', 'pid-1', 100, 'hash-a'),
        { ...spend('2', 'pid-1', 10), assetId: 'hash-a', simulated: true },
      ],
      [asset('hash-a', ['pid-1'])],
    )
    expect(restored.assets[0].platformIds).toEqual(['pid-1'])
  })

  it('没有模拟记录时返回空计划', () => {
    expect(planRestoreMatches([spend('1', 'pid-1', 10, 'hash-a')], [asset('hash-a')]).spend).toEqual([])
  })
})

describe('countSimulated', () => {
  it('只数模拟记录', () => {
    expect(countSimulated([
      { ...spend('1', 'pid-1', 10), assetId: 'a', simulated: true },
      spend('2', 'pid-2', 10, 'b'),
      spend('3', 'pid-3', 10),
    ])).toBe(1)
  })
})
