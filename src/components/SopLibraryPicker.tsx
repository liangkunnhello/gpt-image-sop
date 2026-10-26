import { useSopStore } from '../lib/sopStore'
import { resolveSavedSop } from '../lib/savedSop'

interface Props {
  /** 自身 → 父 → 根 的作用域链，就近继承 */
  scopeIds: string[]
  directionId: string
}

const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 shrink-0 text-gray-400">
    <path strokeLinecap="round" d="M4 20h4l10-10-4-4L4 16v4z" />
  </svg>
)

/**
 * 输入框上方的 SOP 入口。
 *
 * SOP 模式有两种来源：
 * - 选了库里的 SOP：直接拿这份 SOP 写提示词出图，跳过反推，也就不再需要系统提示词；
 * - 没选（或不使用）：按原来的方式，拖参考图 + 系统提示词反推一份 SOP。
 */
export default function SopLibraryPicker({ scopeIds, directionId }: Props) {
  const savedSops = useSopStore((s) => s.savedSops)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const setLibraryTab = useSopStore((s) => s.setLibraryTab)

  const current = resolveSavedSop(savedSops, scopeIds, directionId, lastPick, defaultPick)

  return (
    <button
      type="button"
      onClick={() => setLibraryTab('sop')}
      title={current
        ? `生图 SOP：${current.name}（直接用这份 SOP 写提示词出图）`
        : '还没有选生图 SOP：会按参考图 + 系统提示词反推一份（点击打开提示词库）'}
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
        current
          ? 'border-teal-300 bg-teal-50/70 text-teal-700 hover:bg-teal-50 dark:border-teal-500/40 dark:bg-teal-500/10 dark:text-teal-300 dark:hover:bg-teal-500/15'
          : 'border-gray-200 bg-white/70 text-gray-600 hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]'
      }`}
    >
      <span className={current ? 'text-teal-500 dark:text-teal-400/80' : 'text-gray-400 dark:text-gray-500'}>生图 SOP</span>
      <span className="max-w-[160px] truncate font-medium">
        {current?.name ?? '反推'}
      </span>
      <EditIcon />
    </button>
  )
}
