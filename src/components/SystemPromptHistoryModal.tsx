import { useMemo, useState } from 'react'
import type { SopSystemPrompt } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

interface Props {
  /** 当前正在编辑的系统提示词（含 history） */
  prompt: SopSystemPrompt
  onClose: () => void
  /** 恢复某个版本；由调用方负责把编辑器里的草稿也同步过去 */
  onRestore: (versionId: string) => void
}

function formatArchivedAt(ts: number) {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 列表里只放一句话，全文靠右侧预览看 */
function summaryOf(text: string, max = 42) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 系统提示词的历史版本。
 *
 * 左边按时间列出被替换掉的那些版本，右边预览全文，确认无误再恢复。
 * 恢复本身也会把「当前这版」归档，所以误点还能再退回来。
 */
export default function SystemPromptHistoryModal({ prompt, onClose, onRestore }: Props) {
  const history = useMemo(() => prompt.history ?? [], [prompt.history])
  const [selectedId, setSelectedId] = useState(() => history[0]?.id ?? '')
  const selected = history.find((item) => item.id === selectedId) ?? history[0]

  useCloseOnEscape(true, onClose)

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[min(80vh,620px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-5 border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.08]">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
              历史版本 · {prompt.name}
            </h2>
            <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
              共 {history.length} 个旧版本；每次保存新内容都会把上一版收进来
            </p>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.06]"
          >
            关闭
          </button>
        </div>

        {history.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
              还没有历史版本。改完内容点「保存」时，被替换掉的那一版会自动存到这里。
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-100 dark:border-white/[0.08]">
              {history.map((version) => {
                const active = version.id === selected?.id
                return (
                  <button
                    key={version.id}
                    type="button"
                    onClick={() => setSelectedId(version.id)}
                    className={`block w-full border-b border-gray-50 px-4 py-2.5 text-left transition-colors dark:border-white/[0.04] ${active
                      ? 'bg-blue-50 dark:bg-blue-500/[0.12]'
                      : 'hover:bg-gray-50 dark:hover:bg-white/[0.04]'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 font-mono text-[11px] ${active ? 'text-blue-600 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'}`}>
                        {formatArchivedAt(version.archivedAt)}
                      </span>
                      <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                        {version.content.length} 字
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-gray-600 dark:text-gray-300">
                      {version.name}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-gray-400 dark:text-gray-500">
                      {summaryOf(version.content)}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed text-gray-700 dark:text-gray-300">
                {selected?.content ?? ''}
              </pre>
            </div>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 border-t border-gray-100 px-5 py-3 dark:border-white/[0.08]">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            恢复后会替换当前正文，当前这版也会保存成一个历史版本。
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && onRestore(selected.id)}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.06]"
          >
            恢复这个版本
          </button>
        </div>
      </div>
    </div>
  )
}
