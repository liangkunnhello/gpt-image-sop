import { useState } from 'react'

import { getActiveApiProfile } from '../lib/apiProfiles'
import { rewriteText } from '../lib/sopPipeline'
import { useStore } from '../store'

interface Props {
  /** 当前编辑器里的正文，作为改写的原文 */
  value: string
  /** 改写完成，交给调用方另存为新内容 */
  onDone: (next: string) => void
}

/** 内嵌在编辑框里的「AI 修改」：按一句话要求改写，结果交出去另存 */
export default function AiRewriteBar({ value, onDone }: Props) {
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async () => {
    const ask = instruction.trim()
    if (!ask || busy) return
    if (!value.trim()) {
      showToast('正文是空的，先写点内容再让 AI 改', 'info')
      return
    }
    const profile = getActiveApiProfile(settings)
    if (!profile?.apiKey) {
      showToast('当前接口配置没有 Key，先在设置里填好', 'error')
      return
    }
    setBusy(true)
    try {
      const next = await rewriteText(profile, value, ask)
      if (!next.trim()) throw new Error('模型返回了空内容')
      onDone(next)
      setInstruction('')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI 修改失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-blue-200 bg-blue-50/60 p-1.5 dark:border-blue-500/30 dark:bg-blue-500/10">
      <div className="flex items-center gap-1">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
          placeholder="让 AI 怎么改？例如：更口语，突出价格"
          className="min-w-0 flex-1 rounded border border-blue-200 bg-white px-1.5 py-1 text-[11px] text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-blue-500/30 dark:bg-gray-800 dark:text-gray-100"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !instruction.trim()}
          className="shrink-0 rounded bg-blue-500 px-2 py-1 text-[11px] text-white transition hover:bg-blue-600 disabled:opacity-40"
        >
          {busy ? '修改中' : 'AI 修改'}
        </button>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-gray-400">结果会另存为一份新内容，原内容不动。</p>
    </div>
  )
}
