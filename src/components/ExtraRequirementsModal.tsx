import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useSopStore } from '../lib/sopStore'
import { pickExtraRequirements, resolveExtraIds } from '../lib/extraRequirements'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

/** 额外要求的勾选清单：弹窗里那几行用它，和库里的内容共用同一份数据 */
export function ExtraChecklist({
  value,
  onChange,
  className = '',
}: {
  value: string[]
  onChange: (ids: string[]) => void
  className?: string
}) {
  const all = useSopStore((s) => s.extraRequirements)
  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id])
  }
  return (
    <div className={`space-y-1.5 ${className}`}>
      {all.map((item) => (
        <label
          key={item.id}
          className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 transition-colors hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/[0.04]"
        >
          <input
            type="checkbox"
            checked={value.includes(item.id)}
            onChange={() => toggle(item.id)}
            className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">{item.name}</span>
            <span className="mt-0.5 block whitespace-pre-wrap text-[11px] leading-relaxed text-gray-400 line-clamp-2">
              {item.content}
            </span>
          </span>
        </label>
      ))}
      {!all.length && (
        <div className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-center text-[11px] text-gray-400 dark:border-white/10">
          还没有额外要求，点「管理额外要求」加一条
        </div>
      )}
    </div>
  )
}

/** 额外要求管理：增删改 + 勾选，全局一份、按方向多选。显隐自己管，挂一次就行 */
export default function ExtraRequirementsModal() {
  const open = useSopStore((s) => s.extraOpen)
  const setOpen = useSopStore((s) => s.setExtraOpen)
  const onClose = () => setOpen(false)
  useCloseOnEscape(open, onClose)
  usePreventBackgroundScroll(open)

  const all = useSopStore((s) => s.extraRequirements)
  const extraPick = useSopStore((s) => s.extraPick)
  const directions = useSopStore((s) => s.directions)
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const setExtraPick = useSopStore((s) => s.setExtraPick)
  const addExtraRequirement = useSopStore((s) => s.addExtraRequirement)
  const updateExtraRequirement = useSopStore((s) => s.updateExtraRequirement)
  const removeExtraRequirement = useSopStore((s) => s.removeExtraRequirement)

  const picked = useMemo(
    () => (activeDirectionId ? resolveExtraIds(extraPick, activeDirectionId) : []),
    [extraPick, activeDirectionId],
  )
  const enabled = useMemo(() => pickExtraRequirements(all, picked), [all, picked])

  const directionName = activeDirectionId
    ? directions.find((node) => node.id === activeDirectionId)?.name ?? ''
    : ''

  const toggle = (id: string) => {
    if (!activeDirectionId) return
    const next = picked.includes(id) ? picked.filter((item) => item !== id) : [...picked, id]
    setExtraPick(activeDirectionId, next)
  }

  if (!open) return null

  const modal = (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-start justify-between border-b border-gray-100 px-5 py-3 dark:border-white/[0.08]">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">额外要求</h3>
            <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
              选中的条目会作为「硬性约束」写进提示词，SOP / 变量 / 普通模式都生效。
              {directionName ? ` 当前为方向「${directionName}」勾选，共 ${enabled.length} 条生效。` : ' 先在左侧选一个方向才能勾选。'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-white/10"
            aria-label="关闭"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-3 custom-scrollbar">
          {all.map((item) => (
            <div key={item.id} className="rounded-xl border border-gray-200 p-3 dark:border-white/10">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={picked.includes(item.id)}
                  disabled={!activeDirectionId}
                  onChange={() => toggle(item.id)}
                  title={activeDirectionId ? '勾选后这条要求参与生成' : '先选一个方向'}
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-blue-500 disabled:opacity-40"
                />
                <input
                  value={item.name}
                  onChange={(event) => updateExtraRequirement(item.id, { name: event.target.value })}
                  placeholder="规则名（简短，会显示在输入区与详情页）"
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-gray-800 outline-none focus:border-blue-400 dark:border-white/10 dark:bg-gray-800 dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={() => removeExtraRequirement(item.id)}
                  className="shrink-0 rounded px-1.5 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
                >
                  删除
                </button>
              </div>
              <textarea
                value={item.content}
                onChange={(event) => updateExtraRequirement(item.id, { content: event.target.value })}
                rows={3}
                placeholder="判定标准：要模型怎么做（这句会原样写进提示词）"
                className="mt-2 w-full resize-y rounded-lg border border-gray-200 px-2 py-1.5 text-[11px] leading-relaxed text-gray-700 outline-none focus:border-blue-400 dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              />
              <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400">
                {item.builtin && <span className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-white/[0.06]">内置</span>}
                {item.behavior === 'strip-cta' && <span>另会剔掉 SOP 里的「留出按钮位置」这类句子</span>}
                {item.behavior === 'avoid-overlay' && <span>另会把后处理预留区的坐标告诉模型</span>}
                {!item.content.trim() && <span className="text-amber-600 dark:text-amber-400">内容为空，勾了也不会生效</span>}
              </div>
            </div>
          ))}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={() => addExtraRequirement('', '')}
            className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-white/[0.08] dark:text-gray-200 dark:hover:bg-white/[0.14]"
          >
            + 新增一条
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-600"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
