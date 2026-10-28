import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { DUPLICATE_SCOPE_LABEL, duplicateScopeKey, groupTasksByScope, peersForTask, scopeTasksFor, toDuplicateScope } from './duplicateScope'

/**
 * 重复度的比对范围：同一张卡 / 同产品-方向。
 * 换口径数字会变，所以范围挑错比算错更误导人。
 */
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    prompt: 'p',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: ['img-1'],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

const cardA1 = task({ id: 'a1', sopJobId: 'job-a', sopDirectionId: 'dir-1', outputImages: ['a1-1', 'a1-2'] })
const cardA2 = task({ id: 'a2', sopJobId: 'job-a', sopDirectionId: 'dir-1', outputImages: ['a2-1'] })
const cardB = task({ id: 'b1', sopJobId: 'job-b', sopDirectionId: 'dir-1', outputImages: ['b1-1'] })
const otherDir = task({ id: 'c1', sopJobId: 'job-c', sopDirectionId: 'dir-2', outputImages: ['c1-1'] })
const plain = task({ id: 'p1', outputImages: ['p1-1'] })

describe('重复度比对范围', () => {
  it('认不出来的值退回「同产品-方向」，文案也齐全', () => {
    expect(toDuplicateScope('card')).toBe('card')
    expect(toDuplicateScope('whatever')).toBe('direction')
    expect(toDuplicateScope(undefined)).toBe('direction')
    expect(DUPLICATE_SCOPE_LABEL.card).toContain('任务卡')
    expect(DUPLICATE_SCOPE_LABEL.direction).toContain('方向')
  })

  it('组 key：卡看 sopJobId，方向看 sopDirectionId；没有就各自归一档', () => {
    expect(duplicateScopeKey(cardA1, 'card')).toBe('job-a')
    expect(duplicateScopeKey({ id: 'x', sopDirectionId: undefined } as never, 'direction')).toBe('')
    expect(duplicateScopeKey(plain, 'direction')).toBe('')
  })

  it('卡内只挑同卡的其它任务（同卡多条提示词）', () => {
    const peers = peersForTask([cardA1, cardA2, cardB, otherDir], cardA1, 'card')
    expect(peers.map((item) => item.id)).toEqual(['a2'])
  })

  it('卡内不退回全量：这张卡只有自己时没有参照', () => {
    expect(peersForTask([cardB, otherDir], cardB, 'card')).toEqual([])
  })

  it('同方向挑同方向的所有成品，不跨方向', () => {
    const peers = peersForTask([cardA1, cardA2, cardB, otherDir], cardA1, 'direction')
    expect(peers.map((item) => item.id)).toEqual(['a2', 'b1'])
  })

  it('同方向下只有自己时退回全部成品，避免重复度永远算不出来', () => {
    const peers = peersForTask([otherDir], otherDir, 'direction')
    expect(peers).toEqual([])
    const withOthers = peersForTask([otherDir, cardA1], otherDir, 'direction')
    expect(withOthers.map((item) => item.id)).toEqual(['a1'])
  })

  it('回收站里 / 没完成的 / 没出图的都不参与', () => {
    const trashed = task({ id: 'x1', sopJobId: 'job-a', deletedAt: 1 })
    const running = task({ id: 'x2', sopJobId: 'job-a', status: 'running' })
    const empty = task({ id: 'x3', sopJobId: 'job-a', outputImages: [] })
    expect(peersForTask([cardA1, trashed, running, empty], cardA1, 'card')).toEqual([])
  })

  it('分组时按口径把任务归堆', () => {
    const byCard = groupTasksByScope([cardA1, cardA2, cardB, otherDir], 'card')
    expect(byCard.map((group) => [group.key, group.tasks.length])).toEqual([['job-a', 2], ['job-b', 1], ['job-c', 1]])
    const byDir = groupTasksByScope([cardA1, cardA2, cardB, otherDir], 'direction')
    expect(byDir.map((group) => [group.key, group.tasks.length])).toEqual([['dir-1', 3], ['dir-2', 1]])
  })

  it('检查时要带的任务含自己', () => {
    const list = scopeTasksFor([cardA1, cardA2, cardB], cardA1, 'card')
    expect(list.map((item) => item.id)).toEqual(['a1', 'a2'])
  })

  it('peers 数量受上限约束', () => {
    const many = Array.from({ length: 20 }, (_, i) => task({ id: `m${i}`, sopJobId: 'job-a', outputImages: [`m${i}-1`] }))
    expect(peersForTask([cardA1, ...many], cardA1, 'card', 5)).toHaveLength(5)
  })
})
