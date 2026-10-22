import type { SopPick } from '../lib/sopStore'
import { NO_PRESET, useSopStore } from '../lib/sopStore'
import type { SopSystemPrompt } from '../types'

/**
 * 按「默认项 → 上次使用 → 就近第一条」决定当前系统提示词。
 *
 * scopeIds 是从当前节点往上的作用域链（自身 → 父产品 → 类目）：
 * 方向自己没配就继承产品的，产品没配再往上一层找，
 * 这样「先建产品配提示词、后建方向」不会变成未设置。
 */
export function resolveSystemPrompt(
  prompts: SopSystemPrompt[],
  scopeIds: string[],
  directionId: string,
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
) {
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  if (pick.promptId === NO_PRESET) return undefined
  if (pick.promptId) {
    for (const scopeId of scopeIds) {
      const hit = prompts.find((item) => item.productId === scopeId && item.id === pick.promptId)
      if (hit) return hit
    }
    return undefined
  }
  for (const scopeId of scopeIds) {
    const first = prompts.find((item) => item.productId === scopeId)
    if (first) return first
  }
  return undefined
}

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

/** 输入框上方的入口：只显示当前用的是哪份，点开进提示词库弹窗 */
export default function SopSystemPromptPicker({ scopeIds, directionId }: Props) {
  const systemPrompts = useSopStore((s) => s.systemPrompts)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const setLibraryTab = useSopStore((s) => s.setLibraryTab)

  const current = resolveSystemPrompt(systemPrompts, scopeIds, directionId, lastPick, defaultPick)
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
