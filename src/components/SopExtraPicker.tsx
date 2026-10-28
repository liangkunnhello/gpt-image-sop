import { useSopStore } from '../lib/sopStore'
import { pickExtraRequirements, resolveExtraIds } from '../lib/extraRequirements'

/**
 * 输入框上方的「额外要求」入口：显示当前方向选中几条，点开管理弹窗。
 *
 * 这些条目不直接写死在任何地方 —— 在弹窗里能改名、改内容、加新条目、删掉不要的，
 * 选中的会作为「硬性约束」拼进提示词。
 */
export default function SopExtraPicker() {
  const all = useSopStore((s) => s.extraRequirements)
  const extraPick = useSopStore((s) => s.extraPick)
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const setExtraOpen = useSopStore((s) => s.setExtraOpen)

  const ids = resolveExtraIds(extraPick, activeDirectionId)
  const picked = pickExtraRequirements(all, ids)
  const names = picked.map((item) => item.name).join('、')

  return (
    <button
      type="button"
      onClick={() => setExtraOpen(true)}
      title={picked.length ? `已选：${names}（点击管理）` : '还没有选额外要求（点击管理）'}
      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/70 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
    >
      <span className="text-gray-400 dark:text-gray-500">额外要求</span>
      <span className={`font-medium ${picked.length ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400'}`}>
        {picked.length} 条
      </span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 shrink-0 text-gray-400">
        <path strokeLinecap="round" d="M4 20h4l10-10-4-4L4 16v4z" />
      </svg>
    </button>
  )
}
