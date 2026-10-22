import { CHANNELS, NO_CHANNEL } from '../lib/channel'
import { useStore } from '../store'

/**
 * 渠道筛选：横排标签，和业务树（侧栏）并列生效、取交集。
 *
 * 样式照参考图：左边一个小标题「渠道」，右边一排可点的词，
 * 选中的那个是蓝底浅色胶囊，最右「全部」用于清空。
 * 与业务树的区别是这里不做层级，点一下就切，切换成本更低。
 */
export default function ChannelFilterBar() {
  const channelFilter = useStore((s) => s.channelFilter)
  const setChannelFilter = useStore((s) => s.setChannelFilter)
  const clearSelection = useStore((s) => s.clearSelection)

  const pick = (value: string | null) => {
    if (value === channelFilter) return
    setChannelFilter(value)
    // 筛选口径变了，原来选中的卡片可能已经不在视野里
    clearSelection()
  }

  const itemClass = (active: boolean) => `shrink-0 rounded-lg px-2.5 py-1 text-[13px] transition-colors ${
    active
      ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/[0.18] dark:text-blue-300'
      : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200'
  }`

  return (
    <div data-no-drag-select className="flex flex-wrap items-center gap-1">
      <span className="shrink-0 pr-1 text-[11px] text-gray-400 dark:text-gray-500">渠道</span>

      {CHANNELS.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => pick(item.value)}
          className={itemClass(channelFilter === item.value)}
        >
          {item.label}
        </button>
      ))}

      {/* 还没归渠道的卡片单独一个入口，否则这些卡只能在「全部」里混杂出现 */}
      <button
        type="button"
        onClick={() => pick(NO_CHANNEL)}
        className={itemClass(channelFilter === NO_CHANNEL)}
      >
        未指定
      </button>

      <button
        type="button"
        onClick={() => pick(null)}
        className={itemClass(!channelFilter)}
      >
        全部
      </button>
    </div>
  )
}
