import { describe, expect, it } from 'vitest'
import { formatSpend } from './formatMoney'

/**
 * 台账/报表里的消耗展示。
 *
 * 背景：一天的消耗动辄五六位数，原来一律两位小数（`1,281,394.47`），
 * 一屏几十行全是 `.xx`，量级要自己数位数才看得出来。
 */
describe('formatSpend', () => {
  it('≥ 1 元一律取整，带千分位', () => {
    expect(formatSpend(1281394.47)).toBe('1,281,394')
    expect(formatSpend(468548.85)).toBe('468,549')
    expect(formatSpend(12.5)).toBe('13')
    expect(formatSpend(1)).toBe('1')
  })

  it('不足 1 元保留两位小数（否则零星流水会显示成 0）', () => {
    expect(formatSpend(0.5)).toBe('0.50')
    expect(formatSpend(0.04)).toBe('0.04')
    expect(formatSpend(0.99)).toBe('0.99')
  })

  it('0 就是 0，不做小数补齐', () => {
    expect(formatSpend(0)).toBe('0')
  })

  it('进位边界照常四舍五入', () => {
    expect(formatSpend(0.999)).toBe('1.00')
    expect(formatSpend(999.5)).toBe('1,000')
  })

  it('非数值不把界面打成 NaN', () => {
    expect(formatSpend(Number.NaN)).toBe('0')
    expect(formatSpend(Number.POSITIVE_INFINITY)).toBe('0')
  })
})
