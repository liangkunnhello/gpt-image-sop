import { describe, expect, it } from 'vitest'
import { isFilteringTreeNode, resolveTreeRowHighlight, resolveViewToggleHighlight } from './treeHighlight'
import { UNASSIGNED_FILTER } from './sopStore'

/**
 * 「全部任务」选中后，业务树不该还有节点亮着。
 *
 * 之前的 bug：activeFilterId 确实被清成 null 了，但 activeDirectionId
 * （默认归属）那个方向仍然涂着蓝色实底，用户点完「全部任务」
 * 看到「月亮」还是蓝的，以为没取消选中。
 *
 * 修法：蓝色实底只保留给「正在筛选这一行」（selected）；
 * 归属（current）改成蓝字 + 左侧竖条，不铺底色。两者不再撞车。
 */
describe('业务树高亮', () => {
  // cat-1 > prod-1 > dir-1 是当前归属那条链
  const currentPathIds = new Set(['cat-1', 'prod-1', 'dir-1'])
  const base = { activeDirectionId: 'dir-1', currentPathIds }

  it('全部任务：任何节点都没有实底，也没有归属蓝字', () => {
    for (const nodeId of ['cat-1', 'prod-1', 'dir-1']) {
      expect(resolveTreeRowHighlight({ ...base, nodeId, activeFilterId: null }))
        .toEqual({ selected: false, current: false, onPath: false })
    }
  })

  it('未归属视图：同样整棵树都不亮', () => {
    for (const nodeId of ['cat-1', 'prod-1', 'dir-1']) {
      expect(resolveTreeRowHighlight({ ...base, nodeId, activeFilterId: UNASSIGNED_FILTER }))
        .toEqual({ selected: false, current: false, onPath: false })
    }
  })

  it('按归属方向筛选时，那一行是实底，不再叠竖条', () => {
    const dirRow = resolveTreeRowHighlight({ ...base, nodeId: 'dir-1', activeFilterId: 'dir-1' })
    expect(dirRow.selected).toBe(true)
    expect(dirRow.current).toBe(false)
  })

  it('按祖先筛选时，归属行是蓝字 + 竖条，祖先行是实底', () => {
    const dirRow = resolveTreeRowHighlight({ ...base, nodeId: 'dir-1', activeFilterId: 'prod-1' })
    expect(dirRow).toEqual({ selected: false, current: true, onPath: false })

    const prodRow = resolveTreeRowHighlight({ ...base, nodeId: 'prod-1', activeFilterId: 'prod-1' })
    expect(prodRow.selected).toBe(true)
    expect(prodRow.current).toBe(false)
  })

  it('筛别的分支时，归属行保持蓝字竖条（归属本身没变）', () => {
    const dirRow = resolveTreeRowHighlight({ ...base, nodeId: 'dir-1', activeFilterId: 'dir-2' })
    // 归属没变，仍要能看出新图会归到哪
    expect(dirRow.current).toBe(true)
    expect(dirRow.selected).toBe(false)
    // 但它不在筛选的这条链上，不淡底
    expect(dirRow.onPath).toBe(false)
  })

  it('同一时间树里最多只有一行带实底', () => {
    for (const filterId of [null, UNASSIGNED_FILTER, 'cat-1', 'prod-1', 'dir-1', 'dir-2']) {
      const selectedRows = ['cat-1', 'prod-1', 'dir-1', 'dir-2']
        .map((nodeId) => ({ nodeId, hl: resolveTreeRowHighlight({ ...base, nodeId, activeFilterId: filterId }) }))
        .filter((row) => row.hl.selected)
      expect(selectedRows.length).toBeLessThanOrEqual(1)
    }
  })

  it('只有真正筛业务节点才算「在筛选」', () => {
    expect(isFilteringTreeNode(null)).toBe(false)
    expect(isFilteringTreeNode(UNASSIGNED_FILTER)).toBe(false)
    expect(isFilteringTreeNode('dir-1')).toBe(true)
  })

  it('全部任务 / 未归属的视图开关只区分选中态', () => {
    expect(resolveViewToggleHighlight(true)).toEqual({ selected: true, current: false, onPath: false })
    expect(resolveViewToggleHighlight(false)).toEqual({ selected: false, current: false, onPath: false })
  })
})
