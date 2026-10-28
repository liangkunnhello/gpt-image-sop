import type { GalleryFilter, GalleryFilterCounts } from '../lib/galleryFilter'

interface Props {
  filter: GalleryFilter
  onChange: (next: GalleryFilter) => void
  counts: GalleryFilterCounts
  /** 画廊里共多少张（「全部」上的数字） */
  total: number
  /** 重复度判定线，用在「重复」的悬浮说明里 */
  limit: number
}

/**
 * 详情页画廊的筛选条：全部 / 合格 / 待定 / 不合格 / 重复。
 *
 * 只在真有质检或重复度数据时才出现，否则一排 0 反而碍事；
 * 张数为 0 的档位也不显示，避免点了发现是空的。
 */
export default function GalleryFilterBar({ filter, onChange, counts, total, limit }: Props) {
  const hasAny = counts.pass > 0 || counts.unsure > 0 || counts.fail > 0 || counts.dup > 0
  if (!hasAny) return null

  const items: Array<[GalleryFilter, string, number]> = [
    ['all', '全部', total],
    ['pass', '合格', counts.pass],
    ['unsure', '待定', counts.unsure],
    ['fail', '不合格', counts.fail],
    ['dup', '重复', counts.dup],
  ]

  const activeClass = (value: GalleryFilter) => {
    if (value === 'fail') return 'bg-red-500 text-white'
    if (value === 'unsure') return 'bg-amber-500 text-white'
    if (value === 'pass') return 'bg-emerald-600 text-white'
    if (value === 'dup') return 'bg-orange-500 text-white'
    return 'bg-white text-black'
  }

  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/55 px-1 py-1 text-white shadow-sm backdrop-blur-sm">
      {items
        .filter(([value, , count]) => value === 'all' || count > 0)
        .map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={filter === value}
            className={`rounded-full px-2 py-0.5 text-[10px] leading-none transition-colors ${
              filter === value ? activeClass(value) : 'text-white/80 hover:bg-white/15'
            }`}
            title={value === 'dup' ? `重复度超过 ${Math.round(limit * 100)}% 的图` : undefined}
          >
            {label}
            <span className="ml-0.5 tabular-nums opacity-70">{count}</span>
          </button>
        ))}
    </div>
  )
}
