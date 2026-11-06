import { describe, expect, it } from 'vitest'
import {
  formatRange,
  monthCells,
  monthLabel,
  monthOf,
  rangeDays,
  shiftMonth,
} from './dateRange'
import { presetRange } from './trackerFilter'

/**
 * 日期面板的边界全在「月份换算」和「跨年」上：把这两个算错，
 * 面板会显示上个月、或者选出来的区间整体偏一天，而界面上很难一眼看出来。
 */
describe('monthCells 月份网格', () => {
  it('2026-11-01 是周日，网格第一格就是 1 号', () => {
    const cells = monthCells('2026-11')
    expect(cells).toHaveLength(42)
    expect(cells[0]).toEqual({ date: '2026-11-01', day: 1, inMonth: true })
    expect(cells[29]).toEqual({ date: '2026-11-30', day: 30, inMonth: true })
  })

  it('前面补上个月的日期，并标成不在本月', () => {
    // 2026-10-01 是周四，所以 9/27（周日）开始补 4 格
    const cells = monthCells('2026-10')
    expect(cells[0]).toEqual({ date: '2026-09-27', day: 27, inMonth: false })
    expect(cells[4]).toEqual({ date: '2026-10-01', day: 1, inMonth: true })
  })

  it('跨年：1 月的网格前面是去年 12 月', () => {
    const cells = monthCells('2027-01')
    expect(cells.filter((cell) => !cell.inMonth).slice(0, 3).map((cell) => cell.date))
      .toEqual(['2026-12-27', '2026-12-28', '2026-12-29'])
  })

  it('永远是 42 格（切月时高度不跳）', () => {
    for (const month of ['2026-02', '2026-11', '2027-02']) {
      expect(monthCells(month)).toHaveLength(42)
    }
  })
})

describe('shiftMonth / monthOf / monthLabel', () => {
  it('跨年加减月', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-11', 2)).toBe('2027-01')
  })

  it('从日期取月份、格式化成中文标题', () => {
    expect(monthOf('2026-11-05')).toBe('2026-11')
    expect(monthOf('')).toBe('')
    expect(monthLabel('2026-11')).toBe('2026 年 11 月')
  })
})

describe('formatRange', () => {
  it('两端为空是全部时间，同一天只写一次', () => {
    expect(formatRange({ from: '', to: '' })).toBe('全部时间')
    expect(formatRange({ from: '2026-11-05', to: '2026-11-05' })).toBe('2026-11-05')
    expect(formatRange({ from: '2026-10-31', to: '2026-11-06' })).toBe('2026-10-31 至 2026-11-06')
  })

  it('只有一端时说清楚是「起」还是「截至」', () => {
    expect(formatRange({ from: '2026-10-31', to: '' })).toBe('2026-10-31 起')
    expect(formatRange({ from: '', to: '2026-11-06' })).toBe('截至 2026-11-06')
  })
})

describe('rangeDays', () => {
  it('含两端，跨月正确', () => {
    expect(rangeDays({ from: '2026-11-05', to: '2026-11-05' })).toBe(1)
    expect(rangeDays({ from: '2026-10-30', to: '2026-11-05' })).toBe(7)
    expect(rangeDays({ from: '', to: '' })).toBe(0)
  })

  it('起点晚于终点时给 0，不返回负数', () => {
    expect(rangeDays({ from: '2026-11-06', to: '2026-11-01' })).toBe(0)
  })
})

describe('和 presetRange 对齐', () => {
  it('「近7天」含今天共 7 天，与面板高亮一致', () => {
    const range = presetRange('7d', '2026-11-06')
    expect(range).toEqual({ from: '2026-10-31', to: '2026-11-06' })
    expect(rangeDays(range)).toBe(7)
  })

  it('「全部」是两端皆空，文案不再是区间', () => {
    const range = presetRange('all', '2026-11-06')
    expect(formatRange(range)).toBe('全部时间')
  })
})
