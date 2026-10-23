// @vitest-environment node

/**
 * 防回归：输入框上方的「系统提示词 / 变量提示词 / 卖点 / 风格」入口
 * 不能依赖业务归属（currentDirection / currentProduct）。
 *
 * 起因：点侧栏「全部任务」「未归属」时 activeDirectionId 会被清成空串，
 * 三个入口整块消失，用户以为提示词库不见了。这几个入口只跟模式有关。
 *
 * 用 Vite 的 ?raw 读源码，做静态检查：条件里一旦再带上 currentDirection，
 * 这条测试就会红，避免同类问题再回来。
 */

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('../components/InputBar.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const inputBar = Object.values(sources)[0] ?? ''

describe('输入框上方的提示词入口不依赖业务归属', () => {
  it('能读到 InputBar 源码', () => {
    expect(inputBar.length).toBeGreaterThan(1000)
  })

  it('SOP 模式的条件里没有 currentDirection / currentProduct', () => {
    expect(inputBar).not.toMatch(/\{sopMode && currentDirection/)
    expect(inputBar).not.toMatch(/\{sopMode && currentProduct/)
  })

  it('变量模式的条件里没有 currentDirection / currentProduct', () => {
    expect(inputBar).not.toMatch(/\{variableMode && currentDirection/)
    expect(inputBar).not.toMatch(/\{variableMode && currentProduct/)
  })

  it('三个入口用 pickerDirectionId 兜底空归属', () => {
    // 四个 picker 都传 pickerDirectionId，而不是 currentDirection.id
    const pickerCalls = inputBar.match(/directionId=\{[^}]+\}/g) ?? []
    expect(pickerCalls.length).toBeGreaterThanOrEqual(4)
    expect(pickerCalls.every((call) => call.includes('pickerDirectionId'))).toBe(true)
  })

  it('pickerDirectionId 是 currentDirection 的可空兜底', () => {
    expect(inputBar).toMatch(/pickerDirectionId\s*=\s*currentDirection\?\.id\s*\?\?\s*''/)
  })
})
