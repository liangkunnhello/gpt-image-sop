import { useState } from 'react'
import type { ApiProfile } from '../types'
import { fetchModelCatalog, type ModelCatalog } from '../lib/modelCatalog'
import { SOP_TEXT_MODEL } from '../lib/sopPipeline'

interface Props {
  profile: ApiProfile
  disabled?: boolean
  onChange: (model: string) => void
}

const GROUPS: Array<{ key: keyof ModelCatalog; label: string; hint?: string }> = [
  { key: 'text', label: '文本模型' },
  { key: 'image', label: '图片模型' },
  { key: 'video', label: '视频模型', hint: '仅列出，当前版本不参与生图' },
]

/** SOP 模式反推 SOP 与写提示词所用的模型 */
export default function SopModelField({ profile, disabled, onChange }: Props) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setBusy(true)
    setError('')
    try {
      setCatalog(await fetchModelCatalog(profile))
    } catch (err) {
      setError(err instanceof Error ? err.message : '拉取失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="block">
      <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">反推与提示词模型</span>
      <div className="flex gap-2">
        <input
          value={profile.sopTextModel ?? ''}
          onChange={(e) => onChange(e.target.value)}
          type="text"
          disabled={disabled}
          placeholder={SOP_TEXT_MODEL}
          className="min-w-0 flex-1 rounded-xl border border-transparent bg-black/[0.04] px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50"
        />
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="shrink-0 rounded-xl border border-gray-200 px-3 text-sm text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]"
        >
          {busy ? '拉取中' : '拉取模型'}
        </button>
      </div>

      {error && <div className="mt-1.5 text-xs text-red-500">拉取失败：{error}</div>}

      {catalog && (
        <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-gray-200 p-1 dark:border-white/10">
          {GROUPS.map((group) => {
            const list = catalog[group.key]
            if (!list.length) return null
            return (
              <div key={group.key} className="mb-1 last:mb-0">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-400">
                  <span>{group.label}</span>
                  <span className="tabular-nums">{list.length}</span>
                  {group.hint && <span className="text-gray-300">· {group.hint}</span>}
                </div>
                {list.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onChange(id)}
                    className={`block w-full truncate rounded-lg px-2 py-1 text-left text-xs transition-colors ${
                      profile.sopTextModel === id
                        ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                        : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    {id}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-500">
        SOP 模式用它反推 SOP、编写提示词；留空则用默认 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{SOP_TEXT_MODEL}</code>。
      </div>
    </div>
  )
}
