import { useEffect, useRef, useState } from 'react'

import { getActiveApiProfile } from '../lib/apiProfiles'
import { generateTitle } from '../lib/sopPipeline'
import { useStore } from '../store'

/** 正文短于这个长度时不自动总结，几句话都没有总结不出东西 */
const MIN_CHARS = 6
/** 停止输入多久后自动总结，避免每敲一个字都发一次请求 */
const AUTO_DELAY = 1500

interface Props {
  /** 当前标题 */
  name: string
  /** 正文，内容一变就在停顿后自动总结标题 */
  content: string
  /** 类型说明，如「卖点」「风格」「系统提示词」，作为提示词里的语境 */
  kindLabel?: string
  onChangeName: (name: string) => void
}

/** 标题行：标题输入框 + 「AI 起名」，正文改完停顿一下会自动把标题填上 */
export default function AiTitleBar({ name, content, kindLabel = '', onChangeName }: Props) {
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const [busy, setBusy] = useState(false)

  // 用户手动改过标题就不再自动覆盖，清空后重新放行
  const touched = useRef(false)
  // 当前标题是 AI 填的：只有这种情况才允许下一次自动总结再覆盖它
  const autoFilled = useRef(false)
  // 记录上一次的正文：挂载时的正文不触发，避免打开已有条目就请求一次
  const lastContent = useRef(content)
  // 请求进行中标记，定时器里读不到最新的 state，只能靠 ref
  const busyRef = useRef(false)

  const run = async (silent: boolean) => {
    const text = content.trim()
    if (!text || busyRef.current) return
    const profile = getActiveApiProfile(settings)
    if (!profile?.apiKey) {
      if (!silent) showToast('当前接口配置没有 Key，先在设置里填好', 'error')
      return
    }
    busyRef.current = true
    setBusy(true)
    try {
      const title = await generateTitle(profile, text, kindLabel)
      if (title) {
        autoFilled.current = true
        onChangeName(title)
      }
    } catch (err) {
      // 自动总结失败不打扰用户，正文还在，手动点按钮时再报错
      if (!silent) showToast(err instanceof Error ? err.message : 'AI 起名失败', 'error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  useEffect(() => {
    if (content === lastContent.current) return
    lastContent.current = content
    if (content.trim().length < MIN_CHARS) return
    // 标题是用户自己写的，就不要再抢
    if (touched.current && name.trim()) return
    // 已有标题（打开旧条目）也不动，想换点右边按钮
    if (name.trim() && !autoFilled.current) return
    const timer = setTimeout(() => void run(true), AUTO_DELAY)
    return () => clearTimeout(timer)
  }, [content])

  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => {
          touched.current = true
          autoFilled.current = false
          onChangeName(e.target.value)
        }}
        placeholder={kindLabel ? `${kindLabel}标题，留空由 AI 自动总结` : '标题，留空由 AI 自动总结'}
        className="min-w-0 flex-1 rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-700 placeholder:text-gray-300 dark:border-white/10 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500"
      />
      <button
        type="button"
        onClick={() => {
          // 手动点一下视为同意重新总结，重新允许后续自动覆盖
          touched.current = false
          autoFilled.current = true
          void run(false)
        }}
        disabled={busy || !content.trim()}
        title="根据正文自动总结一个短标题"
        className="shrink-0 rounded border border-blue-200 bg-white px-1.5 py-1 text-[11px] text-blue-600 transition hover:bg-blue-50 disabled:opacity-40 dark:border-blue-500/30 dark:bg-gray-800 dark:text-blue-300 dark:hover:bg-blue-500/10"
      >
        {busy ? '总结中' : 'AI 起名'}
      </button>
    </div>
  )
}
