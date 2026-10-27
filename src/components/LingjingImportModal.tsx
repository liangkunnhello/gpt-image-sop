import { useRef, useState } from 'react'
import { useSopStore } from '../lib/sopStore'
import {
  DEFAULT_LINGJING_BASE,
  downloadImageAsDataUrl,
  runLingjingImport,
  type LingjingImportResult,
} from '../lib/lingjingImport'
import {
  parseLingjingArchive,
  runLingjingArchiveImport,
  type ArchiveFileInput,
  type ArchiveImportResult,
  type LingjingArchive,
} from '../lib/lingjingArchive'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

/**
 * 灵境配置导入。两种来源：
 * - **登录灵境**：现拉分组/产品/方向与配置目录，逐组合解析生效水印（要账号，慢但不依赖本地文件）；
 * - **归档文件**：直接读 `lingjing-mcp/archive` / `export` 里的 JSON，离线、更快，
 *   而且组合早就解析好了（省掉 131 次 resolve 请求）。
 *
 * 导入内容：方向树、水印转成的后处理模板，归档模式还可以带上 NAS 交付地址与卖点/风格。
 * 凭证只放在组件状态里，导入结束就丢弃 —— 不落盘、不进日志、不进提示词。
 */
export default function LingjingImportModal({ onClose }: { onClose: () => void }) {
  const directions = useSopStore((s) => s.directions)
  const postTemplates = useSopStore((s) => s.postTemplates)
  const [mode, setMode] = useState<'login' | 'file'>('file')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_LINGJING_BASE)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [error, setError] = useState('')
  const [loginResult, setLoginResult] = useState<LingjingImportResult | null>(null)
  const [fileResult, setFileResult] = useState<ArchiveImportResult | null>(null)
  const [files, setFiles] = useState<ArchiveFileInput[]>([])
  const [archive, setArchive] = useState<LingjingArchive | null>(null)
  const [dragging, setDragging] = useState(false)
  const [wantTemplates, setWantTemplates] = useState(true)
  const [wantDelivery, setWantDelivery] = useState(true)
  const [wantPresets, setWantPresets] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useCloseOnEscape(!running, onClose)
  usePreventBackgroundScroll(true)

  const canLogin = Boolean(username.trim() && password && !running)
  const canImport = archive != null && !running && (archive.mappings.length > 0 || archive.groups.length > 0)

  /** 读文件并立刻解析一次：让用户在按「开始导入」之前就看到认出了什么、缺了什么 */
  const acceptFiles = async (list: FileList | File[]) => {
    const incoming: ArchiveFileInput[] = []
    for (const file of Array.from(list)) {
      if (!/\.json$/i.test(file.name)) continue
      incoming.push({ name: file.name, text: await file.text() })
    }
    if (!incoming.length) return
    setError('')
    setFileResult(null)
    const merged = [...files, ...incoming]
    setFiles(merged)
    try {
      setArchive(parseLingjingArchive(merged))
    } catch (err) {
      setArchive(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const runLogin = async () => {
    if (!canLogin) return
    setRunning(true)
    setError('')
    setLoginResult(null)
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
      setLoginResult(imported)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      setProgress(null)
      // 用完即弃，别留在内存里
      setPassword('')
    }
  }

  const runFileImport = async () => {
    if (!canImport) return
    setRunning(true)
    setError('')
    setFileResult(null)
    setProgress({ done: 0, total: archive?.mappings.length ?? 0, label: '正在转换…' })
    try {
      const store = useSopStore.getState()
      const imported = await runLingjingArchiveImport(files, {
        existingNodes: store.directions,
        existingTemplates: store.postTemplates,
        existingDeliveryDirs: store.deliveryDirs,
        existingPresets: store.presets,
        resolveLogo: (url) => downloadImageAsDataUrl(url),
        wantTemplates,
        wantDelivery,
        wantPresets,
        onProgress: (done, total, label) => setProgress({ done, total, label }),
      })
      useSopStore.setState({
        directions: imported.nodes,
        postTemplates: imported.postTemplates,
        deliveryDirs: imported.deliveryDirs,
        presets: imported.presets,
      })
      setFileResult(imported)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  const percent = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0

  const tabClass = (active: boolean) => (
    `rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
      active
        ? 'bg-blue-500 text-white'
        : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/10'
    }`
  )

  const checkRow = (
    checked: boolean,
    onChange: (value: boolean) => void,
    label: string,
    note: string,
  ) => (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 dark:border-white/10">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={running}
        className="mt-0.5 h-3.5 w-3.5 accent-blue-500"
      />
      <span className="min-w-0">
        <span className="block text-[11px] font-medium text-gray-700 dark:text-gray-200">{label}</span>
        <span className="block text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">{note}</span>
      </span>
    </label>
  )

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={() => { if (!running) onClose() }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">导入灵境配置</h2>
          <div className="flex-1" />
          <div className="flex shrink-0 items-center gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-white/[0.06]">
            <button type="button" onClick={() => setMode('file')} className={tabClass(mode === 'file')}>归档文件</button>
            <button type="button" onClick={() => setMode('login')} className={tabClass(mode === 'login')}>登录灵境</button>
          </div>
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
          {mode === 'login' ? (
            <>
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
                      onKeyDown={(e) => { if (e.key === 'Enter') void runLogin() }}
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
                要逐组合解析生效水印，131 个组合大概 1~2 分钟。若提示「会话失效」，说明浏览器拦了跨站 cookie，
                改用左边的「归档文件」即可。
              </p>
            </>
          ) : (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragging(false)
                  void acceptFiles(e.dataTransfer.files)
                }}
                onClick={() => { if (!running) inputRef.current?.click() }}
                className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
                  dragging
                    ? 'border-blue-400 bg-blue-50/60 dark:border-blue-400/60 dark:bg-blue-500/10'
                    : 'border-gray-200 hover:border-blue-300 dark:border-white/10 dark:hover:border-blue-400/50'
                }`}
              >
                <div className="text-xs font-medium text-gray-700 dark:text-gray-200">
                  把归档 JSON 拖进来，或点这里选择文件
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">
                  watermark_spec / product_direction_map / sizes / nas_delivery_spec，
                  以及 export 里的 groups / products / directions。按内容识别，文件名随意，可一次多选
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(e) => { if (e.target.files) void acceptFiles(e.target.files); e.target.value = '' }}
                />
              </div>

              {archive && (
                <div className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-[11px] dark:bg-white/[0.04]">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gray-600 dark:text-gray-300">
                    <span>识别到 {archive.files.length} 个文件</span>
                    <span className="text-gray-400">分组 {archive.groups.length}</span>
                    <span className="text-gray-400">产品 {archive.products.length}</span>
                    <span className="text-gray-400">方向 {archive.directions.length}</span>
                    <span className="text-gray-400">水印 {archive.watermarks.size}</span>
                    <span className="text-gray-400">组合 {archive.mappings.length}</span>
                    {archive.sizes.size > 0 && <span className="text-gray-400">尺寸 {archive.sizes.size}</span>}
                  </div>
                  <div className="mt-1 text-[10px] text-gray-400">
                    {archive.files.map((item) => `${item.name} → ${
                      item.kind === 'unknown' ? '认不出来（已忽略）' : item.kind
                    }`).join('；')}
                  </div>
                  {archive.missing.length > 0 && (
                    <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                      还缺：{archive.missing.join('、')}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => { setFiles([]); setArchive(null) }}
                    disabled={running}
                    className="mt-1 text-[10px] text-gray-400 underline decoration-dotted hover:text-gray-600 disabled:opacity-50"
                  >
                    清空重选
                  </button>
                </div>
              )}

              <div className="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                {checkRow(wantTemplates, setWantTemplates, '水印 → 后处理模板', '坐标 / 字号 / 颜色 / 描边 + Logo 贴图')}
                {checkRow(wantDelivery, setWantDelivery, 'NAS 交付地址', '写进节点，交付时自动用')}
                {checkRow(wantPresets, setWantPresets, '卖点 / 风格', '从方向文案拆，拆不准会原样存一条')}
              </div>
            </>
          )}

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
            </div>
          )}

          {error && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-600 dark:bg-red-500/10 dark:text-red-400">
              {error}
            </p>
          )}

          {loginResult && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs dark:border-emerald-500/25 dark:bg-emerald-500/[0.08]">
              <div className="font-medium text-emerald-700 dark:text-emerald-300">
                导入完成{loginResult.canceled ? '（中途取消，已导入的部分保留）' : ''}
              </div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                <li>方向树：新增 {loginResult.tree.created} 个，复用 {loginResult.tree.reused} 个</li>
                <li>
                  后处理模板：新增 {loginResult.templates.created} 套，更新 {loginResult.templates.updated} 套
                  {loginResult.templates.logosSkipped > 0 && `，${loginResult.templates.logosSkipped} 个 logo 图层取不到图片已跳过`}
                </li>
                {loginResult.templates.failed.length > 0 && (
                  <li className="text-amber-600 dark:text-amber-400">
                    {loginResult.templates.failed.length} 条没导成：{loginResult.templates.failed.slice(0, 3).join('；')}
                    {loginResult.templates.failed.length > 3 ? ` 等 ${loginResult.templates.failed.length} 条` : ''}
                  </li>
                )}
              </ul>
            </div>
          )}

          {fileResult && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs dark:border-emerald-500/25 dark:bg-emerald-500/[0.08]">
              <div className="font-medium text-emerald-700 dark:text-emerald-300">导入完成</div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                <li>方向树：新增 {fileResult.tree.created} 个，复用 {fileResult.tree.reused} 个</li>
                <li>
                  后处理模板：新增 {fileResult.templates.created} 套，更新 {fileResult.templates.updated} 套
                  {fileResult.templates.inherited > 0 && `；${fileResult.templates.inherited} 个方向直接继承产品的水印，没另存`}
                  {fileResult.templates.logosSkipped > 0 && `；跳过 ${fileResult.templates.logosSkipped} 个取不到图的 logo 图层`}
                </li>
                {fileResult.delivery.applied + fileResult.delivery.inherited > 0 && (
                  <li>
                    NAS 交付地址：设置 {fileResult.delivery.applied} 个
                    {fileResult.delivery.inherited > 0 && `，${fileResult.delivery.inherited} 个方向与产品相同（走继承）`}
                  </li>
                )}
                {fileResult.presetsStats.created + fileResult.presetsStats.updated > 0 && (
                  <li>卖点 / 风格：新增 {fileResult.presetsStats.created} 条，更新 {fileResult.presetsStats.updated} 条</li>
                )}
                {fileResult.templates.failed.length > 0 && (
                  <li className="text-amber-600 dark:text-amber-400">
                    {fileResult.templates.failed.length} 条没导成：{fileResult.templates.failed.slice(0, 2).join('；')}
                    {fileResult.templates.failed.length > 2 ? ' 等' : ''}
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
            {(loginResult || fileResult) ? '完成' : '取消'}
          </button>
          <button
            type="button"
            onClick={() => { void (mode === 'login' ? runLogin() : runFileImport()) }}
            disabled={mode === 'login' ? !canLogin : !canImport}
            className="rounded-lg bg-blue-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? '导入中…' : (loginResult || fileResult) ? '再导一次' : '开始导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
