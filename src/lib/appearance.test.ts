// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { applyAppearance, isAppearanceTheme } from './appearance'
import { normalizeSettings } from './apiProfiles'

afterEach(() => {
  delete document.documentElement.dataset.appearance
})

describe('外观主题', () => {
  it('只认 default 与 glass', () => {
    expect(isAppearanceTheme('default')).toBe(true)
    expect(isAppearanceTheme('glass')).toBe(true)
    expect(isAppearanceTheme('dark')).toBe(false)
    expect(isAppearanceTheme(undefined)).toBe(false)
  })

  it('玻璃主题写到根节点，切回默认时清掉', () => {
    applyAppearance('glass')
    expect(document.documentElement.dataset.appearance).toBe('glass')

    applyAppearance('default')
    expect(document.documentElement.dataset.appearance).toBeUndefined()
  })
})

describe('设置里的主题字段', () => {
  it('缺省是默认主题，老数据升级后不会突然变成玻璃', () => {
    expect(normalizeSettings({}).appearance).toBe('default')
    expect(normalizeSettings({ appearance: undefined }).appearance).toBe('default')
  })

  it('保留玻璃主题', () => {
    expect(normalizeSettings({ appearance: 'glass' }).appearance).toBe('glass')
  })

  it('非法值退回默认', () => {
    expect(normalizeSettings({ appearance: 'hologram' }).appearance).toBe('default')
    expect(normalizeSettings({ appearance: 1 }).appearance).toBe('default')
  })
})
