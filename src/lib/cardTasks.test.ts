import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { mergeCardTasks } from './cardTasks'
import { visibleOutputImages } from './taskState'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    prompt: 'p',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('mergeCardTasks 整卡摊平', () => {
  it('图按顺序全部摊平，原图与透明原图保持同样下标', () => {
    const a = task({ id: 'a', outputImages: ['o1'], sourceImages: ['s1'] })
    const b = task({ id: 'b', outputImages: ['o2', 'o3'], sourceImages: ['s2', ''] })
    const merged = mergeCardTasks([a, b])
    expect(merged.outputImages).toEqual(['o1', 'o2', 'o3'])
    expect(merged.sourceImages).toEqual(['s1', 's2', ''])
    expect(merged.transparentOriginalImages).toEqual(['', '', ''])
  })

  it('回收站标记记在兄弟任务上，也要合并过来（否则详情页移入回收站不生效）', () => {
    const a = task({ id: 'a', sopPromptIndex: 1, outputImages: ['o1'] })
    const b = task({ id: 'b', sopPromptIndex: 2, outputImages: ['o2'], trashedOutputImages: ['o2'] })
    const merged = mergeCardTasks([a, b])
    // 代表任务自己没有任何标记
    expect(a.trashedOutputImages).toBeUndefined()
    expect(merged.trashedOutputImages).toEqual(['o2'])
    // 真正决定详情页显不显示的那一步
    expect(visibleOutputImages(merged)).toEqual(['o1'])
  })

  it('多张分散在不同任务上的回收站标记一并合并', () => {
    const group = [
      task({ id: 'a', outputImages: ['o1'] }),
      task({ id: 'b', outputImages: ['o2'], trashedOutputImages: ['o2'] }),
      task({ id: 'c', outputImages: ['o3'], trashedOutputImages: ['o3'] }),
    ]
    expect(mergeCardTasks(group).trashedOutputImages).toEqual(['o2', 'o3'])
    expect(visibleOutputImages(mergeCardTasks(group))).toEqual(['o1'])
  })

  it('一张都没进回收站时给 undefined，不塞空数组', () => {
    const merged = mergeCardTasks([task({ outputImages: ['o1'] }), task({ id: 'b', outputImages: ['o2'] })])
    expect(merged.trashedOutputImages).toBeUndefined()
  })

  it('人工改判同样按整卡合并', () => {
    const group = [
      task({ id: 'a', outputImages: ['o1'] }),
      task({ id: 'b', outputImages: ['o2'], qcVerdicts: { o2: 'fail' } }),
    ]
    expect(mergeCardTasks(group).qcVerdicts).toEqual({ o2: 'fail' })
    expect(mergeCardTasks([task({ outputImages: ['o1'] })])).not.toHaveProperty('qcVerdicts', {})
  })

  it('提示词内容相同的只留一份', () => {
    const group = [
      task({ id: 'a', prompt: '同一段', outputImages: ['o1'] }),
      task({ id: 'b', prompt: '同一段', outputImages: ['o2'] }),
    ]
    expect(mergeCardTasks(group).prompt).toBe('同一段')
  })

  it('状态与耗时按整卡汇总', () => {
    const group = [
      task({ id: 'a', status: 'done', elapsed: 3 }),
      task({ id: 'b', status: 'running', elapsed: 2 }),
    ]
    expect(mergeCardTasks(group).status).toBe('running')
    expect(mergeCardTasks(group).elapsed).toBe(5)
    expect(mergeCardTasks([
      task({ id: 'x', status: 'error' }),
      task({ id: 'y', status: 'error' }),
    ]).status).toBe('error')
  })
})
