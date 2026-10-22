// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_INSPECT_CONFIG, normalizeInspectConfig, useInspectConfig } from './inspectConfig'

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
