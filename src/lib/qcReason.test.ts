import { describe, expect, it } from 'vitest'
import { describeOutcome } from './clipSimilarity'
import type { QcOutcome } from './batchCheck'

function outcome(patch: Partial<QcOutcome> = {}): QcOutcome {
  return {
    verdict: 'fail',
    violationPass: true,
    textPass: true,
    overlapPass: true,
    spots: [],
    missing: [],
    wrong: [],
    extra: [],
    custom: [],
    reason: '',
    confidence: 0.8,
    ...patch,
  }
}

describe('质检理由不能都一样', () => {
  it('把 missing / wrong / extra 逐条带上，而不是只留一句概括', () => {
    const a = describeOutcome(outcome({
      reason: '画面文字与要求不一致',
      missing: ['带病投保也能赔'],
    }))
    const b = describeOutcome(outcome({
      reason: '画面文字与要求不一致',
      wrong: ['应为「续」实为「读」'],
    }))
    // 模型的概括句可以一样，但拼上具体问题后必须能区分开
    expect(a).not.toBe(b)
    expect(a).toContain('缺：带病投保也能赔')
    expect(b).toContain('错字：应为「续」实为「读」')
  })

  it('多类问题一起出现时全带上', () => {
    const text = describeOutcome(outcome({
      reason: '两处问题',
      missing: ['600万'],
      wrong: ['应为「保」实为「宝」'],
      extra: ['为爱续航 幸福无忧'],
      spots: ['左上角 Logo 压住副标题前两字'],
    }))
    expect(text).toContain('缺：600万')
    expect(text).toContain('错字')
    expect(text).toContain('多出：为爱续航 幸福无忧')
    expect(text).toContain('遮挡：左上角 Logo 压住副标题前两字')
  })

  it('只有违规问题没别的细节时，给一句能看懂的话', () => {
    const text = describeOutcome(outcome({ violationPass: false, reason: '' }))
    expect(text).toContain('违规')
  })

  it('模型没写 reason 但有细节时，只给细节', () => {
    const text = describeOutcome(outcome({ reason: '   ', missing: ['主标题'] }))
    expect(text).toBe('缺：主标题')
  })

  it('什么都没说时给兜底文案，不留空字符串', () => {
    expect(describeOutcome(outcome({ reason: '' }))).toBe('未给出具体原因')
    expect(describeOutcome(outcome({ verdict: 'pass', reason: '' }))).toBe('通过')
  })

  it('自定义规则未通过时点名是哪条', () => {
    const text = describeOutcome(outcome({
      reason: '规则未过',
      custom: [
        { id: '不许出现按钮', pass: false, note: '卡片底部有一只空胶囊' },
        { id: '文字不许叠影', pass: true, note: '' },
      ],
    }))
    expect(text).toContain('不许出现按钮')
    expect(text).toContain('卡片底部有一只空胶囊')
    expect(text).not.toContain('文字不许叠影')
  })
})
