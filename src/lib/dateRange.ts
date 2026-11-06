/**
 * 日期区间的纯计算：月份网格、加减月、区间文案。
 *
 * 单独拿出来是因为「某月第一天的星期几」「跨年加减月」这类边界最容易写错，
 * 放在组件里只能靠点界面验，抽成纯函数就能直接测。
 *
 * 全部按 UTC 算：只处理 YYYY-MM-DD 这种「没有时区含义」的日历日期，
 * 用本地时区会在夏令时/时差边界上把日期整体挪一天（`toISOString` 的老坑）。
 */
import type { DateRange } from './trackerFilter'

/** ISO 日期加减天数 */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days))
  return date.toISOString().slice(0, 10)
}

/** ISO 日期 → 所属月份 'YYYY-MM' */
export function monthOf(iso: string): string {
  return (iso || '').slice(0, 7)
}

/** 月份加减（跨年自动进位），返回 'YYYY-MM' */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const date = new Date(Date.UTC(y, (m ?? 1) - 1 + delta, 1))
  return date.toISOString().slice(0, 7)
}

/** 'YYYY-MM' → 中文标题「2026 年 11 月」 */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${y} 年 ${m} 月`
}

export interface MonthCell {
  /** YYYY-MM-DD */
  date: string
  /** 几号（1-31） */
  day: number
  /** 是否属于本月：前后补空位会带上相邻月的日期，显示要淡一点 */
  inMonth: boolean
}

/**
 * 一个月的日历格子：固定 6 行 × 7 列 = 42 格，周日起。
 *
 * 固定 42 格是为了「切月时高度不跳」—— 有的月只占 5 行，
 * 高度跟着变的话，下面那半年视图会来回抖。
 */
export function monthCells(month: string): MonthCell[] {
  const [y, m] = month.split('-').map(Number)
  const first = new Date(Date.UTC(y, (m ?? 1) - 1, 1))
  // getUTCDay: 0 = 周日，正好对应「日 一 二 三 四 五 六」的表头
  const offset = first.getUTCDay()
  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(Date.UTC(y, (m ?? 1) - 1, 1 - offset + i))
    const iso = date.toISOString().slice(0, 10)
    cells.push({ date: iso, day: date.getUTCDate(), inMonth: iso.slice(0, 7) === month })
  }
  return cells
}

/** 区间文案：两端为空 = 全部时间，同一天只写一次 */
export function formatRange(range: DateRange): string {
  if (!range.from && !range.to) return '全部时间'
  if (range.from && range.to) {
    return range.from === range.to ? range.from : `${range.from} 至 ${range.to}`
  }
  return range.from ? `${range.from} 起` : `截至 ${range.to}`
}

/** 区间内共有几天（含两端）；空区间返回 0 */
export function rangeDays(range: DateRange): number {
  if (!range.from || !range.to) return 0
  const from = new Date(`${range.from}T00:00:00Z`).getTime()
  const to = new Date(`${range.to}T00:00:00Z`).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0
  return Math.round((to - from) / 86400000) + 1
}
