import { describe, expect, it, vi } from 'vitest'
import { trimOutputImages } from './taskState'

/**
 * 「设了 500 张，实际出了 518 张」——渠道无视 n 就是多给。
 * 这里守住「用户设多少就是多少」，同时别把「回得少」也截成 0 张。
 */
describe('trimOutputImages', () => {
  it('n=1 却回 3 张时只留第一张', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(trimOutputImages(['a', 'b', 'c'], 1)).toEqual(['a'])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('n=4 回 4 张原样返回（正常情况不动）', () => {
    expect(trimOutputImages(['a', 'b', 'c', 'd'], 4)).toHaveLength(4)
  })

  it('回得比请求少时不截断，交给上层报错/续跑', () => {
    expect(trimOutputImages(['a'], 3)).toEqual(['a'])
    expect(trimOutputImages([], 3)).toEqual([])
  })

  it('n 缺失或为 0 时按 1 张算', () => {
    expect(trimOutputImages(['a', 'b'], undefined)).toEqual(['a'])
    expect(trimOutputImages(['a', 'b'], 0)).toEqual(['a'])
  })
})
