import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { deliverableOutputImages } from './deliver'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
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

describe('交付时挑哪些图', () => {
  it('回收站里的不交付', () => {
    const target = task({ outputImages: ['a', 'b', 'c'], trashedOutputImages: ['b'] })
    expect(deliverableOutputImages(target)).toEqual(['a', 'c'])
  })

  it('人工改判为不合格的不交付', () => {
    const target = task({ outputImages: ['a', 'b', 'c'], qcVerdicts: { b: 'fail', c: 'pass' } })
    expect(deliverableOutputImages(target)).toEqual(['a', 'c'])
  })

  it('调用方传进来的排除集合（自动质检不合格）生效', () => {
    const target = task({ outputImages: ['a', 'b'] })
    expect(deliverableOutputImages(target, new Set(['a']))).toEqual(['b'])
  })

  it('人工改判成合格的照常交付，哪怕自动质检判了不合格', () => {
    // 自动结论通过 exclude 传进来，人工改判优先
    const target = task({ outputImages: ['a', 'b'], qcVerdicts: { a: 'pass' } })
    expect(deliverableOutputImages(target, new Set())).toEqual(['a', 'b'])
    // 但人工判不合格的，即使不在排除集合里也不交
    const repaired = task({ outputImages: ['a', 'b'], qcVerdicts: { a: 'fail' } })
    expect(deliverableOutputImages(repaired, new Set())).toEqual(['b'])
  })

  it('空 id 与全被排除时返回空数组', () => {
    expect(deliverableOutputImages(task({ outputImages: ['', 'a'] }))).toEqual(['a'])
    expect(deliverableOutputImages(task({ outputImages: ['a'] }), new Set(['a']))).toEqual([])
  })
})
