import { useState } from 'react'

import MarkdownEditor from './MarkdownEditor'

interface Props {
  title: string
  value: string
  onClose: () => void
  onSave: (next: string) => void
}

/** SOP 的 Markdown 编辑器，整块文本直接改 */
export default function SopEditorModal({ title, value, onClose, onSave }: Props) {
  const [draft, setDraft] = useState(value)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="max-w-[45%] truncate text-base font-semibold text-gray-800 dark:text-gray-100">{title}</h2>
          <span className="text-[11px] text-gray-400">Markdown</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
          >
            保存
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-4">
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            placeholder="SOP 正文，支持 Markdown"
            className="min-h-0 flex-1"
            autoFocus
          />
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-2 text-[11px] text-gray-400 dark:border-white/[0.08]">
          <span>保存后，这份 SOP 会同步到同一张卡片的全部任务。</span>
          <span>{draft.length} 字</span>
        </div>
      </div>
    </div>
  )
}
