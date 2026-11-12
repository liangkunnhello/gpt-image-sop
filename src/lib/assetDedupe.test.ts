import { describe, expect, it, vi } from 'vitest'

import { groupAssetsByContent, planDuplicateHashes, remapSpendAssetIds } from './assetDedupe'

describe('识别同图多份', () => {
  it('字节数相同、内容相同 → 两条都记同一个哈希', async () => {
    const compute = vi.fn(async (id: string) => (id === 'a' || id === 'b' ? 'hash-1' : undefined))
    const plan = await planDuplicateHashes(
      [{ id: 'asset-a', imageId: 'a' }, { id: 'asset-b', imageId: 'b' }],
      new Map([['a', 100], ['b', 100]]),
      compute,
    )
    expect(plan.hashById.get('asset-a')).toBe('hash-1')
    expect(plan.hashById.get('asset-b')).toBe('hash-1')
    // 两条都要写回，否则下次还得再算
    expect(plan.updates.map((item) => item.assetId).sort()).toEqual(['asset-a', 'asset-b'])
  })

  it('字节数相同但内容不同（同尺寸的两张不同图）不算重复', async () => {
    const compute = vi.fn(async (id: string) => (id === 'a' ? 'hash-a' : 'hash-b'))
    const plan = await planDuplicateHashes(
      [{ id: 'asset-a', imageId: 'a' }, { id: 'asset-b', imageId: 'b' }],
      new Map([['a', 100], ['b', 100]]),
      compute,
    )
    expect(plan.hashById.size).toBe(0)
    expect(plan.updates).toEqual([])
  })

  it('字节数不同直接跳过，不读文件', async () => {
    const compute = vi.fn(async () => 'hash-1')
    await planDuplicateHashes(
      [{ id: 'asset-a', imageId: 'a' }, { id: 'asset-b', imageId: 'b' }],
      new Map([['a', 100], ['b', 200]]),
      compute,
    )
    expect(compute).not.toHaveBeenCalled()
  })

  it('已经写过 contentHash 的素材不再重算', async () => {
    const compute = vi.fn(async () => 'hash-new')
    const plan = await planDuplicateHashes(
      [{ id: 'asset-a', imageId: 'a', contentHash: 'hash-old' }, { id: 'asset-b', imageId: 'b', contentHash: 'hash-old' }],
      new Map([['a', 100], ['b', 100]]),
      compute,
    )
    expect(compute).not.toHaveBeenCalled()
    expect(plan.hashById.get('asset-a')).toBe('hash-old')
    expect(plan.hashById.get('asset-b')).toBe('hash-old')
    expect(plan.updates).toEqual([])
  })
})

describe('消耗按内容哈希归并', () => {
  it('把重复素材的消耗改指到同一个键', () => {
    const records = [{ assetId: 'asset-a', spend: 1 }, { assetId: 'asset-b', spend: 2 }, { assetId: 'asset-c', spend: 3 }]
    const remapped = remapSpendAssetIds(records, new Map([['asset-a', 'hash-1'], ['asset-b', 'hash-1']]))
    expect(remapped.map((item) => item.assetId)).toEqual(['hash-1', 'hash-1', 'asset-c'])
  })

  it('没有重复时不复制数组', () => {
    const records = [{ assetId: 'asset-a', spend: 1 }]
    expect(remapSpendAssetIds(records, new Map())).toBe(records)
  })
})

describe('台账按内容分组', () => {
  const hashById = new Map([['asset-a', 'hash-1'], ['asset-b', 'hash-1']])

  it('同图多条合成一组，平台 ID 与报表名取并集', () => {
    const groups = groupAssetsByContent([
      { id: 'asset-a', platformIds: ['1', '2'], reportNames: ['名字A'] },
      { id: 'asset-b', platformIds: ['2', '3'], reportNames: ['名字B'] },
      { id: 'asset-c', platformIds: ['9'], reportNames: [] },
    ], hashById)
    expect(groups).toHaveLength(2)
    const merged = groups.find((item) => item.key === 'hash-1')!
    expect(merged.members.map((item) => item.id)).toEqual(['asset-a', 'asset-b'])
    expect(merged.asset.platformIds).toEqual(['1', '2', '3'])
    expect(merged.asset.reportNames).toEqual(['名字A', '名字B'])
    // 代表仍是第一条，缩略图/任务卡沿用它的
    expect(merged.asset.id).toBe('asset-a')
  })

  it('没有重复的素材各自一组', () => {
    const groups = groupAssetsByContent([{ id: 'asset-c', platformIds: [], reportNames: [] }], hashById)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('asset-c')
  })
})
