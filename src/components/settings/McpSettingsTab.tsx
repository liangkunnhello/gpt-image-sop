import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  getMcpStatus,
  httpConfig,
  mcpEndpoint,
  rotateMcpToken,
  setMcpEnabled,
  setMcpPort,
  stdioConfig,
  type McpStatus,
} from '../../lib/mcpClient'
import { buildSkillMarkdown, MCP_SKILL_FILE_NAME } from '../../lib/mcpSkill'
import { isTauri } from '../../lib/platform'
import { saveFile } from '../../lib/saveFile'
import { useStore } from '../../store'

/** 运行中时轮询间隔：只想知道有没有外部客户端在调，3 秒够用 */
const POLL_MS = 3000

const inputClass = 'w-24 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs text-gray-700 outline-none transition-all duration-200 hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]'
const buttonClass = 'shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white'

function statusBadge(status: McpStatus) {
  if (status.running) {
    return {
      label: '监听中',
      className: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
    }
  }
  if (status.enabled) {
    return {
      label: '未运行',
      className: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
    }
  }
  return {
    label: '已关闭',
    className: 'bg-black/[0.05] text-gray-500 dark:bg-white/[0.08] dark:text-gray-400',
  }
}

export default function McpSettingsTab() {
  const showToast = useStore((s) => s.showToast)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [portDraft, setPortDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSkill, setShowSkill] = useState(false)
  // 端口输入框正在编辑时，轮询回来的值不能把它覆盖掉
  const editingPort = useRef(false)

  const apply = useCallback((next: McpStatus) => {
    setStatus(next)
    if (!editingPort.current) setPortDraft(String(next.port))
    if (next.error) showToast(next.error, 'error')
  }, [showToast])

  const refresh = useCallback(async () => {
    try {
      apply(await getMcpStatus())
    } catch (err) {
      console.error('读取 MCP 状态失败：', err)
    }
  }, [apply])

  useEffect(() => {
    if (!isTauri) return
    void refresh()
  }, [refresh])

  // 只想知道请求次数和监听状态，运行中才轮询
  useEffect(() => {
    if (!isTauri || !status?.running) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.running, refresh])

  const skill = useMemo(() => buildSkillMarkdown(), [])
  const endpoint = status ? mcpEndpoint(status) : ''
  const badge = status ? statusBadge(status) : null

  const run = async (action: () => Promise<McpStatus>, failText: string) => {
    setBusy(true)
    try {
      apply(await action())
    } catch (err) {
      showToast(`${failText}：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`已复制${label}`, 'success')
    } catch {
      showToast('复制失败，请手动选中文本复制', 'error')
    }
  }

  const exportSkill = async () => {
    try {
      const path = await saveFile(
        new Blob([skill], { type: 'text/markdown' }),
        MCP_SKILL_FILE_NAME,
      )
      if (path) showToast('Skill 已导出', 'success')
    } catch (err) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  if (!isTauri) {
    return (
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">MCP</h4>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          MCP 服务需要跑在桌面客户端里，网页版没有本地端口，无法提供给外部工具连接。
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">服务</h4>

        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-500"
            checked={status?.enabled ?? false}
            disabled={busy || !status}
            onChange={(e) => void run(() => setMcpEnabled(e.target.checked), '切换 MCP 状态失败')}
          />
          <span className="min-w-0">
            <span className="block text-sm text-gray-700 dark:text-gray-200">开启 MCP</span>
            <span className="block text-xs leading-relaxed text-gray-500 dark:text-gray-500">
              允许外部 Coding 工具与 Agent 操作本应用。开启后把下面的客户端配置贴到对应工具里即可。
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-300">连接状态</span>
            {badge && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.className}`}>
                {badge.label}
              </span>
            )}
            {status?.running && (
              <span className="text-xs text-gray-500 dark:text-gray-500">
                已处理 {status.requests} 次请求
                {status.lastRequestAt ? `，最近 ${new Date(status.lastRequestAt).toLocaleTimeString()}` : ''}
              </span>
            )}
          </div>
          <button type="button" className={buttonClass} onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
        </div>

        {status?.error && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600 dark:bg-red-500/10 dark:text-red-400">
            {status.error}
          </p>
        )}

        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          服务跑在本应用进程里，关掉应用就断开；出图和数据读写都要求应用保持打开。
        </p>
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">服务地址</h4>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-gray-600 dark:text-gray-300">监听端口</span>
          <div className="flex shrink-0 items-center gap-2">
            <input
              type="number"
              min={1024}
              max={65535}
              className={inputClass}
              value={portDraft}
              onFocus={() => { editingPort.current = true }}
              onBlur={() => { editingPort.current = false }}
              onChange={(e) => setPortDraft(e.target.value)}
            />
            <button
              type="button"
              className={buttonClass}
              disabled={busy || !portDraft || Number(portDraft) === status?.port}
              onClick={() => void run(() => setMcpPort(Number(portDraft)), '保存端口失败')}
            >
              保存
            </button>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          默认 10588；被占用时会自动顺延到下一个可用端口。改端口后地址会变，需要重新复制客户端配置。
        </p>

        <div
          data-selectable-text
          className="break-all rounded-xl border border-gray-200 bg-black/[0.02] px-3 py-2 font-mono text-xs text-gray-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300"
        >
          {endpoint || '服务未启动'}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={!endpoint}
            onClick={() => void copy(httpConfig(status as McpStatus), ' HTTP 配置')}
          >
            复制 HTTP 配置
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!endpoint}
            onClick={() => void copy(stdioConfig(status as McpStatus), ' stdio 配置')}
          >
            复制 stdio 配置
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void run(rotateMcpToken, '重置令牌失败')}
          >
            重置令牌
          </button>
        </div>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          配置里带访问令牌，等于这份地址的调用权限，只发给可信的客户端。令牌重置后旧配置立即失效。
        </p>
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">Skill</h4>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-500">
          SKILL.md 说明这些工具怎么用、参数怎么填，含普通 / SOP / 变量三种模式的用法与选择建议。
          装到 Coding 工具的技能目录后，Agent 会在合适的时机自己调用。
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => setShowSkill((v) => !v)}>
            {showSkill ? '收起 Skill' : '查看 Skill'}
          </button>
          <button type="button" className={buttonClass} onClick={() => void copy(skill, ' Skill 全文')}>
            复制
          </button>
          <button type="button" className={buttonClass} onClick={() => void exportSkill()}>
            导出 Skill
          </button>
        </div>
        {showSkill && (
          <pre
            data-selectable-text
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-gray-200 bg-black/[0.02] p-3 font-mono text-[11px] leading-relaxed text-gray-600 custom-scrollbar dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300"
          >
            {skill}
          </pre>
        )}
      </section>
    </div>
  )
}
