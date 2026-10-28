// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ExpectText } from './batchCheck'
import { activeQcRules, buildQcPrompt, qcOutcomeFromRaw, type QcChecks } from './visionQc'

const expectText: ExpectText = { mainTitle: '赔付总限额600万', tags: [], brand: [], disclaimer: [] }

const checks = (rules: QcChecks['rules'] = []): QcChecks => ({
  violation: true,
  text: true,
  overlap: true,
  rules,
})

const BUTTON_RULE = {
  id: 'qc-btn',
  name: '不许出现按钮',
  detail: '画面里出现按钮、空胶囊、圆角长条占位即不通过',
  enabled: true,
}

describe('自定义检查项', () => {
  it('启用且填了判定标准才生效', () => {
    expect(activeQcRules([BUTTON_RULE])).toHaveLength(1)
    expect(activeQcRules([{ ...BUTTON_RULE, enabled: false }])).toHaveLength(0)
    expect(activeQcRules([{ ...BUTTON_RULE, detail: '  ' }])).toHaveLength(0)
    expect(activeQcRules([{ ...BUTTON_RULE, name: '' }])).toHaveLength(0)
  })

  it('规则连同 id 和判定标准写进提示词', () => {
    const prompt = buildQcPrompt(expectText, false, checks([BUTTON_RULE]))
    expect(prompt).toContain('【额外检查项】')
    expect(prompt).toContain('id=qc-btn')
    expect(prompt).toContain('不许出现按钮')
    expect(prompt).toContain('空胶囊')
    expect(prompt).toContain('本次只检查：违规内容、文字一致性、文字压叠、不许出现按钮')
  })

  it('没有自定义规则时不出现这一段', () => {
    expect(buildQcPrompt(expectText, false, checks())).not.toContain('【额外检查项】')
  })

  it('规则判否时，即使模型 overall 给 pass 也判不合格', () => {
    const raw = {
      violation_pass: true,
      text_pass: true,
      overlap_pass: true,
      custom_items: [{ id: 'qc-btn', pass: false, note: '卡片底部有一只空胶囊' }],
      verdict: 'pass',
      reason: '其余正常',
      confidence: 0.8,
    }
    const outcome = qcOutcomeFromRaw(raw, '')
    expect(outcome.verdict).toBe('fail')
    expect(outcome.custom).toEqual([{ id: 'qc-btn', pass: false, note: '卡片底部有一只空胶囊' }])
  })

  it('全部通过时维持模型的结论，解析不到的脏数据丢掉', () => {
    const outcome = qcOutcomeFromRaw({
      custom_items: [{ id: 'qc-btn', pass: true }, null, 'x', { pass: true }, { id: 'qc-2', pass: true, note: '' }],
      verdict: 'pass',
    }, '')
    expect(outcome.verdict).toBe('pass')
    expect(outcome.custom.map((item) => item.id)).toEqual(['qc-btn', 'qc-2'])
  })

  it('模型没给 custom_items 时是空数组，不影响原有三个检查项', () => {
    const outcome = qcOutcomeFromRaw({ violation_pass: false, verdict: 'fail', reason: '含违规' }, '')
    expect(outcome.custom).toEqual([])
    expect(outcome.violationPass).toBe(false)
    expect(outcome.verdict).toBe('fail')
  })

  it('解析失败时给出可用的错误结论', () => {
    const outcome = qcOutcomeFromRaw(null, '模型没返回 JSON')
    expect(outcome.verdict).toBe('error')
    expect(outcome.custom).toEqual([])
    expect(outcome.reason).toBe('模型没返回 JSON')
  })
})
