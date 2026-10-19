import { useEffect, useMemo, useRef, useState } from 'react'
import type { SopPreset } from '../lib/sopStore'
import { useSopStore } from '../lib/sopStore'
import { useStore } from '../store'

/** 按「默认项 → 上次使用 → 第一项」的顺序决定当前选中的卖点/风格 */
export function resolvePickedPreset(
  presets: SopPreset[],
  directionId: string,
  productId: string,
  kind: SopPreset['kind'],
  lastPick: Record<string, { pointId?: string; styleId?: string }>,
  defaultPick: Record<string, { pointId?: string; styleId?: string }>,
) {
  const list = presets.filter((item) => item.productId === productId && item.kind === kind)
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  const id = kind === 'point' ? pick.pointId : pick.styleId
  return list.find((item) => item.id === id) ?? list[0]
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

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={`${label}：${current?.content || '未设置'}`}
        className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/70 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
      >
        <span className="text-gray-400 dark:text-gray-500">{label}</span>
        <span className="max-w-[140px] truncate font-medium text-gray-700 dark:text-gray-200">{current?.name ?? '未设置'}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-gray-800">
          <div className="max-h-64 overflow-auto p-1">
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
            <p className="mt-1 px-1 text-[10px] text-gray-400">右键某一项可设为这个方向的默认{label}；同产品的所有方向共用这份列表。</p>
          </div>
        </div>
      )}
    </div>
  )
}
