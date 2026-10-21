import type { SopPick } from '../lib/sopStore'
import { NO_PRESET, useSopStore } from '../lib/sopStore'
import type { SopSystemPrompt } from '../types'

/** 按「默认项 → 上次使用 → 第一项」的顺序决定当前系统提示词；列表按产品共享 */
export function resolveSystemPrompt(
  prompts: SopSystemPrompt[],
  productId: string,
  directionId: string,
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
) {
  const list = prompts.filter((item) => item.productId === productId)
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  if (pick.promptId === NO_PRESET) return undefined
  if (pick.promptId) return list.find((item) => item.id === pick.promptId)
  return list[0]
}

interface Props {
  productId: string
  directionId: string
}

const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 shrink-0 text-gray-400">
    <path strokeLinecap="round" d="M4 20h4l10-10-4-4L4 16v4z" />
  </svg>
)

/** 输入框上方的入口：只显示当前用的是哪份，点开进提示词库弹窗 */
export default function SopSystemPromptPicker({ productId, directionId }: Props) {
  const systemPrompts = useSopStore((s) => s.systemPrompts)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const setLibraryTab = useSopStore((s) => s.setLibraryTab)

  const current = resolveSystemPrompt(systemPrompts, productId, directionId, lastPick, defaultPick)
  const isNone = (defaultPick[directionId] ?? lastPick[directionId] ?? {}).promptId === NO_PRESET

  return (
    <button
      type="button"
      onClick={() => setLibraryTab('prompt')}
      title={`系统提示词：${current?.content || '未设置'}（点击打开提示词库）`}
      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/70 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
    >
      <span className="text-gray-400 dark:text-gray-500">系统提示词</span>
      <span className="max-w-[140px] truncate font-medium text-gray-700 dark:text-gray-200">
        {current?.name ?? (isNone ? '不使用' : '未设置')}
      </span>
      <EditIcon />
    </button>
  )
}
