import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { generatingNodeIds, isAnyTaskGenerating, isTaskGenerating } from './generating'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    prompt: 'p',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
    ...overrides,
  }
}

describe('「正在生成」判定（要和任务卡上的转圈口径一致）', () => {
  it('running 算在跑', () => {
    expect(isTaskGenerating(task({ status: 'running' }))).toBe(true)
  })

  it('fal 断线重连中也算在跑（卡片上同样显示生成中）', () => {
    expect(isTaskGenerating(task({ status: 'error', falRecoverable: true }))).toBe(true)
  })

  it('自定义服务商断线重连中也算', () => {
    expect(isTaskGenerating(task({ status: 'error', customRecoverable: true }))).toBe(true)
  })

  it('普通失败不算（红点会一直挂着，误导人以为还在跑）', () => {
    expect(isTaskGenerating(task({ status: 'error' }))).toBe(false)
  })

  it('已完成不算', () => {
    expect(isTaskGenerating(task({ status: 'done', outputImages: ['img'] }))).toBe(false)
  })

  it('SOP 占位卡不算：还没拿到提示词，用户视角只是「准备中」', () => {
    expect(isTaskGenerating(task({ status: 'running', sopPlaceholder: true }))).toBe(false)
  })

  it('已删除的任务不算（回收站里的卡不该还亮着）', () => {
    expect(isTaskGenerating(task({ status: 'running', deletedAt: 1 }))).toBe(false)
  })
})

describe('一整张卡只要有在跑的就算', () => {
  it('SOP 卡多条任务，有一条在跑就亮', () => {
    expect(isAnyTaskGenerating([
      task({ id: 'a', status: 'done', outputImages: ['img'] }),
      task({ id: 'b', status: 'running' }),
    ])).toBe(true)
  })

  it('全都不在跑就不亮', () => {
    expect(isAnyTaskGenerating([
      task({ id: 'a', status: 'done', outputImages: ['img'] }),
      task({ id: 'b', status: 'error' }),
    ])).toBe(false)
  })

  it('空数组不亮', () => {
    expect(isAnyTaskGenerating([])).toBe(false)
  })
})

describe('节点集合要往上卷到祖先', () => {
  // 分类 cat-1 ← 产品 prod-a ← 方向 dir-a1
  const tree: Record<string, string[]> = {
    'dir-a1': ['prod-a', 'cat-1'],
    'dir-a2': ['prod-a', 'cat-1'],
  }
  const ancestorOf = (id: string) => tree[id] ?? []

  it('方向在跑时，方向 + 产品 + 分类都亮（折叠起来也能看出下面有东西在跑）', () => {
    const ids = generatingNodeIds([task({ sopDirectionId: 'dir-a1' })], ancestorOf)
    expect([...ids].sort()).toEqual(['cat-1', 'dir-a1', 'prod-a'])
  })

  it('只在有任务跑的层级点亮，没跑的方向不亮', () => {
    const ids = generatingNodeIds([task({ sopDirectionId: 'dir-a1' })], ancestorOf)
    expect(ids.has('dir-a2')).toBe(false)
  })

  it('没有归属的卡不点亮任何节点', () => {
    const ids = generatingNodeIds([task({ sopDirectionId: undefined })], ancestorOf)
    expect(ids.size).toBe(0)
  })

  it('同一个方向多张卡在跑，集合里只出现一次', () => {
    const ids = generatingNodeIds(
      [task({ id: 'x', sopDirectionId: 'dir-a1' }), task({ id: 'y', sopDirectionId: 'dir-a1' })],
      ancestorOf,
    )
    expect([...ids].sort()).toEqual(['cat-1', 'dir-a1', 'prod-a'])
  })

  it('已完成 / 失败的卡不点亮', () => {
    const ids = generatingNodeIds([
      task({ status: 'done', outputImages: ['img'], sopDirectionId: 'dir-a1' }),
      task({ status: 'error', sopDirectionId: 'dir-a2' }),
    ], ancestorOf)
    expect(ids.size).toBe(0)
  })

  it('祖先不认识时至少点亮方向自己', () => {
    const ids = generatingNodeIds([task({ sopDirectionId: 'unknown' })], () => [])
    expect([...ids]).toEqual(['unknown'])
  })
})
