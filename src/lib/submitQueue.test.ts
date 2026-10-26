import { describe, expect, it } from 'vitest'
import { MAX_PENDING_SUBMISSIONS, queuePositionLabel, submissionDisposition } from './submitQueue'

describe('submissionDisposition', () => {
  it('没有批在跑、队列也空时直接执行', () => {
    expect(submissionDisposition({ busy: false, queued: 0 })).toBe('run')
  })

  it('批量进行中再提交先排队', () => {
    expect(submissionDisposition({ busy: true, queued: 0 })).toBe('queue')
    expect(submissionDisposition({ busy: true, queued: 3 })).toBe('queue')
  })

  it('队列里有人时不能插队：即使当前没有批在跑也要排到队尾', () => {
    expect(submissionDisposition({ busy: false, queued: 1 })).toBe('queue')
  })

  it('排队到上限后拒绝，避免连点堆出几十批', () => {
    expect(submissionDisposition({ busy: true, queued: MAX_PENDING_SUBMISSIONS - 1 })).toBe('queue')
    expect(submissionDisposition({ busy: true, queued: MAX_PENDING_SUBMISSIONS })).toBe('reject')
    expect(submissionDisposition({ busy: false, queued: MAX_PENDING_SUBMISSIONS })).toBe('reject')
  })
})

describe('queuePositionLabel', () => {
  it('队列为空时说明当前批结束就开始', () => {
    expect(queuePositionLabel(0)).toContain('当前批完成后自动开始')
  })

  it('队列有人时给出前面还剩几个提交', () => {
    expect(queuePositionLabel(2)).toContain('还有 2 个提交')
    expect(queuePositionLabel(2)).toContain('依次自动开始')
  })
})
