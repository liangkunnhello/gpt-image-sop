/**
 * 日期区间面板。
 *
 * 改造原因：原来日期是「两个原生 input + 今天/近7天/近30天/全部 四个按钮」平铺在工具条上，
 * 占掉一整行还挤。现在收进一个面板：左边快捷项、右边两个月日历，
 * 工具条上只留一个「2026-10-31 至 2026-11-06」的按钮。
 *
 * 不用第三方日期库：只需要「选一段日期区间」，引一个库要多背几十 KB，
 * 月份网格自己算就够了（见 lib/dateRange.ts，边界都有用例）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  formatRange,
  monthCells,
  monthLabel,
  monthOf,
  shiftMonth,
} from '../../lib/dateRange'
import { presetRange, todayString, type DateRange, type RangePreset } from '../../lib/trackerFilter'

const PRESETS: Array<[RangePreset, string]> = [
  ['today', '今天'],
  ['7d', '近7天'],
  ['30d', '近30天'],
  ['all', '全部'],
]

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export default function DateRangePicker({
  value,
  onChange,
  today = todayString(),
}: {
  value: DateRange
  onChange: (range: DateRange) => void
  today?: string
}) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => monthOf(value.from || today))
  /** 已经点了起点、还没点终点时的临时起点 */
  const [draftFrom, setDraftFrom] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  /** 每次打开都回到当前选中区间所在的月份，不然上次翻到哪就停在哪 */
  const openPanel = () => {
    setMonth(monthOf(value.from || today))
    setDraftFrom('')
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const applyPreset = (preset: RangePreset) => {
    onChange(presetRange(preset, today))
    setOpen(false)
  }

  /** 点日期：第一次定起点，第二次定终点并立即生效 */
  const clickDay = (date: string) => {
    if (!draftFrom) {
      setDraftFrom(date)
      return
    }
    const from = date < draftFrom ? date : draftFrom
    const to = date < draftFrom ? draftFrom : date
    onChange({ from, to })
    setDraftFrom('')
    setOpen(false)
  }

  /** 高亮用的区间：正在选的时候显示「起点 → 鼠标能看到的那天」的预览 */
  const active: DateRange = draftFrom
    ? { from: draftFrom, to: draftFrom }
    : value

  const months = useMemo(() => [month, shiftMonth(month, 1)], [month])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
          open
            ? 'border-blue-300 bg-blue-50/60 text-blue-600 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300'
            : 'border-gray-200 bg-transparent text-gray-600 hover:border-gray-300 dark:border-white/15 dark:text-gray-300'
        }`}
        title="选择统计区间"
        aria-expanded={open}
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6.75 3v2.25M17.25 3v2.25M3.75 6.75h16.5M4.5 6.75h15A1.5 1.5 0 0121 8.25v10.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.75V8.25a1.5 1.5 0 011.5-1.5z" />
        </svg>
        <span className="tabular-nums">{formatRange(value)}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 flex w-max max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-100 bg-white shadow-xl dark:border-white/10 dark:bg-gray-900">
          {/* 快捷项：对应原来工具栏上那排按钮 */}
          <div className="flex w-[5.5rem] shrink-0 flex-col gap-0.5 border-r border-gray-100 p-1.5 dark:border-white/10">
            {PRESETS.map(([key, label]) => {
              const preset = presetRange(key, today)
              const active_ = preset.from === value.from && preset.to === value.to
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPreset(key)}
                  className={`rounded-md px-2 py-1 text-left text-[11px] transition-colors ${
                    active_
                      ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/5'
                  }`}
                >
                  {label}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => applyPreset('all')}
              className="mt-auto rounded-md px-2 py-1 text-left text-[11px] text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5"
            >
              重置
            </button>
          </div>

          <div className="p-2">
            <div className="mb-1 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setMonth(shiftMonth(month, -1))}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10"
                title="上个月"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300">{monthLabel(months[0])}</span>
              <div className="flex-1" />
              <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300">{monthLabel(months[1])}</span>
              <button
                type="button"
                onClick={() => setMonth(shiftMonth(month, 1))}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10"
                title="下个月"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            <div className="flex gap-3">
              {months.map((item) => (
                <MonthGrid
                  key={item}
                  month={item}
                  today={today}
                  range={active}
                  onPick={clickDay}
                />
              ))}
            </div>

            <div className="mt-1.5 flex items-center justify-between border-t border-gray-100 pt-1.5 text-[10px] text-gray-400 dark:border-white/10">
              <span>{draftFrom ? `起点 ${draftFrom}，再点一天作为终点` : '点两个日期选区间，或用左边快捷项'}</span>
              <button
                type="button"
                onClick={() => {
                  onChange({ from: '', to: '' })
                  setOpen(false)
                }}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                清除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 一个月：表头 + 42 格。格子只做展示与点击，选中样式由外层算好的区间决定 */
function MonthGrid({
  month,
  today,
  range,
  onPick,
}: {
  month: string
  today: string
  range: DateRange
  onPick: (date: string) => void
}) {
  const cells = monthCells(month)
  return (
    <div className="w-[11.5rem]">
      <div className="mb-1 grid grid-cols-7 text-center text-[10px] text-gray-400">
        {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((cell) => {
          const inRange = Boolean(range.from && range.to && cell.date >= range.from && cell.date <= range.to)
          const isStart = cell.date === range.from
          const isEnd = cell.date === range.to
          const isToday = cell.date === today
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => onPick(cell.date)}
              className={`relative h-6 rounded text-[11px] tabular-nums transition-colors ${
                isStart || isEnd
                  ? 'bg-blue-500 font-medium text-white'
                  : inRange
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
                    : cell.inMonth
                      ? 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/10'
                      : 'text-gray-300 hover:bg-gray-50 dark:text-gray-600 dark:hover:bg-white/5'
              }`}
              title={cell.date}
            >
              {cell.day}
              {/* 今天一个小点：日期面板里最常见的问题是「今天在哪」 */}
              {isToday && !isStart && !isEnd && (
                <span className="absolute bottom-0.5 left-1/2 h-0.5 w-0.5 -translate-x-1/2 rounded-full bg-blue-500" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
