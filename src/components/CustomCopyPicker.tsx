import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { customCopySummary } from '../lib/customCopy'

/**
 * 输入框上方的「本次文案」入口，点开直接填写。
 *
 * 这一栏是**手写的图上文字**，与提示词库里的「卖点」是两份东西：
 * - 卖点按产品-方向记，改一次就一直生效；
 * - 这里填的只影响本次出图（排在该方向卖点**前面**），发完仍在，直到手动清掉。
 *
 * 为什么放在输入框上方而不塞进输入框：输入框里的内容会被「@图」胶囊、
 * 批量提示词切分等逻辑搅在一起，图上文字需要一份干净、可整段清空的文本。
 */
export default function CustomCopyPicker() {
  // Hook 顺序固定：任何提前 return 都必须排在下面这些调用之后（项目有静态检查）
  const value = useStore((s) => s.customCopy)
  const setValue = useStore((s) => s.setCustomCopy)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点空白处收起：弹层里要打字，不能靠点击弹层自身来关
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (target && wrapRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open])

  const filled = Boolean(value.trim())
  const summary = customCopySummary(value)

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={filled ? `本次文案：${value.trim()}（点击修改）` : '填一段只对本次出图生效的文案'}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
          filled
            ? 'border-amber-300 bg-amber-50/70 text-amber-700 hover:bg-amber-50 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300 dark:hover:bg-amber-400/15'
            : 'border-gray-200 bg-white/70 text-gray-600 hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]'
        }`}
      >
        <span className={filled ? 'text-amber-600/80 dark:text-amber-300/70' : 'text-gray-400 dark:text-gray-500'}>本次文案</span>
        <span className={`max-w-[140px] truncate font-medium ${filled ? '' : 'text-gray-400'}`}>
          {filled ? summary : '未填'}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 shrink-0 opacity-60">
          <path strokeLinecap="round" d="M4 20h4l10-10-4-4L4 16v4z" />
        </svg>
      </button>

      {/* 输入条固定在屏幕底部，弹层必须向上开，否则会跑出可视区域 */}
      {open && (
        <div className="absolute bottom-full left-0 z-[80] mb-2 w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-white/10 dark:bg-gray-800">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-gray-700 dark:text-gray-200">本次文案</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
                只影响这一批出图的图上文字，排在所选卖点前面；不会改动提示词库里的卖点。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="收起"
              className="shrink-0 rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
              aria-label="收起"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={5}
            autoFocus
            spellCheck={false}
            placeholder={'一行一句，图上文字会逐字使用。\n例如：\n赔付总限额600万\n带病投保也能赔'}
            className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs leading-relaxed text-gray-700 outline-none transition-[border-color,box-shadow] focus:border-blue-400 focus:ring-1 focus:ring-blue-300/40 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-100 dark:focus:ring-blue-500/30"
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {filled ? `${value.trim().length} 字 · 发送后仍保留` : '留空则不使用这一栏'}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setValue('')}
                disabled={!filled}
                className="rounded-md px-2 py-1 text-[11px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200"
              >
                清空
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-600"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
