// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_INSPECT_CONFIG, MAX_QC_RULES, QC_RULE_PRESETS, normalizeInspectConfig, useInspectConfig } from './inspectConfig'

describe('inspectConfig', () => {
  beforeEach(() => {
    localStorage.clear()
    useInspectConfig.setState({ config: DEFAULT_INSPECT_CONFIG })
  })

  it('空值回落到默认配置', () => {
    expect(normalizeInspectConfig(null)).toEqual(DEFAULT_INSPECT_CONFIG)
    expect(normalizeInspectConfig({})).toEqual(DEFAULT_INSPECT_CONFIG)
  })

  it('字段类型不对时保留默认值', () => {
    const config = normalizeInspectConfig({ autoQc: 'yes', checkText: 0, qcModel: 123 })
    expect(config.autoQc).toBe(true)
    expect(config.checkText).toBe(true)
    expect(config.qcModel).toBe('')
  })

  it('判定线越界时夹回可用区间', () => {
    expect(normalizeInspectConfig({ limit: 0.1 }).limit).toBe(0.7)
    expect(normalizeInspectConfig({ limit: 5 }).limit).toBe(0.99)
    expect(normalizeInspectConfig({ limit: 0.85 }).limit).toBe(0.85)
  })

  it('张数和并发取整并夹在可用区间', () => {
    const config = normalizeInspectConfig({ maxImages: 999, peerLimit: 0, qcConcurrency: 20 })
    expect(config.maxImages).toBe(60)
    expect(config.peerLimit).toBe(1)
    expect(config.qcConcurrency).toBe(8)
    expect(normalizeInspectConfig({ maxImages: 12.7 }).maxImages).toBe(13)
  })

  it('改配置会写回本机存储，重开还能读出来', () => {
    useInspectConfig.getState().setConfig({ limit: 0.8, checkOverlap: false })
    const saved = localStorage.getItem('gpt-image-playground.inspect-config')
    expect(saved).toBeTruthy()
    expect(JSON.parse(saved!)).toMatchObject({ limit: 0.8, checkOverlap: false })
  })

  it('恢复默认会清掉改动', () => {
    useInspectConfig.getState().setConfig({ autoQc: false, maxImages: 10 })
    useInspectConfig.getState().resetConfig()
    expect(useInspectConfig.getState().config).toEqual(DEFAULT_INSPECT_CONFIG)
  })
})

describe('自定义检查项配置', () => {
  it('按顺序保留，名字去空格；还空着的行也留着（界面里正在编辑）', () => {
    const config = normalizeInspectConfig({
      customRules: [
        { id: 'a', name: '  不许出现按钮  ', detail: '有空胶囊即不通过' },
        { name: '   ' },
      ],
    })
    expect(config.customRules).toEqual([
      { id: 'a', name: '不许出现按钮', detail: '有空胶囊即不通过', enabled: true },
      { id: 'qc-rule-2', name: '', detail: '', enabled: true },
    ])
  })

  it('没写原因时自动补一个 id，名字过长截断到 24 字', () => {
    const config = normalizeInspectConfig({
      customRules: [{ name: '一'.repeat(40) }],
    })
    expect(config.customRules[0].id).toBe('qc-rule-1')
    expect(config.customRules[0].name).toHaveLength(24)
    expect(config.customRules[0].enabled).toBe(true)
  })

  it('关掉的规则保留在配置里，但不会生效', () => {
    const config = normalizeInspectConfig({
      customRules: [{ id: 'a', name: '不许出现按钮', detail: 'x', enabled: false }],
    })
    expect(config.customRules[0].enabled).toBe(false)
  })

  it(`最多保留 ${MAX_QC_RULES} 条`, () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, name: `规则${i}`, detail: 'x' }))
    expect(normalizeInspectConfig({ customRules: many }).customRules).toHaveLength(MAX_QC_RULES)
  })

  it('不是数组时回到空列表', () => {
    expect(normalizeInspectConfig({ customRules: 'oops' }).customRules).toEqual([])
    expect(normalizeInspectConfig({}).customRules).toEqual([])
  })
})

describe('常用检查项预设', () => {
  it('每条预设都有名字和判定标准，且名字不重复', () => {
    expect(QC_RULE_PRESETS.length).toBeGreaterThan(0)
    for (const preset of QC_RULE_PRESETS) {
      expect(preset.name.trim()).not.toBe('')
      expect(preset.detail.trim()).not.toBe('')
    }
    expect(new Set(QC_RULE_PRESETS.map((item) => item.name)).size).toBe(QC_RULE_PRESETS.length)
  })

  it('预设能通过配置校验（名字、判定标准、默认开启）', () => {
    const config = normalizeInspectConfig({
      customRules: QC_RULE_PRESETS.map((preset, index) => ({ id: `p${index}`, ...preset })),
    })
    expect(config.customRules).toHaveLength(QC_RULE_PRESETS.length)
    expect(config.customRules.every((rule) => rule.enabled && rule.detail)).toBe(true)
  })
})

describe('重复度比对范围', () => {
  it('默认按同产品-方向比', () => {
    expect(DEFAULT_INSPECT_CONFIG.duplicateScope).toBe('direction')
    expect(normalizeInspectConfig({}).duplicateScope).toBe('direction')
  })

  it('选了卡内就保留，认不出来的值退回默认', () => {
    expect(normalizeInspectConfig({ duplicateScope: 'card' }).duplicateScope).toBe('card')
    expect(normalizeInspectConfig({ duplicateScope: 'card' }).duplicateScope).toBe('card')
    expect(normalizeInspectConfig({ duplicateScope: 'whatever' }).duplicateScope).toBe('direction')
    expect(normalizeInspectConfig({ duplicateScope: 123 }).duplicateScope).toBe('direction')
  })
})
