// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  clampSidebarWidth,
  readSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebarWidth'

/**
 * 左栏宽度：方向名很长时要能往右拖开。
 * 这里只盯住「读回来的值一定是合法宽度」—— 拖歪了、存坏了都不该让界面裂开。
 */
describe('左栏宽度', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('没存过就用默认宽度', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('存过的值读回来原样生效', () => {
    saveSidebarWidth(320)
    expect(readSidebarWidth()).toBe(320)
  })

  it('超出范围会被夹回上下限', () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH)
    expect(saveSidebarWidth(9999) ?? readSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('存坏了（非数字 / 空值）退回默认，不会返回 NaN', () => {
    window.localStorage.setItem('gpt-image-sop:sidebar-width', 'abc')
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
    window.localStorage.setItem('gpt-image-sop:sidebar-width', '')
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})
