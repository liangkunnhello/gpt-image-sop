import { describe, expect, it } from 'vitest'

import type { SopDirectionNode, TaskRecord } from '../types'
import {
  ALL_SCOPE,
  buildScopeRows,
  countCardsByNode,
  filterTasksByScope,
  nodeCheckState,
  scopeNodeIds,
  scopeSummary,
  subtreeCardCounts,
  toggleScopeNode,
} from './directionScope'

const nodes: SopDirectionNode[] = [
  { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
  { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
  { id: 'dir-1', parentId: 'prod-1', name: '月亮', kind: 'direction' },
  { id: 'dir-2', parentId: 'prod-1', name: '山景', kind: 'direction' },
  { id: 'prod-2', parentId: 'cat-1', name: '意外险', kind: 'product' },
  { id: 'dir-3', parentId: 'prod-2', name: '通勤', kind: 'direction' },
]

function task(id: string, directionId?: string, sopJobId?: string): TaskRecord {
  return {
    id,
    prompt: '',
    params: { size: 'auto', quality: 'auto', output_format: 'png', output_compression: null, moderation: 'auto', n: 1, transparent_output: false },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 0,
    finishedAt: 0,
    elapsed: 0,
    sopDirectionId: directionId,
    sopJobId,
  } as TaskRecord
}

describe('buildScopeRows', () => {
  it('按层级摊平，父在前子在后', () => {
    expect(buildScopeRows(nodes).map((row) => [row.id, row.depth])).toEqual([
      ['cat-1', 0],
      ['prod-1', 1],
      ['dir-1', 2],
      ['dir-2', 2],
      ['prod-2', 1],
      ['dir-3', 2],
    ])
  })

  it('已进回收站的节点不出现', () => {
    const withTrash = [...nodes, { id: 'dir-x', parentId: 'prod-1', name: '废弃', kind: 'direction' as const, deletedAt: 1 }]
    expect(buildScopeRows(withTrash).some((row) => row.id === 'dir-x')).toBe(false)
  })

  it('父级缺失的脏数据当根节点保留', () => {
    const broken = [{ id: 'dir-orphan', parentId: 'gone', name: '孤儿', kind: 'direction' as const }]
    expect(buildScopeRows(broken).map((row) => row.id)).toEqual(['dir-orphan'])
  })

  it('hasChildren 标记决定折叠箭头', () => {
    const rows = buildScopeRows(nodes)
    expect(rows.find((row) => row.id === 'dir-1')?.hasChildren).toBe(false)
    expect(rows.find((row) => row.id === 'prod-1')?.hasChildren).toBe(true)
  })
})

describe('scopeNodeIds', () => {
  it('勾产品带上全部方向', () => {
    expect([...scopeNodeIds(nodes, ['prod-1'])].sort()).toEqual(['dir-1', 'dir-2', 'prod-1'])
  })

  it('勾业务带上整棵树', () => {
    expect(scopeNodeIds(nodes, ['cat-1']).size).toBe(nodes.length)
  })

  it('空选择不展开', () => {
    expect(scopeNodeIds(nodes, []).size).toBe(0)
  })
})

describe('filterTasksByScope', () => {
  const tasks = [
    task('t1', 'dir-1'),
    task('t2', 'dir-2'),
    task('t3', 'dir-3'),
    task('t4'),
  ]

  it('全部范围原样返回', () => {
    expect(filterTasksByScope(tasks, nodes, ALL_SCOPE)).toHaveLength(4)
  })

  it('只留勾选方向下的任务', () => {
    const picked = filterTasksByScope(tasks, nodes, { all: false, ids: ['dir-1'], includeUnassigned: false })
    expect(picked.map((t) => t.id)).toEqual(['t1'])
  })

  it('勾产品等于勾它下面所有方向', () => {
    const picked = filterTasksByScope(tasks, nodes, { all: false, ids: ['prod-1'], includeUnassigned: false })
    expect(picked.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('未归属默认不带走，勾了才带上', () => {
    const without = filterTasksByScope(tasks, nodes, { all: false, ids: ['dir-1'], includeUnassigned: false })
    expect(without.some((t) => t.id === 't4')).toBe(false)
    const withUnassigned = filterTasksByScope(tasks, nodes, { all: false, ids: ['dir-1'], includeUnassigned: true })
    expect(withUnassigned.map((t) => t.id)).toEqual(['t1', 't4'])
  })

  it('方向被删后它的任务算未归属', () => {
    const trashed = nodes.map((node) => (node.id === 'dir-1' ? { ...node, deletedAt: 1 } : node))
    const picked = filterTasksByScope(tasks, trashed, { all: false, ids: ['prod-1'], includeUnassigned: false })
    expect(picked.map((t) => t.id)).toEqual(['t2'])
    const withUnassigned = filterTasksByScope(tasks, trashed, { all: false, ids: ['prod-1'], includeUnassigned: true })
    expect(withUnassigned.map((t) => t.id)).toEqual(['t1', 't2', 't4'])
  })
})

describe('countCardsByNode', () => {
  it('同一条 SOP 的多行任务只算一张卡', () => {
    const tasks = [task('t1', 'dir-1', 'job-1'), task('t2', 'dir-1', 'job-1'), task('t3', 'dir-2')]
    const counts = countCardsByNode(tasks, nodes)
    expect(counts.total).toBe(2)
    expect(counts.byNode['dir-1']).toBe(1)
    expect(counts.byNode['dir-2']).toBe(1)
  })

  it('未归属与指向已删方向的任务都计到未归属', () => {
    const trashed = nodes.map((node) => (node.id === 'dir-1' ? { ...node, deletedAt: 1 } : node))
    const counts = countCardsByNode([task('t1', 'dir-1'), task('t2'), task('t3', 'dir-2')], trashed)
    expect(counts.unassigned).toBe(2)
    expect(counts.byNode['dir-2']).toBe(1)
  })

  it('子树计数含子孙', () => {
    const counts = countCardsByNode([task('t1', 'dir-1'), task('t2', 'dir-2'), task('t3', 'dir-3')], nodes)
    const subtree = subtreeCardCounts(nodes, counts)
    expect(subtree['cat-1']).toBe(3)
    expect(subtree['prod-1']).toBe(2)
    expect(subtree['prod-2']).toBe(1)
  })
})

describe('勾选状态与切换', () => {
  it('勾满才算 all，部分勾是 some', () => {
    expect(nodeCheckState(nodes, ['dir-1', 'dir-2', 'prod-1'], 'prod-1')).toBe('all')
    expect(nodeCheckState(nodes, ['dir-1'], 'prod-1')).toBe('some')
    expect(nodeCheckState(nodes, [], 'prod-1')).toBe('none')
  })

  it('点一次补齐整枝，再点一次清空整枝', () => {
    const first = toggleScopeNode(nodes, [], 'prod-1')
    expect([...first].sort()).toEqual(['dir-1', 'dir-2', 'prod-1'])
    const second = toggleScopeNode(nodes, first, 'prod-1')
    expect(second).toEqual([])
  })

  it('部分勾选的产品点一下变全选', () => {
    const next = toggleScopeNode(nodes, ['dir-1'], 'prod-1')
    expect([...next].sort()).toEqual(['dir-1', 'dir-2', 'prod-1'])
  })
})

describe('scopeSummary', () => {
  it('全部范围有固定说法', () => {
    expect(scopeSummary(nodes, ALL_SCOPE)).toBe('全部业务方向')
  })

  it('勾了产品只说产品，不把其下方向重复列出', () => {
    expect(scopeSummary(nodes, { all: false, ids: ['prod-1', 'dir-1', 'dir-2'], includeUnassigned: false })).toBe('百万医疗险')
  })

  it('多于两项时截断', () => {
    const text = scopeSummary(nodes, { all: false, ids: ['dir-1', 'dir-2', 'dir-3'], includeUnassigned: false })
    expect(text).toContain('等 3 项')
  })

  it('含未归属时加后缀', () => {
    expect(scopeSummary(nodes, { all: false, ids: ['dir-1'], includeUnassigned: true })).toBe('月亮，含未归属')
  })

  it('只勾未归属', () => {
    expect(scopeSummary(nodes, { all: false, ids: [], includeUnassigned: true })).toBe('仅未归属')
  })
})
