import type { SopPick } from '../lib/sopStore'
import { NO_PRESET, useSopStore } from '../lib/sopStore'
import type { VariablePrompt } from '../types'
import { BUILTIN_VARIABLE_PROMPT } from '../lib/variablePipeline'

/** 按「默认项 → 上次使用 → 第一条」决定当前变量提示词；列表按产品共享 */
export function resolveVariablePrompt(
  prompts: VariablePrompt[],
  productId: string,
  directionId: string,
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
): VariablePrompt | undefined {
  const list = prompts.filter((item) => item.productId === productId)
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  if (pick.variablePromptId === NO_PRESET) return undefined
  if (pick.variablePromptId) return list.find((item) => item.id === pick.variablePromptId)
  // 一条都没建时退回内置策略，保证变量模式开箱能跑
  return list[0] ?? BUILTIN_VARIABLE_PROMPT
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

/** 输入框上方的入口：显示当前变量提示词，点开进提示词库的「变量提示词」分组 */
export default function VariablePromptPicker({ productId, directionId }: Props) {
  const variablePrompts = useSopStore((s) => s.variablePrompts)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const setLibraryTab = useSopStore((s) => s.setLibraryTab)

  const current = resolveVariablePrompt(variablePrompts, productId, directionId, lastPick, defaultPick)
  const isNone = (defaultPick[directionId] ?? lastPick[directionId] ?? {}).variablePromptId === NO_PRESET
  const isBuiltin = current?.id === BUILTIN_VARIABLE_PROMPT.id

  return (
    <button
      type="button"
      onClick={() => setLibraryTab('variable')}
      title={`变量提示词：${current?.content || '未设置'}（点击打开提示词库）`}
      className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50/70 px-2.5 py-1 text-xs text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300 dark:hover:bg-violet-500/20"
    >
      <span className="text-violet-400 dark:text-violet-400/70">变量提示词</span>
      <span className="max-w-[140px] truncate font-medium">
        {isNone ? '不使用' : (current?.name ?? '未设置')}
      </span>
      {isBuiltin && <span className="shrink-0 text-[10px] text-violet-400">内置</span>}
      <EditIcon />
    </button>
  )
}
