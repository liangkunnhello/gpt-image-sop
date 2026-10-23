import { beforeEach, describe, expect, it } from 'vitest'

import { UNASSIGNED_FILTER, useSopStore } from './sopStore'

const tree = [
  { id: 'cat-1', parentId: null, name: '保险', kind: 'category' as const },
  { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' as const },
  { id: 'dir-1', parentId: 'prod-1', name: '图标', kind: 'direction' as const },
  { id: 'dir-2', parentId: 'prod-1', name: '月亮', kind: 'direction' as const },
]

describe('点「全部任务」时的归属', () => {
  beforeEach(() => {
    useSopStore.setState({ directions: tree, activeFilterId: 'dir-2', activeDirectionId: 'dir-2' })
  })

  it('点全部任务后归属清空，新图进未归属', () => {
    useSopStore.getState().setActiveFilter(null)
    expect(useSopStore.getState().activeFilterId).toBeNull()
    expect(useSopStore.getState().activeDirectionId).toBe('')
  })

  it('点未归属同样清空归属', () => {
    useSopStore.getState().setActiveFilter(UNASSIGNED_FILTER)
    expect(useSopStore.getState().activeFilterId).toBe(UNASSIGNED_FILTER)
    expect(useSopStore.getState().activeDirectionId).toBe('')
  })

  it('点方向节点归到该方向', () => {
    useSopStore.getState().setActiveFilter('dir-1')
    expect(useSopStore.getState().activeFilterId).toBe('dir-1')
    expect(useSopStore.getState().activeDirectionId).toBe('dir-1')
  })

  it('点产品归到产品自己（产品也能挂任务卡）', () => {
    useSopStore.getState().setActiveFilter('prod-1')
    expect(useSopStore.getState().activeDirectionId).toBe('prod-1')
  })

  it('点顶层类目只筛选，不覆盖已有归属', () => {
    // 类目只是分组容器，归不到它上面；但用户只是在看这个类目，之前的归属不该丢
    useSopStore.getState().setActiveFilter('cat-1')
    expect(useSopStore.getState().activeFilterId).toBe('cat-1')
    expect(useSopStore.getState().activeDirectionId).toBe('dir-2')
  })

  it('归属清空后再点具体方向能恢复', () => {
    useSopStore.getState().setActiveFilter(null)
    useSopStore.getState().setActiveFilter('dir-2')
    expect(useSopStore.getState().activeDirectionId).toBe('dir-2')
  })
})
