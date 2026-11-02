import { useMemo, useRef, useState } from 'react'

import { qcInBrowser, activeQcRules, type QcChecks } from '../lib/visionQc'
import { useInspectConfig } from '../lib/inspectConfig'
import { openDirectoryPath, pickDirectoryPath } from '../lib/deliveryDirPicker'
import { useStore } from '../store'
import {
  formatBytes,
  folderImagesFromFiles,
  isFolderPathLike,
  readFolderImages,
  summarizeVerdicts,
  type FolderImage,
} from '../lib/folderImages'
import { isTauri } from '../lib/platform'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import type { QcOutcome } from '../lib/batchCheck'

/**
 * 文件夹质检：直接把一个目录（含 `\\服务器\共享` 网络路径）里的图片送质检模型。
 *
 * 为什么单独做：任务卡质检要图在库里；交付出去的成品往往只留在共享目录，
 * 用户想复核的正是「已经交出去的那一批」。
 */
export default function FolderCheckModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  const config = useInspectConfig((s) => s.config)

  const [path, setPath] = useState('')
  const [images, setImages] = useState<FolderImage[]>([])
  const [results, setResults] = useState<Record<string, QcOutcome>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  /** 图上应该出现的文案（可选）：不填就只查违规、压叠与自定义规则 */
  const [expectText, setExpectText] = useState('')
  const folderInputRef = useRef<HTMLInputElement>(null)

  useCloseOnEscape(true, onClose)

  const checks: QcChecks = useMemo(() => ({
    violation: config.checkViolation,
    text: config.checkText,
    overlap: config.checkOverlap,
    rules: config.customRules,
  }), [config])

  const qcUsable = checks.violation || checks.text || checks.overlap || activeQcRules(checks.rules).length > 0

  /** 文案行 → 质检期望值：最长的一行当主标题，其余当标签（与任务卡那边同一套约定） */
  const expect = useMemo(() => {
    const lines = expectText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (!lines.length) return { mainTitle: '', tags: [], brand: [], disclaimer: [] }
    const mainTitle = [...lines].sort((a, b) => b.length - a.length)[0]!
    return { mainTitle, tags: lines.filter((line) => line !== mainTitle), brand: [], disclaimer: [] }
  }, [expectText])

  const load = async (target: string) => {
    const value = target.trim()
    if (!value) {
      setError('先填一个文件夹地址')
      return
    }
    setError('')
    setBusy('读取中')
    try {
      const list = await readFolderImages(value)
      setImages(list)
      setResults({})
      if (!list.length) setError('这个文件夹里没有图片（jpg / jpeg / png / webp）')
    } catch (err) {
      setImages([])
      setResults({})
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  const pick = async () => {
    if (!isTauri) {
      // 网页版：让浏览器读用户选的目录（File 对象里带内容，不需要额外权限）
      folderInputRef.current?.click()
      return
    }
    setError('')
    try {
      const picked = await pickDirectoryPath()
      if (!picked) return
      setPath(picked)
      await load(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const loadFromFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy('读取中')
    setError('')
    try {
      const list = await folderImagesFromFiles(Array.from(files))
      setImages(list)
      setResults({})
      if (!list.length) setError('这个文件夹里没有图片（jpg / jpeg / png / webp）')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  const runQc = async () => {
    if (!images.length) return
    if (!profile) {
      setError('没有可用的接口配置，先在设置里填好')
      return
    }
    if (!qcUsable) {
      setError('质检项全部关闭，先在设置里勾选要检查的项目')
      return
    }
    setError('')
    let done = 0
    setBusy(`质检 0/${images.length}`)
    let cursor = 0
    const worker = async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= images.length) return
        const image = images[index]!
        const outcome = await qcInBrowser(profile, image.dataUrl, expect, { model: config.qcModel, checks })
        setResults((prev) => ({ ...prev, [image.name]: outcome }))
        done += 1
        setBusy(`质检 ${done}/${images.length}`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, config.qcConcurrency), images.length) }, worker))
    setBusy('')
  }

  const summary = summarizeVerdicts(Object.values(results).map((item) => item.verdict))
  const checked = Object.keys(results).length

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">文件夹质检</h2>
          <span className="text-[11px] text-gray-400 dark:text-gray-500">直接读目录里的图片，不用先导入</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.06]"
          >
            关闭
          </button>
        </div>

        <div className="shrink-0 space-y-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <div className="flex items-center gap-2">
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void load(path)
              }}
              placeholder="\\192.168.202.11\设计素材交付专用\...\20261102-百万医疗险-图标-大图"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:bg-gray-800 dark:text-gray-100"
            />
            <button
              type="button"
              onClick={() => void pick()}
              className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
            >
              {isTauri ? '选择文件夹' : '选目录'}
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !path.trim()}
              onClick={() => void load(path)}
              className="shrink-0 rounded-lg bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-40"
            >
              读取
            </button>
            {isTauri && path.trim() && (
              <button
                type="button"
                onClick={() => { void openDirectoryPath(path.trim()).catch(() => {}) }}
                className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/[0.06]"
                title="在资源管理器中打开"
              >
                打开
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">图上应有文案</span>
            <input
              value={expectText}
              onChange={(event) => setExpectText(event.target.value)}
              placeholder="可选，多行；填了才查文字是否缺漏 / 错字"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>

          {path.trim() && !isFolderPathLike(path) && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              这看起来不是一个完整路径。Windows 请用 D:\目录 或 \\服务器\共享\目录 的形式。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span>
              {images.length ? `共 ${images.length} 张` : '还没读取'}
              {checked > 0 && ` · 已检 ${checked} 张`}
            </span>
            {checked > 0 && (
              <span className="flex items-center gap-2">
                <span className="text-green-600 dark:text-green-400">过 {summary.pass}</span>
                <span className="text-red-600 dark:text-red-400">不过 {summary.fail}</span>
                <span className="text-amber-600 dark:text-amber-400">待人工 {summary.unsure}</span>
                {summary.error > 0 && <span>出错 {summary.error}</span>}
              </span>
            )}
            <div className="flex-1" />
            <button
              type="button"
              disabled={!images.length || Boolean(busy) || !qcUsable}
              onClick={() => void runQc()}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/[0.06]"
              title={qcUsable ? undefined : '质检项全部关闭，先在图库的质检设置里勾选'}
            >
              {busy.startsWith('质检') ? busy : '开始质检'}
            </button>
          </div>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {!images.length ? (
            <div className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-xs text-gray-400 dark:border-white/10 dark:text-gray-500">
              填入文件夹地址后点「读取」。支持 jpg / jpeg / png / webp，最多 200 张。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {images.map((image) => {
                const result = results[image.name]
                return (
                  <div
                    key={image.name}
                    className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]"
                  >
                    <div className="relative aspect-square bg-gray-50 dark:bg-white/[0.04]">
                      <img src={image.dataUrl} alt={image.name} className="h-full w-full object-cover" loading="lazy" />
                      {result && (
                        <span
                          className={`absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-white ${
                            result.verdict === 'pass'
                              ? 'bg-green-600/90'
                              : result.verdict === 'fail'
                                ? 'bg-red-600/90'
                                : result.verdict === 'unsure'
                                  ? 'bg-amber-500/90'
                                  : 'bg-gray-600/90'
                          }`}
                        >
                          {result.verdict === 'pass' ? '过' : result.verdict === 'fail' ? '不过' : result.verdict === 'unsure' ? '待人工' : '出错'}
                        </span>
                      )}
                    </div>
                    <div className="space-y-1 px-2 py-1.5">
                      <div className="truncate text-[11px] text-gray-600 dark:text-gray-300" title={image.name}>
                        {image.name}
                      </div>
                      <div className="text-[10px] text-gray-400">{formatBytes(image.bytes)}</div>
                      {result?.reason && (
                        <div className="line-clamp-3 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400" title={result.reason}>
                          {result.reason}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 网页版兜底：浏览器选目录，读 File 对象 */}
        <input
          ref={(el) => {
            folderInputRef.current = el
            if (!el) return
            el.setAttribute('webkitdirectory', '')
            el.setAttribute('directory', '')
          }}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void loadFromFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
