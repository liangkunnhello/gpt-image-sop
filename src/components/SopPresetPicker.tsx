import type { SopPreset } from '../lib/sopStore'
import { NO_PRESET, useSopStore } from '../lib/sopStore'
import { resolvePickedPreset } from '../lib/sopPresets'

// 解析逻辑搬到了 lib（命名、任务快照也要用），这里保留导出，避免改了所有调用方
export { resolvePickedPreset } from '../lib/sopPresets'

interface Props {
  kind: SopPreset['kind']
  label: string
  directionId: string
  /** 自身 → 父 → 根 的作用域链，就近继承 */
  scopeIds: string[]
}

const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 shrink-0 text-gray-400">
    <path strokeLinecap="round" d="M4 20h4l10-10-4-4L4 16v4z" />
  </svg>
)

/** 输入框上方的入口：只显示当前用的是哪份，点开进提示词库弹窗 */
export default function SopPresetPicker({ kind, label, directionId, scopeIds }: Props) {
  const presets = useSopStore((s) => s.presets)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const setLibraryTab = useSopStore((s) => s.setLibraryTab)

  const current = resolvePickedPreset(presets, directionId, scopeIds, kind, lastPick, defaultPick)
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  const currentId = kind === 'point' ? pick.pointId : pick.styleId
  const isNone = currentId === NO_PRESET

  return (
    <button
      type="button"
      onClick={() => setLibraryTab(kind)}
      title={`${label}：${current?.content || '未设置'}（点击打开提示词库）`}
      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/70 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
    >
      <span className="text-gray-400 dark:text-gray-500">{label}</span>
      <span className="max-w-[140px] truncate font-medium text-gray-700 dark:text-gray-200">
        {current?.name ?? (isNone ? '不使用' : '未设置')}
      </span>
      <EditIcon />
    </button>
  )
}
