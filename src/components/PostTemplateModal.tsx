import { useEffect, useMemo, useRef, useState } from 'react'

import {
  POST_FONT_STACK,
  POST_SIZE_PRESETS,
  clamp01,
  defaultPostTemplate,
  newPostElement,
  type PostElement,
  type PostTemplate,
} from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'

interface Props {
  productId: string
  productName: string
  /** 预览用的底图（一般是这个产品最近一张成品图） */
  previewSrc: string
  onClose: () => void
}

export default function PostTemplateModal({ productId, productName, previewSrc, onClose }: Props) {
  const stored = useSopStore((s) => s.postTemplates[productId])
  const setPostTemplate = useSopStore((s) => s.setPostTemplate)

  const [template, setTemplate] = useState<PostTemplate>(() => stored ?? defaultPostTemplate())
  const [selectedId, setSelectedId] = useState<string>(() => (stored ?? defaultPostTemplate()).elements[0]?.id ?? '')
  const [previewWidth, setPreviewWidth] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; originX: number; originY: number } | null>(null)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    setPreviewWidth(el.clientWidth)
    const observer = new ResizeObserver((entries) => setPreviewWidth(entries[0].contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const selected = useMemo(
    () => template.elements.find((item) => item.id === selectedId) ?? null,
    [template.elements, selectedId],
  )

  const patch = (next: Partial<PostTemplate>) => setTemplate((prev) => ({ ...prev, ...next }))
  const patchElement = (id: string, next: Partial<PostElement>) => setTemplate((prev) => ({
    ...prev,
    elements: prev.elements.map((item) => (item.id === id ? { ...item, ...next } : item)),
  }))

  const addElement = (kind: PostElement['kind']) => {
    const element = newPostElement(kind, template.elements.length + 1)
    setTemplate((prev) => ({ ...prev, elements: [...prev.elements, element] }))
    setSelectedId(element.id)
  }

  const removeElement = (id: string) => {
    setTemplate((prev) => ({ ...prev, elements: prev.elements.filter((item) => item.id !== id) }))
    if (selectedId === id) setSelectedId('')
  }

  const startDrag = (event: React.PointerEvent, element: PostElement) => {
    if (!stageRef.current) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedId(element.id)
    dragRef.current = {
      id: element.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: element.x,
      originY: element.y,
    }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }

  const onDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current
    const el = stageRef.current
    if (!drag || !el) return
    const rect = el.getBoundingClientRect()
    const dx = (event.clientX - drag.startX) / rect.width
    const dy = (event.clientY - drag.startY) / rect.height
    patchElement(drag.id, { x: clamp01(drag.originX + dx), y: clamp01(drag.originY + dy) })
  }

  const endDrag = () => {
    dragRef.current = null
  }

  const uploadLogo = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('读取失败'))
      reader.readAsDataURL(file)
    })
    if (selected?.kind === 'logo') {
      patchElement(selected.id, { text: dataUrl })
    } else {
      const element = { ...newPostElement('logo', template.elements.length + 1), text: dataUrl }
      setTemplate((prev) => ({ ...prev, elements: [...prev.elements, element] }))
      setSelectedId(element.id)
    }
  }

  const save = () => {
    setPostTemplate(productId, template)
    onClose()
  }

  const ratio = template.width / template.height

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{productName} · 后处理模板</h2>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            {template.width}×{template.height}
          </span>
          <div className="flex-1" />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={template.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="h-3.5 w-3.5 accent-blue-500"
            />
            出图后自动套用
          </label>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">取消</button>
          <button type="button" onClick={save} className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600">保存</button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 画布预览 */}
          <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-gray-100 p-4 dark:bg-black/30">
            <div
              ref={stageRef}
              className="relative max-h-full w-full overflow-hidden shadow-lg"
              style={{ aspectRatio: `${template.width} / ${template.height}`, maxWidth: ratio >= 1 ? '100%' : `${Math.round(ratio * 420)}px` }}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={() => setSelectedId('')}
            >
              {previewSrc ? (
                <img src={previewSrc} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-200 to-gray-300 text-xs text-gray-500 dark:from-gray-800 dark:to-gray-700">
                  这个产品还没有成品图，可先用白底排版
                </div>
              )}

              {template.elements.map((element) => {
                const active = selectedId === element.id
                return (
                  <div
                    key={element.id}
                    onClick={(e) => { e.stopPropagation(); setSelectedId(element.id) }}
                    className={`absolute ${active ? 'ring-2 ring-blue-500' : 'ring-1 ring-transparent hover:ring-blue-300'}`}
                    style={{
                      left: `${element.x * 100}%`,
                      top: `${element.y * 100}%`,
                      opacity: element.opacity,
                    }}
                  >
                    {active && (
                      <div
                        onPointerDown={(e) => startDrag(e, element)}
                        title="拖动调整位置"
                        className="absolute -left-2 -top-2 h-4 w-4 cursor-move rounded-full border-2 border-white bg-blue-500 shadow"
                      />
                    )}
                    {element.kind === 'text' ? (
                      <div
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={(e) => patchElement(element.id, { text: e.currentTarget.textContent || '' })}
                        style={{
                          fontFamily: POST_FONT_STACK,
                          fontSize: `${element.fontSize * previewWidth}px`,
                          fontWeight: element.fontWeight,
                          color: element.color,
                          textAlign: element.align,
                          lineHeight: 1.35,
                          whiteSpace: 'pre',
                        }}
                      >
                        {element.text}
                      </div>
                    ) : element.text ? (
                      <img
                        src={element.text}
                        alt=""
                        draggable={false}
                        style={{ width: `${element.width * previewWidth}px` }}
                      />
                    ) : (
                      <div className="rounded border border-dashed border-gray-400 px-3 py-1 text-[10px] text-gray-500">未选 logo</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 右侧面板 */}
          <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-gray-200 p-3 dark:border-white/[0.08]">
            <div className="mb-3">
              <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">成品尺寸</div>
              <select
                value={`${template.width}x${template.height}`}
                onChange={(e) => {
                  const [w, h] = e.target.value.split('x').map(Number)
                  patch({ width: w, height: h })
                }}
                className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              >
                {POST_SIZE_PRESETS.map((item) => (
                  <option key={item.label} value={`${item.width}x${item.height}`}>{item.label}</option>
                ))}
                <option value={`${template.width}x${template.height}`}>自定义 {template.width}×{template.height}</option>
              </select>
              <div className="mt-1.5 flex items-center gap-1">
                <input
                  type="number"
                  value={template.width}
                  onChange={(e) => patch({ width: Math.max(64, Number(e.target.value) || 0) })}
                  className="w-full rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                />
                <span className="text-gray-400">×</span>
                <input
                  type="number"
                  value={template.height}
                  onChange={(e) => patch({ height: Math.max(64, Number(e.target.value) || 0) })}
                  className="w-full rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
            </div>

            <div className="mb-2 flex gap-1">
              <button type="button" onClick={() => addElement('text')} className="flex-1 rounded-lg bg-gray-100 px-2 py-1.5 text-[11px] text-gray-700 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200">+ 文字</button>
              <label className="flex-1 cursor-pointer rounded-lg bg-gray-100 px-2 py-1.5 text-center text-[11px] text-gray-700 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-200">
                + Logo
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void uploadLogo(file)
                    e.target.value = ''
                  }}
                />
              </label>
            </div>

            <div className="mb-3 space-y-1">
              {template.elements.map((element, index) => (
                <div
                  key={element.id}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] ${selectedId === element.id ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'}`}
                >
                  <button type="button" onClick={() => setSelectedId(element.id)} className="min-w-0 flex-1 truncate text-left">
                    {element.kind === 'text' ? `文字 ${index + 1}｜${element.text.slice(0, 12) || '空'}` : `Logo ${index + 1}`}
                  </button>
                  <button type="button" onClick={() => removeElement(element.id)} className="shrink-0 text-gray-400 hover:text-red-500">✕</button>
                </div>
              ))}
              {!template.elements.length && <p className="px-1 py-2 text-[11px] text-gray-400">还没有元素，点上面的按钮添加</p>}
            </div>

            {selected && (
              <div className="space-y-2 rounded-lg bg-gray-50 p-2 dark:bg-white/[0.04]">
                <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                  {selected.kind === 'text' ? '文字设置' : 'Logo 设置'}
                  <span className="ml-1 text-gray-400">拖动画面里的元素可调位置</span>
                </div>

                {selected.kind === 'text' ? (
                  <>
                    <textarea
                      value={selected.text}
                      onChange={(e) => patchElement(selected.id, { text: e.target.value })}
                      rows={3}
                      className="w-full resize-y rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                    />
                    <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                      字号
                      <input
                        type="range"
                        min={0.008}
                        max={0.12}
                        step={0.002}
                        value={selected.fontSize}
                        onChange={(e) => patchElement(selected.id, { fontSize: Number(e.target.value) })}
                        className="flex-1 accent-blue-500"
                      />
                      <span className="w-8 tabular-nums">{Math.round(selected.fontSize * 1000) / 10}%</span>
                    </label>
                    <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                      颜色
                      <input
                        type="color"
                        value={selected.color}
                        onChange={(e) => patchElement(selected.id, { color: e.target.value })}
                        className="h-6 w-10 cursor-pointer rounded border border-gray-200 dark:border-white/10"
                      />
                      <select
                        value={selected.fontWeight}
                        onChange={(e) => patchElement(selected.id, { fontWeight: Number(e.target.value) })}
                        className="rounded border border-gray-200 px-1 py-0.5 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                      >
                        <option value={400}>常规</option>
                        <option value={600}>中粗</option>
                        <option value={700}>加粗</option>
                      </select>
                    </div>
                  </>
                ) : (
                  <label className="flex cursor-pointer items-center justify-between rounded border border-dashed border-gray-300 px-2 py-1 text-[11px] text-gray-500 dark:border-white/15">
                    重新选择 logo
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void uploadLogo(file)
                        e.target.value = ''
                      }}
                    />
                  </label>
                )}

                {selected.kind === 'logo' && (
                  <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                    宽度
                    <input
                      type="range"
                      min={0.02}
                      max={0.6}
                      step={0.005}
                      value={selected.width}
                      onChange={(e) => patchElement(selected.id, { width: Number(e.target.value) })}
                      className="flex-1 accent-blue-500"
                    />
                    <span className="w-8 tabular-nums">{Math.round(selected.width * 100)}%</span>
                  </label>
                )}

                <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                  透明度
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={selected.opacity}
                    onChange={(e) => patchElement(selected.id, { opacity: Number(e.target.value) })}
                    className="flex-1 accent-blue-500"
                  />
                  <span className="w-8 tabular-nums">{Math.round(selected.opacity * 100)}%</span>
                </label>
              </div>
            )}

            <p className="mt-3 text-[10px] leading-relaxed text-gray-400">
              开启「出图后自动套用」后，这个产品新出的图会先按上面的尺寸裁切、再叠上文字和 logo 存入库。
              字体默认思源黑体，系统没装时按 Noto Sans / 微软雅黑 兜底。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
