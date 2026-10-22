import { useEffect, useState } from 'react'

import { getActiveApiProfile } from '../lib/apiProfiles'
import { rewriteSopText } from '../lib/sopPipeline'
import { useStore } from '../store'
import MarkdownEditor from './MarkdownEditor'

interface Props {
  title: string
  value: string
  onClose: () => void
  onSave: (next: string) => void
}

/** SOP 的 Markdown 编辑器，整块文本直接改；也可以让 AI 按一句话要求改写 */
export default function SopEditorModal({ title, value, onClose, onSave }: Props) {
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const [draft, setDraft] = useState(value)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  /** AI 改写前的正文，用来一步撤回 */
  const [undoBackup, setUndoBackup] = useState<string | null>(null)

  // 关掉时丢弃未保存的改写，别把结果留到下次打开
  useEffect(() => {
    return () => setUndoBackup(null)
  }, [])

  const runAi = async () => {
    const ask = instruction.trim()
    if (!ask || busy) return
    if (!draft.trim()) {
      showToast('SOP 正文是空的，先写点内容再让 AI 改', 'info')
      return
    }
    const profile = getActiveApiProfile(settings)
    if (!profile?.apiKey) {
      showToast('当前接口配置没有 Key，先在设置里填好', 'error')
      return
    }
    setBusy(true)
    try {
      const next = await rewriteSopText(profile, draft, ask)
      if (!next.trim()) throw new Error('模型返回了空内容')
      setUndoBackup(draft)
      setDraft(next)
      setInstruction('')
      showToast('已按你的要求改写，确认无误后点保存', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI 修改失败', 'error')
    } finally {
      setBusy(false)
    }
  }

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
          {undoBackup != null && (
            <button
              type="button"
              onClick={() => {
                setDraft(undoBackup)
                setUndoBackup(null)
              }}
              disabled={busy}
              className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-white/[0.06]"
            >
              撤回改写
            </button>
          )}
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
            onImportFile={(text, fileName) => {
              setDraft(text)
              useStore.getState().showToast(`已导入 ${fileName}，点保存写回`, 'success')
            }}
          />

          <div className="mt-3 shrink-0 rounded-lg border border-dashed border-blue-200 bg-blue-50/60 p-1.5 dark:border-blue-500/30 dark:bg-blue-500/10">
            <div className="flex items-center gap-1">
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runAi()
                }}
                disabled={busy}
                placeholder="让 AI 怎么改？例如：把画面改成夜景，文字规范多留一条标题位"
                className="min-w-0 flex-1 rounded border border-blue-200 bg-white px-1.5 py-1 text-[11px] text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none disabled:opacity-60 dark:border-blue-500/30 dark:bg-gray-800 dark:text-gray-100"
              />
              <button
                type="button"
                onClick={() => void runAi()}
                disabled={busy || !instruction.trim()}
                className="shrink-0 rounded bg-blue-500 px-2 py-1 text-[11px] text-white transition hover:bg-blue-600 disabled:opacity-40"
              >
                {busy ? '修改中' : 'AI 修改'}
              </button>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-gray-400">
              直接改写当前正文，点「保存」才写回任务卡；不满意可以「撤回改写」。
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-2 text-[11px] text-gray-400 dark:border-white/[0.08]">
          <span>保存后，这份 SOP 会同步到同一张卡片的全部任务。</span>
          <span>{draft.length} 字</span>
        </div>
      </div>
    </div>
  )
}
