import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { groupSopTasks } from './sopGroup'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    prompt: 'p',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('卡片聚合', () => {
  it('同卡的图回收标记按整组合并，兄弟任务里的图也能从展示里排掉', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, outputImages: ['img-a'], createdAt: 3 })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, outputImages: ['img-b'], trashedOutputImages: ['img-b'], createdAt: 2 })
    const [card] = groupSopTasks([a, b])
    expect(card.outputImages).toEqual(['img-a', 'img-b'])
    expect(card.trashedOutputImages).toEqual(['img-b'])
  })

  it('人工改判同样按整组合并', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, outputImages: ['img-a'], createdAt: 3 })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, outputImages: ['img-b'], qcVerdicts: { 'img-b': 'fail' }, createdAt: 2 })
    const [card] = groupSopTasks([a, b])
    expect(card.qcVerdicts).toEqual({ 'img-b': 'fail' })
  })

  it('没有回收图时不带这个字段，保持老数据形状', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, outputImages: ['img-a'] })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, outputImages: ['img-b'] })
    const [card] = groupSopTasks([a, b])
    expect(card.trashedOutputImages).toBeUndefined()
    expect(card.qcVerdicts).toBeUndefined()
  })
})
