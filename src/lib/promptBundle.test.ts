import { describe, expect, it } from 'vitest'

import { buildPromptBundle } from './promptBundle'
import { buildPromptMessages, buildSopSystemPrompt } from './sopPipeline'

describe('buildPromptBundle', () => {
  it('把三份合成一份，卖点排在最前并写明优先级', () => {
    const bundle = buildPromptBundle({
      systemPrompt: '# 版式\n左图右文，标题居左。',
      point: '600 万医疗保障\n住院 0 免赔',
      style: '扁平插画，莫兰迪配色',
    })
    const { merged, copyText } = bundle
    expect(copyText).toBe('600 万医疗保障\n住院 0 免赔')
    expect(merged.indexOf('# 文案（最高优先级')).toBeLessThan(merged.indexOf('# 系统提示词'))
    expect(merged.indexOf('# 系统提示词')).toBeLessThan(merged.indexOf('# 风格'))
    expect(merged).toContain('逐字来自「文案」')
    expect(merged).toContain('600 万医疗保障')
    expect(merged).toContain('左图右文')
    expect(merged).toContain('扁平插画')
  })

  it('没有卖点时不写优先级，只合并其余两段', () => {
    const bundle = buildPromptBundle({ systemPrompt: '只要画面，不要文字', style: '三宫格' })
    expect(bundle.copyText).toBe('')
    expect(bundle.merged).not.toContain('最高优先级')
    expect(bundle.merged).toContain('只要画面')
    expect(bundle.merged).toContain('三宫格')
  })

  it('全空时返回空串', () => {
    expect(buildPromptBundle({}).merged).toBe('')
    expect(buildPromptBundle({ systemPrompt: '  ', point: '\n' }).merged).toBe('')
  })

  it('只有卖点时也能单独成文', () => {
    const bundle = buildPromptBundle({ point: '首月 1 元' })
    expect(bundle.merged).toContain('文案（最高优先级')
    expect(bundle.merged).toContain('首月 1 元')
  })
})

describe('buildPromptMessages', () => {
  const base = { sopText: '## 版式\n左图右文', count: 3 }

  it('有卖点时，system 与 user 都要强调逐字照抄', () => {
    const { system, user } = buildPromptMessages({ ...base, copyText: '600 万医疗保障' })
    expect(system).toContain('文案唯一来源')
    expect(system).toContain('不得改写')
    expect(user).toContain('【卖点文案（图上文字必须逐字照抄，不得改写）】')
    expect(user).toContain('600 万医疗保障')
    expect(user).toContain('不要另写文案')
  })

  it('没有卖点时退回原来的规则，不出现卖点段', () => {
    const { system, user } = buildPromptMessages({ ...base, ignoreCompliance: true })
    expect(system).not.toContain('文案唯一来源')
    expect(system).toContain('不要写品牌 logo')
    expect(user).not.toContain('卖点文案')
  })

  it('预留区说明仍然拼在最后', () => {
    const { system, user } = buildPromptMessages({
      ...base,
      copyText: '首月 1 元',
      avoidHint: '【画面预留区】左上角留白',
    })
    expect(system).toContain('画面预留区')
    expect(user.trimEnd().endsWith('左上角留白')).toBe(true)
  })
})

describe('按钮 / 引导点击开关', () => {
  it('开启时 SOP 与提示词两轮都禁止按钮类设计', () => {
    const sopSystem = buildSopSystemPrompt(true, false, true)
    expect(sopSystem).toContain('按钮')
    expect(sopSystem).toContain('禁忌')

    const promptSystem = buildPromptMessages({ sopText: 'SOP', count: 2, avoidCta: true }).system
    expect(promptSystem).toContain('仿系统界面')
    expect(promptSystem).toContain('立即领取')
  })

  it('关闭时不出现相关限制，保留参考图原有按钮', () => {
    expect(buildSopSystemPrompt(true, false, false)).not.toContain('仿系统界面')
    expect(buildPromptMessages({ sopText: 'SOP', count: 2, avoidCta: false }).system).not.toContain('立即领取')
  })
})
