import { describe, expect, it } from 'vitest'
import type { AssetRecord, SpendRecord } from './trackDb'
import type { SopDirectionNode, TaskRecord } from '../types'
import {
  UNASSIGNED_NODE_ID,
  buildProductTree,
  filterSpendByAssets,
  filterSpendByRange,
  findTreeNode,
  inRange,
  presetRange,
  rangeLabel,
  scopeAssetsForNode,
  shiftDate,
  todayString,
} from './trackerFilter'

function dir(id: string, name: string, kind: SopDirectionNode['kind'], parentId: string | null = null): SopDirectionNode {
  return { id, name, kind, parentId }
}

function task(id: string, sopDirectionId?: string): TaskRecord {
  return { id, sopDirectionId } as TaskRecord
}

function asset(id: string, taskId?: string): AssetRecord {
  return { id, taskId, platformIds: [], reportNames: [], createdAt: 0 }
}

function spend(id: string, date: string, assetId?: string): SpendRecord {
  return { id, platformId: `pid-${id}`, assetId, date, spend: 10, importId: 'imp' }
}

const directions: SopDirectionNode[] = [
  dir('cat1', '医疗险业务线', 'category'),
  dir('p1', '百万医疗险', 'product', 'cat1'),
  dir('d1', '大图', 'direction', 'p1'),
  dir('d2', '小图', 'direction', 'p1'),
  dir('p2', '重疾险', 'product', 'cat1'),
  dir('d3', '长图', 'direction', 'p2'),
  dir('cat2', '车险业务线', 'category'),
  dir('p3', '车险', 'product', 'cat2'),
  dir('d4', '海报', 'direction', 'p3'),
]

describe('todayString / shiftDate', () => {
  it('用本地时区取今天，不会因 UTC 差一天', () => {
    // 本地时间 11-05 00:30 时，UTC 还是 11-04
    const local = new Date(2026, 10, 5, 0, 30)
    expect(todayString(local)).toBe('2026-11-05')
  })

  it('跨月、跨年都算得对', () => {
    expect(shiftDate('2026-11-05', -6)).toBe('2026-10-30')
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01')
  })
})

describe('presetRange', () => {
  it('近 7 天含今天（与平台后台口径一致）', () => {
    expect(presetRange('7d', '2026-11-05')).toEqual({ from: '2026-10-30', to: '2026-11-05' })
  })

  it('近 30 天含今天', () => {
    expect(presetRange('30d', '2026-11-05')).toEqual({ from: '2026-10-07', to: '2026-11-05' })
  })

  it('今天 / 全部', () => {
    expect(presetRange('today', '2026-11-05')).toEqual({ from: '2026-11-05', to: '2026-11-05' })
    expect(presetRange('all', '2026-11-05')).toEqual({ from: '', to: '' })
  })
})

describe('inRange / filterSpendByRange', () => {
  it('两端都包含', () => {
    const range = { from: '2026-11-01', to: '2026-11-03' }
    expect(inRange('2026-11-01', range)).toBe(true)
    expect(inRange('2026-11-03', range)).toBe(true)
    expect(inRange('2026-10-31', range)).toBe(false)
    expect(inRange('2026-11-04', range)).toBe(false)
  })

  it('只填一端时另一端不限', () => {
    expect(inRange('2020-01-01', { from: '2026-01-01', to: '' })).toBe(false)
    expect(inRange('2030-01-01', { from: '2026-01-01', to: '' })).toBe(true)
    expect(inRange('2020-01-01', { from: '', to: '2026-01-01' })).toBe(true)
  })

  it('不限时原样返回，不做无意义的复制', () => {
    const list = [spend('1', '2026-11-01')]
    expect(filterSpendByRange(list, { from: '', to: '' })).toBe(list)
  })

  it('区间筛选真的过滤', () => {
    const list = [spend('1', '2026-10-31'), spend('2', '2026-11-02'), spend('3', '2026-11-05')]
    const kept = filterSpendByRange(list, { from: '2026-11-01', to: '2026-11-04' })
    expect(kept.map((item) => item.id)).toEqual(['2'])
  })
})

describe('buildProductTree', () => {
  const tasks = [
    task('t1', 'd1'),
    task('t2', 'd1'),
    task('t3', 'd3'),
    task('t4', 'd4'),
    task('t5'), // 没归属
  ]

  it('按 业务线 → 产品 → 方向 三层搭起来', () => {
    const tree = buildProductTree(directions, tasks)
    const cat = tree.find((node) => node.id === 'cat1')
    expect(cat?.children.map((node) => node.id)).toEqual(['p1', 'p2'])
    expect(cat?.children[0].children.map((node) => node.id)).toEqual(['d1', 'd2'])
  })

  it('计数向上汇总：业务线 = 旗下所有方向的卡数', () => {
    const tree = buildProductTree(directions, tasks)
    const cat = findTreeNode(tree, 'cat1')
    expect(cat?.taskCount).toBe(3) // d1 两张 + d3 一张
    expect(findTreeNode(tree, 'p1')?.taskCount).toBe(2)
    expect(findTreeNode(tree, 'p2')?.taskCount).toBe(1)
    expect(findTreeNode(tree, 'd2')?.taskCount).toBe(0)
  })

  it('没归属方向（或方向已删）的卡进「未归属」节点', () => {
    const tree = buildProductTree(directions, [...tasks, task('t6', 'deleted-dir')])
    const unassigned = tree.find((node) => node.id === UNASSIGNED_NODE_ID)
    expect(unassigned?.taskCount).toBe(2)
  })

  it('回收站里的方向节点不进树', () => {
    const withTrash = [...directions, { ...dir('p9', '已删产品', 'product', 'cat1'), deletedAt: 1 }]
    const tree = buildProductTree(withTrash, tasks)
    expect(findTreeNode(tree, 'p9')).toBeNull()
  })

  it('「未归属」排在最前（演示数据和早期没挂方向的卡都在这，排最后找不到）', () => {
    const tree = buildProductTree(directions, tasks)
    expect(tree[0].id).toBe(UNASSIGNED_NODE_ID)
  })

  it('没有任何未归属时不加「未归属」节点', () => {
    const tree = buildProductTree(directions, [task('t1', 'd1')])
    expect(tree.find((node) => node.id === UNASSIGNED_NODE_ID)).toBeUndefined()
  })
})

describe('scopeAssetsForNode 按素材判归属', () => {
  const tasks = [
    task('t1', 'd1'),
    task('t2', 'd2'),
    task('t3', 'd3'),
    task('t4', 'd4'),
    task('t5'),
  ]
  const tree = buildProductTree(directions, tasks)
  // a1/a2 在 d1 下；a5 的卡没方向；a9 的卡根本不存在（演示数据/老数据）
  const assets = [
    asset('a1', 't1'),
    asset('a2', 't2'),
    asset('a5', 't5'),
    asset('a9', '不存在的卡'),
    asset('a0'),
  ]

  it('没选节点时原样返回（不限）', () => {
    expect(scopeAssetsForNode(assets, tasks, directions, tree, null)).toBe(assets)
  })

  it('选方向只拿到该方向的素材', () => {
    expect(scopeAssetsForNode(assets, tasks, directions, tree, 'd1').map((item) => item.id)).toEqual(['a1'])
  })

  it('选产品拿到旗下所有方向的素材', () => {
    expect(scopeAssetsForNode(assets, tasks, directions, tree, 'p1').map((item) => item.id).sort()).toEqual(['a1', 'a2'])
  })

  it('选业务线拿到整条线', () => {
    expect(scopeAssetsForNode(assets, tasks, directions, tree, 'cat1').map((item) => item.id).sort())
      .toEqual(['a1', 'a2'])
  })

  it('「未归属」包含没方向的、以及任务卡已不存在的素材', () => {
    expect(scopeAssetsForNode(assets, tasks, directions, tree, UNASSIGNED_NODE_ID).map((item) => item.id).sort())
      .toEqual(['a0', 'a5', 'a9'])
  })

  it('任务卡已删的素材不能被算进任何方向（否则数字对不上）', () => {
    const withDeleted = [asset('aX', 'deleted-task')]
    expect(scopeAssetsForNode(withDeleted, tasks, directions, tree, 'd1')).toEqual([])
    expect(scopeAssetsForNode(withDeleted, tasks, directions, tree, UNASSIGNED_NODE_ID)).toHaveLength(1)
  })
})

describe('filterSpendByAssets 只保留被筛中素材的流水', () => {
  it('流水只保留被筛中素材的，未匹配流水不混进合计', () => {
    const assets = [asset('a', 't1')]
    const list = [spend('1', '2026-11-01', 'a'), spend('2', '2026-11-01', 'other'), spend('3', '2026-11-01')]
    expect(filterSpendByAssets(list, assets).map((item) => item.id)).toEqual(['1'])
  })

  it('素材为空时流水也清空（避免列表 0 张图、合计却有钱）', () => {
    expect(filterSpendByAssets([spend('1', '2026-11-01', 'a')], [])).toEqual([])
  })
})

describe('rangeLabel', () => {
  it('能读成一句人话', () => {
    expect(rangeLabel({ from: '', to: '' })).toBe('全部时间')
    expect(rangeLabel({ from: '2026-11-05', to: '2026-11-05' })).toBe('2026-11-05')
    expect(rangeLabel({ from: '2026-10-30', to: '2026-11-05' })).toBe('2026-10-30 ~ 2026-11-05')
  })
})
