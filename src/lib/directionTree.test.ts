import { beforeEach, describe, expect, it } from 'vitest'

import { effectiveNodeKind } from './directionTree'
import { useSopStore } from './sopStore'

/** 每个用例都从一棵干净的三级树开始 */
const reset = () => {
  useSopStore.setState({
    directions: [
      { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
      { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
      { id: 'dir-1', parentId: 'prod-1', name: '月亮', kind: 'direction' },
      { id: 'dir-2', parentId: 'prod-1', name: '图标', kind: 'direction' },
      { id: 'cat-2', parentId: null, name: 'APP', kind: 'category' },
      { id: 'prod-2', parentId: 'cat-2', name: '快手', kind: 'product' },
      { id: 'dir-3', parentId: 'prod-2', name: '网赚', kind: 'direction' },
    ],
    activeDirectionId: 'dir-1',
    activeFilterId: null,
  })
}

const node = (id: string) => useSopStore.getState().directions.find((item) => item.id === id)

describe('节点新增', () => {
  beforeEach(reset)

  it('可以在指定父级下建任意层级', () => {
    const id = useSopStore.getState().addNode('cat-2', '新方向', 'direction')
    expect(node(id)).toMatchObject({ parentId: 'cat-2', name: '新方向', kind: 'direction' })
  })

  it('可以建顶层类目', () => {
    const id = useSopStore.getState().addNode(null, '新业务线', 'category')
    expect(node(id)).toMatchObject({ parentId: null, kind: 'category' })
  })
})

describe('节点实际身份按层级算', () => {
  const nodes = [
    { id: 'c1', parentId: null, kind: 'category' as const },
    { id: 'p1', parentId: 'c1', kind: 'product' as const },
    { id: 'd1', parentId: 'p1', kind: 'direction' as const },
    { id: 'd2', parentId: 'd1', kind: 'direction' as const },
    // 老数据：挂在类目下的产品被记成了 direction
    { id: 'p-legacy', parentId: 'c1', kind: 'direction' as const },
  ]

  it('顶层是类目、第二层是产品、更深都是方向', () => {
    expect(effectiveNodeKind(nodes, 'c1')).toBe('category')
    expect(effectiveNodeKind(nodes, 'p1')).toBe('product')
    expect(effectiveNodeKind(nodes, 'd1')).toBe('direction')
    expect(effectiveNodeKind(nodes, 'd2')).toBe('direction')
  })

  it('kind 写错时以层级为准，保证右键能新建方向', () => {
    expect(effectiveNodeKind(nodes, 'p-legacy')).toBe('product')
  })

  it('找不到节点时不会崩', () => {
    expect(effectiveNodeKind(nodes, 'missing')).toBe('category')
  })
})

describe('节点伪删除', () => {
  beforeEach(reset)

  it('删产品时子孙一起进回收站，共用同一个批次', () => {
    const batchId = useSopStore.getState().trashNode('prod-1')
    const ids = ['prod-1', 'dir-1', 'dir-2']
    for (const id of ids) {
      expect(node(id)?.deletedAt).toBeTruthy()
      expect(node(id)?.trashBatchId).toBe(batchId)
    }
    // 不相关的分支没被动
    expect(node('prod-2')?.deletedAt).toBeUndefined()
  })

  it('删除只是打标记，节点本身还在数组里（图片引用不会断）', () => {
    useSopStore.getState().trashNode('dir-1')
    expect(useSopStore.getState().directions.some((item) => item.id === 'dir-1')).toBe(true)
  })

  it('activeNodes / trashedNodes 正确分流', () => {
    useSopStore.getState().trashNode('dir-1')
    const active = useSopStore.getState().activeNodes().map((item) => item.id)
    const trashed = useSopStore.getState().trashedNodes().map((item) => item.id)
    expect(active).not.toContain('dir-1')
    expect(trashed).toContain('dir-1')
  })

  it('删掉正在筛选的节点时，筛选退回全部', () => {
    useSopStore.setState({ activeFilterId: 'dir-1' })
    useSopStore.getState().trashNode('dir-1')
    expect(useSopStore.getState().activeFilterId).toBeNull()
  })

  it('删掉当前归属时，归属换到另一个活着的方向', () => {
    useSopStore.setState({ activeDirectionId: 'dir-1' })
    useSopStore.getState().trashNode('dir-1')
    const next = useSopStore.getState().activeDirectionId
    expect(next).not.toBe('dir-1')
    expect(node(next)?.deletedAt).toBeUndefined()
  })

  it('removeNode 现在也走伪删除，不再物理删', () => {
    useSopStore.getState().removeNode('dir-1')
    expect(node('dir-1')?.deletedAt).toBeTruthy()
    expect(useSopStore.getState().directions).toHaveLength(7)
  })
})

describe('回收站恢复与清空', () => {
  beforeEach(reset)

  it('按批次恢复，原来的父子关系保留', () => {
    const batchId = useSopStore.getState().trashNode('prod-1')
    useSopStore.getState().restoreTrashBatch(batchId)
    expect(node('prod-1')?.deletedAt).toBeUndefined()
    expect(node('dir-1')?.deletedAt).toBeUndefined()
    expect(node('dir-1')?.parentId).toBe('prod-1')
  })

  it('原父级已被彻底删掉时，恢复后挂回顶层', () => {
    const batchId = useSopStore.getState().trashNode('dir-1')
    // 产品在这一批之外被彻底删掉
    useSopStore.setState((state) => ({
      directions: state.directions.filter((item) => item.id !== 'prod-1'),
    }))
    useSopStore.getState().restoreTrashBatch(batchId)
    expect(node('dir-1')?.parentId).toBeNull()
  })

  it('彻底删除批次后才真正从数组里消失', () => {
    const batchId = useSopStore.getState().trashNode('prod-1')
    useSopStore.getState().purgeTrashBatch(batchId)
    expect(node('prod-1')).toBeUndefined()
    expect(node('dir-1')).toBeUndefined()
    expect(node('dir-2')).toBeUndefined()
  })

  it('清空回收站把所有已删节点一次清掉，活着的保留', () => {
    useSopStore.getState().trashNode('prod-1')
    useSopStore.getState().trashNode('prod-2')
    useSopStore.getState().purgeAllTrash()
    const ids = useSopStore.getState().directions.map((item) => item.id)
    expect(ids).toEqual(['cat-1', 'cat-2'])
  })
})

describe('移动节点', () => {
  beforeEach(reset)

  it('方向可以从一个产品移到另一个产品', () => {
    const error = useSopStore.getState().moveNode('dir-1', 'prod-2')
    expect(error).toBe('')
    expect(node('dir-1')?.parentId).toBe('prod-2')
  })

  it('方向不能挂到类目下', () => {
    expect(useSopStore.getState().moveNode('dir-1', 'cat-1')).toBe('方向只能放在产品下')
    expect(node('dir-1')?.parentId).toBe('prod-1')
  })

  it('产品不能挂到产品下', () => {
    expect(useSopStore.getState().moveNode('prod-1', 'prod-2')).toBe('产品只能放在类目下')
  })

  it('类目只能放在顶层', () => {
    expect(useSopStore.getState().moveNode('cat-1', 'cat-2')).toBe('类目只能放在最顶层')
  })

  it('不能移动到自身', () => {
    expect(useSopStore.getState().moveNode('prod-1', 'prod-1')).toBe('不能移动到自身下面')
  })

  it('不能移动到自己的子节点下', () => {
    useSopStore.setState({ activeDirectionId: 'dir-1' })
    // 类目 → 它自己是产品，这里用挪到子孙来触发
    expect(useSopStore.getState().moveNode('cat-1', 'prod-1')).toBe('类目只能放在最顶层')
    expect(useSopStore.getState().moveNode('prod-1', 'dir-1')).toBe('产品只能放在类目下')
  })

  it('目标不存在时报错', () => {
    expect(useSopStore.getState().moveNode('dir-1', 'prod-missing')).toBe('目标节点不存在')
  })

  it('移到原位不算改动，也不报错', () => {
    expect(useSopStore.getState().moveNode('dir-1', 'prod-1')).toBe('')
  })

  it('不能移到已删除的节点下', () => {
    useSopStore.getState().trashNode('prod-2')
    expect(useSopStore.getState().moveNode('dir-1', 'prod-2')).toBe('目标节点不存在')
  })
})

describe('重命名', () => {
  beforeEach(reset)

  it('改名生效', () => {
    useSopStore.getState().renameNode('dir-1', '新月')
    expect(node('dir-1')?.name).toBe('新月')
  })

  it('空名不生效', () => {
    useSopStore.getState().renameNode('dir-1', '   ')
    expect(node('dir-1')?.name).toBe('月亮')
  })
})
