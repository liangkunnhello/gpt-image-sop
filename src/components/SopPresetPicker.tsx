import { useEffect, useMemo, useRef, useState } from 'react'
import type { SopPick, SopPreset } from '../lib/sopStore'
import { NO_PRESET, useSopStore } from '../lib/sopStore'
import { useStore } from '../store'
import AiRewriteBar from './AiRewriteBar'

/** 按「默认项 → 上次使用 → 第一项」的顺序决定当前选中的卖点/风格 */
export function resolvePickedPreset(
  presets: SopPreset[],
  directionId: string,
  productId: string,
  kind: SopPreset['kind'],
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
) {
  const list = presets.filter((item) => item.productId === productId && item.kind === kind)
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  const id = kind === 'point' ? pick.pointId : pick.styleId
  if (id === NO_PRESET) return undefined
  if (id) return list.find((item) => item.id === id)
  return list[0]
}

interface Props {
  kind: SopPreset['kind']
  label: string
  directionId: string
  productId: string
}

export default function SopPresetPicker({ kind, label, directionId, productId }: Props) {
  const presets = useSopStore((s) => s.presets)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const setPick = useSopStore((s) => s.setPick)
  const setDefaultPick = useSopStore((s) => s.setDefaultPick)
  const addPreset = useSopStore((s) => s.addPreset)
  const updatePreset = useSopStore((s) => s.updatePreset)
  const removePreset = useSopStore((s) => s.removePreset)
  const showToast = useStore((s) => s.showToast)

  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const list = useMemo(
    () => presets.filter((item) => item.productId === productId && item.kind === kind),
    [presets, productId, kind],
  )
  const current = resolvePickedPreset(presets, directionId, productId, kind, lastPick, defaultPick)
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  const currentId = kind === 'point' ? pick.pointId : pick.styleId
  const isNone = currentId === NO_PRESET

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (item: SopPreset) => {
    setPick(directionId, {
      ...lastPick[directionId],
      ...(kind === 'point' ? { pointId: item.id } : { styleId: item.id }),
    })
    setOpen(false)
  }

  const startEdit = (item: SopPreset) => {
    setEditingId(item.id)
    setDraftName(item.name)
    setDraftContent(item.content)
  }

  const saveEdit = () => {
    if (!editingId) return
    updatePreset(editingId, { name: draftName.trim() || '未命名', content: draftContent })
    setEditingId('')
  }

  const createNew = () => {
    const name = newName.trim()
    if (!name) return
    const id = addPreset(productId, kind, name, name)
    setNewName('')
    setPick(directionId, {
      ...lastPick[directionId],
      ...(kind === 'point' ? { pointId: id } : { styleId: id }),
    })
    startEdit({ id, productId, kind, name, content: name, updatedAt: Date.now() })
  }

  /** 复制一份，名称加「副本」，并直接选中，方便在此基础上改 */
  const copyPreset = (item: SopPreset) => {
    const existing = new Set(list.map((entry) => entry.name))
    let name = `${item.name} 副本`
    let seq = 2
    while (existing.has(name)) {
      name = `${item.name} 副本 ${seq}`
      seq += 1
    }
    const id = addPreset(productId, kind, name, item.content)
    setPick(directionId, {
      ...lastPick[directionId],
      ...(kind === 'point' ? { pointId: id } : { styleId: id }),
    })
    showToast(`已复制为「${name}」`, 'success')
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          if (!open) {
            // 输入框在页面底部，下方空间不足时改为向上展开
            const rect = rootRef.current?.getBoundingClientRect()
            if (rect) setDropUp(window.innerHeight - rect.bottom < 340)
          }
          setOpen((value) => !value)
        }}
        title={`${label}：${current?.content || '未设置'}`}
        className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/70 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
      >
        <span className="text-gray-400 dark:text-gray-500">{label}</span>
        <span className="max-w-[140px] truncate font-medium text-gray-700 dark:text-gray-200">
          {current?.name ?? (isNone ? '不使用' : '未设置')}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className={`absolute left-0 z-40 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-gray-800 ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          <div className="max-h-64 overflow-auto p-1">
            <button
              type="button"
              onClick={() => {
                setPick(directionId, {
                  ...pick,
                  ...(kind === 'point' ? { pointId: NO_PRESET } : { styleId: NO_PRESET }),
                })
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-white/[0.06] ${isNone ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200'}`}
            >
              <span className="flex-1 text-left">不使用{label}</span>
              {isNone && <span className="text-[10px]">当前</span>}
            </button>
            <div className="my-1 h-px bg-gray-100 dark:bg-white/[0.06]" />

            {!list.length && <p className="px-2 py-3 text-xs text-gray-400">这个产品下还没有{label}</p>}
            {list.map((item) => (
              editingId === item.id ? (
                <div key={item.id} className="space-y-1 rounded-lg bg-gray-50 p-2 dark:bg-white/[0.06]">
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs dark:border-white/10 dark:bg-gray-700 dark:text-gray-100"
                  />
                  <textarea
                    value={draftContent}
                    onChange={(e) => setDraftContent(e.target.value)}
                    rows={3}
                    className="w-full resize-y rounded border border-gray-200 px-1.5 py-1 text-xs dark:border-white/10 dark:bg-gray-700 dark:text-gray-100"
                  />
                  <AiRewriteBar
                    value={draftContent}
                    onDone={(next) => {
                      const base = draftName.trim() || item.name
                      const existing = new Set(list.map((entry) => entry.name))
                      let name = `${base}（AI）`
                      let seq = 2
                      while (existing.has(name)) {
                        name = `${base}（AI）${seq}`
                        seq += 1
                      }
                      const id = addPreset(productId, kind, name, next)
                      setPick(directionId, {
                        ...lastPick[directionId],
                        ...(kind === 'point' ? { pointId: id } : { styleId: id }),
                      })
                      setEditingId('')
                      showToast(`已另存为新版本「${name}」，原内容未改动`, 'success')
                    }}
                  />
                  <div className="flex justify-end gap-1">
                    <button type="button" onClick={() => setEditingId('')} className="rounded px-2 py-0.5 text-[11px] text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10">取消</button>
                    <button type="button" onClick={saveEdit} className="rounded bg-blue-500 px-2 py-0.5 text-[11px] text-white hover:bg-blue-600">保存</button>
                  </div>
                </div>
              ) : (
                <div
                  key={item.id}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setDefaultPick(directionId, {
                      ...defaultPick[directionId],
                      ...(kind === 'point' ? { pointId: item.id } : { styleId: item.id }),
                    })
                    showToast(`已把「${item.name}」设为这个方向的默认${label}`, 'success')
                    setOpen(false)
                  }}
                  className="group flex items-start gap-1 rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-white/[0.06]"
                >
                  <button type="button" onClick={() => choose(item)} className="min-w-0 flex-1 text-left">
                    <div className={`truncate text-xs ${current?.id === item.id ? 'font-medium text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-200'}`}>
                      {item.name}
                    </div>
                    <div className="line-clamp-2 text-[10px] leading-relaxed text-gray-400">{item.content}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(item)}
                    title="编辑"
                    className="mt-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 group-hover:flex dark:hover:bg-white/10"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20h4l10-10-4-4L4 16v4z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => copyPreset(item)}
                    title="复制"
                    className="mt-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 group-hover:flex dark:hover:bg-white/10"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path strokeLinecap="round" d="M15 5.5A1.5 1.5 0 0013.5 4h-8A1.5 1.5 0 004 5.5v8A1.5 1.5 0 005.5 15" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => removePreset(item.id)}
                    title="删除"
                    className="mt-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500 group-hover:flex dark:hover:bg-red-500/10"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                      <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              )
            ))}
          </div>

          <div className="border-t border-gray-100 p-1.5 dark:border-white/[0.06]">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createNew()
              }}
              placeholder={`新建${label}，回车添加`}
              className="w-full rounded-lg border border-dashed border-gray-200 px-2 py-1 text-xs text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:bg-transparent dark:text-gray-200"
            />
            <p className="mt-1 px-1 text-[10px] text-gray-400">悬停某一项可编辑、复制、删除；右键可设为这个方向的默认{label}；同产品的所有方向共用这份列表。</p>
          </div>
        </div>
      )}
    </div>
  )
}
