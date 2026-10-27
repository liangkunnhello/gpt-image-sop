import { useState } from 'react'
import { useSopStore } from '../lib/sopStore'
import {
  DEFAULT_LINGJING_BASE,
  downloadImageAsDataUrl,
  runLingjingImport,
  type LingjingImportResult,
} from '../lib/lingjingImport'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

/**
 * 灵境配置导入。
 *
 * 只做两件事：把「分组 → 产品 → 方向」并进业务树、把每个组合生效的水印转成后处理模板。
 * 卖点 / 风格 / NAS 交付地址暂不导（见 lingjing-mcp 的规范文档，那几项本地模型还不一致）。
 *
 * 凭证只放在组件状态里，导入结束就没了 —— 不落盘、不进日志、不进提示词。
 */
export default function LingjingImportModal({ onClose }: { onClose: () => void }) {
  const directions = useSopStore((s) => s.directions)
  const postTemplates = useSopStore((s) => s.postTemplates)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LINGJING_BASE)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<LingjingImportResult | null>(null)

  useCloseOnEscape(!running, onClose)
  usePreventBackgroundScroll(true)

  const canRun = Boolean(username.trim() && password && !running)

  const run = async () => {
    if (!canRun) return
    setRunning(true)
    setError('')
    setResult(null)
    setProgress({ done: 0, total: 0, label: '正在登录灵境…' })
    try {
      const imported = await runLingjingImport({
        baseUrl,
        username,
        password,
        existingNodes: useSopStore.getState().directions,
        existingTemplates: useSopStore.getState().postTemplates,
        resolveLogo: (url) => downloadImageAsDataUrl(url),
        onProgress: (done, total, label) => setProgress({ done, total, label }),
      })
      // 一次性写入：树和模板都算好了再落库，中途失败不会留下半截数据
      useSopStore.setState({
        directions: imported.nodes,
        postTemplates: imported.postTemplates,
      })
      setResult(imported)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      setProgress(null)
      // 用完即弃，别留在内存里
      setPassword('')
    }
  }

  const percent = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={() => { if (!running) onClose() }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">导入灵境配置</h2>
          <span className="text-[11px] text-gray-400">分组 → 产品 → 方向，以及每套水印转成的后处理模板</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            title="关闭（Esc）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-2.5">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">灵境地址</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={running}
                spellCheck={false}
                placeholder={DEFAULT_LINGJING_BASE}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 outline-none transition focus:border-blue-300 focus:ring-1 focus:ring-blue-200 disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-200"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">账号</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={running}
                  autoComplete="off"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 outline-none transition focus:border-blue-300 focus:ring-1 focus:ring-blue-200 disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">密码</span>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void run() }}
                  disabled={running}
                  type="password"
                  autoComplete="off"
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 outline-none transition focus:border-blue-300 focus:ring-1 focus:ring-blue-200 disabled:opacity-60 dark:border-white/10 dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>
            </div>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
            账号密码只用于这一次登录，导入结束就丢弃，不会保存到本地。
            导入按「同名更新」处理：同级同名节点复用，同名同尺寸的模板覆盖内容、保留本地 id。
          </p>

          {running && (
            <div className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-white/[0.04]">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-gray-600 dark:text-gray-300">
                  {progress?.label || '正在处理…'}
                </span>
                <span className="shrink-0 text-gray-400">
                  {progress && progress.total > 0 ? `${progress.done}/${progress.total}` : ''}
                </span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
                <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
              </div>
              <div className="mt-1 text-[10px] text-gray-400">
                每个「产品-方向」都要单独解析一次生效水印，131 个组合大概需要 1~2 分钟
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-600 dark:bg-red-500/10 dark:text-red-400">
              {error}
            </p>
          )}

          {result && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs dark:border-emerald-500/25 dark:bg-emerald-500/[0.08]">
              <div className="font-medium text-emerald-700 dark:text-emerald-300">
                导入完成{result.canceled ? '（中途取消，已导入的部分保留）' : ''}
              </div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                <li>方向树：新增 {result.tree.created} 个，复用 {result.tree.reused} 个</li>
                <li>
                  后处理模板：新增 {result.templates.created} 套，更新 {result.templates.updated} 套
                  {result.templates.logosSkipped > 0 && `，${result.templates.logosSkipped} 个 logo 图层取不到图片已跳过`}
                </li>
                {result.templates.failed.length > 0 && (
                  <li className="text-amber-600 dark:text-amber-400">
                    {result.templates.failed.length} 条没导成：{result.templates.failed.slice(0, 3).join('；')}
                    {result.templates.failed.length > 3 ? ` 等 ${result.templates.failed.length} 条` : ''}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[10px] text-gray-400">
            现有 {directions.length} 个节点、{Object.values(postTemplates).flat().length} 套模板
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-lg px-3 py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-white/10"
          >
            {result ? '完成' : '取消'}
          </button>
          <button
            type="button"
            onClick={() => { void run() }}
            disabled={!canRun}
            className="rounded-lg bg-blue-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? '导入中…' : result ? '再导一次' : '开始导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
