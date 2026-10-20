import { useEffect, useMemo, useRef, useState } from 'react'

import {
  POST_FONT_STACK,
  POST_SIZE_PRESETS,
  clamp01,
  createPostTemplate,
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
  const setPostTemplates = useSopStore((s) => s.setPostTemplates)

  const [templates, setTemplates] = useState<PostTemplate[]>(() => stored ?? [])
  const [activeId, setActiveId] = useState<string>(() => stored?.[0]?.id ?? '')
  const [selectedId, setSelectedId] = useState<string>('')
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
  }, [activeId])

  const active = useMemo(
    () => templates.find((item) => item.id === activeId) ?? templates[0] ?? null,
    [templates, activeId],
  )
  const selected = useMemo(
    () => active?.elements.find((item) => item.id === selectedId) ?? null,
    [active, selectedId],
  )

  const patchActive = (next: Partial<PostTemplate>) => setTemplates((prev) => prev.map((item) => (
    item.id === active?.id ? { ...item, ...next } : item
  )))

  const patchElement = (id: string, next: Partial<PostElement>) => setTemplates((prev) => prev.map((item) => (
    item.id === active?.id
      ? { ...item, elements: item.elements.map((element) => (element.id === id ? { ...element, ...next } : element)) }
      : item
  )))

  const addTemplate = (width: number, height: number, label: string) => {
    const template = { ...createPostTemplate(width, height, label), enabled: true }
    // 同比例还没有默认的，就把新的一套设为默认
    const hasDefault = templates.some((item) => item.isDefault && Math.abs(item.width / item.height - width / height) < 0.02)
    template.isDefault = !hasDefault
    setTemplates((prev) => [...prev, template])
    setActiveId(template.id)
    setSelectedId('')
  }

  const removeTemplate = (id: string) => {
    setTemplates((prev) => prev.filter((item) => item.id !== id))
    if (activeId === id) setActiveId('')
  }

  const addElement = (kind: PostElement['kind']) => {
    if (!active) return
    const element = newPostElement(kind, active.elements.length + 1)
    patchActive({ elements: [...active.elements, element] })
    setSelectedId(element.id)
  }

  const removeElement = (id: string) => {
    if (!active) return
    patchActive({ elements: active.elements.filter((item) => item.id !== id) })
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
    patchElement(drag.id, {
      x: clamp01(drag.originX + (event.clientX - drag.startX) / rect.width),
      y: clamp01(drag.originY + (event.clientY - drag.startY) / rect.height),
    })
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
    } else if (active) {
      const element = { ...newPostElement('logo', active.elements.length + 1), text: dataUrl }
      patchActive({ elements: [...active.elements, element] })
      setSelectedId(element.id)
    }
  }

  const save = () => {
    setPostTemplates(productId, templates)
    onClose()
  }

  const ratio = active ? active.width / active.height : 1
  // 预览按成品宽等比缩小，字号与描边都要跟着缩
  const scale = active && active.width > 0 && previewWidth > 0 ? previewWidth / active.width : 1
  const enabledCount = templates.filter((item) => item.enabled).length

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{productName} · 后处理模板</h2>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            {enabledCount} 套启用 / 共 {templates.length} 套
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">取消</button>
          <button type="button" onClick={save} className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600">保存</button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 画布预览 */}
          <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-gray-100 p-4 dark:bg-black/30">
            {active ? (
              <div
                ref={stageRef}
                className="relative max-h-full w-full overflow-hidden shadow-lg"
                style={{ aspectRatio: `${active.width} / ${active.height}`, maxWidth: ratio >= 1 ? '100%' : `${Math.round(ratio * 420)}px` }}
                onPointerMove={onDrag}
                onPointerUp={() => { dragRef.current = null }}
                onPointerCancel={() => { dragRef.current = null }}
                onClick={() => setSelectedId('')}
              >
                {previewSrc ? (
                  <img src={previewSrc} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-200 to-gray-300 text-xs text-gray-500 dark:from-gray-800 dark:to-gray-700">
                    这个产品还没有成品图，先按白底排版
                  </div>
                )}

                {active.elements.map((element) => {
                  const isActive = selectedId === element.id
                  return (
                    <div
                      key={element.id}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(element.id) }}
                      className={`absolute ${isActive ? 'ring-2 ring-blue-500' : 'ring-1 ring-transparent hover:ring-blue-300'}`}
                      style={{ left: `${element.x * 100}%`, top: `${element.y * 100}%`, opacity: element.opacity }}
                    >
                      {isActive && (
                        <div
                          onPointerDown={(e) => startDrag(e, element)}
                          title="拖动调整位置"
                          className="absolute -left-2 -top-2 h-4 w-4 cursor-move rounded-full border-2 border-white bg-blue-500 shadow"
                        />
                      )}
                      {element.kind === 'text' ? (
                        <div className="relative">
                          {/* 外描边：底层用双倍居中线宽铺色，上层文字盖住内侧一半 */}
                          {element.strokeWidth > 0 && (
                            <div
                              aria-hidden
                              style={{
                                position: 'absolute',
                                left: 0,
                                top: 0,
                                fontFamily: POST_FONT_STACK,
                                fontSize: `${Math.max(1, element.fontSize * scale)}px`,
                                fontWeight: element.fontWeight,
                                color: element.strokeColor,
                                WebkitTextStroke: `${Math.max(0.4, element.strokeWidth * 2 * scale)}px ${element.strokeColor}`,
                                lineHeight: 1.35,
                                whiteSpace: 'pre',
                                pointerEvents: 'none',
                              }}
                            >
                              {element.text}
                            </div>
                          )}
                          <div
                            contentEditable
                            suppressContentEditableWarning
                            onInput={(e) => patchElement(element.id, { text: e.currentTarget.textContent || '' })}
                            onBlur={(e) => patchElement(element.id, { text: e.currentTarget.textContent || '' })}
                            style={{
                              position: 'relative',
                              fontFamily: POST_FONT_STACK,
                              fontSize: `${Math.max(1, element.fontSize * scale)}px`,
                              fontWeight: element.fontWeight,
                              color: element.color,
                              textAlign: element.align,
                              lineHeight: 1.35,
                              whiteSpace: 'pre',
                            }}
                          >
                            {element.text}
                          </div>
                        </div>
                      ) : element.text ? (
                        <img src={element.text} alt="" draggable={false} style={{ width: `${element.width * previewWidth}px` }} />
                      ) : (
                        <div className="rounded border border-dashed border-gray-400 px-3 py-1 text-[10px] text-gray-500">未选 logo</div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="text-center text-sm text-gray-500 dark:text-gray-400">
                还没有模板
                <div className="mt-1 text-xs">右边选一个比例新建一套</div>
              </div>
            )}
          </div>

          {/* 右侧面板 */}
          <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-gray-200 p-3 dark:border-white/[0.08]">
            <div className="mb-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">模板（按出图比例自动选）</div>
            <div className="mb-2 space-y-1">
              {templates.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] ${active?.id === item.id ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'}`}
                >
                  <button type="button" onClick={() => { setActiveId(item.id); setSelectedId('') }} className="min-w-0 flex-1 truncate text-left">
                    {item.label}
                    <span className="ml-1 text-gray-400">{item.width}×{item.height}</span>
                    {item.isDefault && <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-600 dark:bg-blue-500/20 dark:text-blue-300">默认</span>}
                  </button>
                  <label className="flex shrink-0 items-center gap-0.5 text-[10px] text-gray-400" title="启用后参与自动套用">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(e) => setTemplates((prev) => prev.map((t) => (t.id === item.id ? { ...t, enabled: e.target.checked } : t)))}
                      className="h-3 w-3 accent-blue-500"
                    />
                    启用
                  </label>
                  <button
                    type="button"
                    title="设为默认"
                    onClick={() => setTemplates((prev) => prev.map((t) => {
                      if (t.id === item.id) return { ...t, isDefault: true }
                      return Math.abs(t.width / t.height - item.width / item.height) < 0.02 ? { ...t, isDefault: false } : t
                    }))}
                    className={`shrink-0 rounded px-1 ${item.isDefault ? 'text-blue-500' : 'text-gray-300 hover:text-blue-500'}`}
                  >
                    ★
                  </button>
                  <button type="button" onClick={() => removeTemplate(item.id)} className="shrink-0 text-gray-300 hover:text-red-500">✕</button>
                </div>
              ))}
              {!templates.length && <p className="px-1 py-1 text-[11px] text-gray-400">还没有模板</p>}
            </div>

            <div className="mb-3">
              <div className="mb-1 text-[10px] text-gray-400">新建模板（点比例即建一套）</div>
              <div className="flex flex-wrap gap-1">
                {POST_SIZE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => addTemplate(preset.width, preset.height, preset.label.split('  ')[0])}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-300"
                  >
                    {preset.label.split('  ')[0]}
                  </button>
                ))}
              </div>
            </div>

            {active && (
              <>
                <div className="mb-2">
                  <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">模板名称 / 尺寸</div>
                  <input
                    value={active.label}
                    onChange={(e) => patchActive({ label: e.target.value })}
                    className="mb-1 w-full rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                  />
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={active.width}
                      onChange={(e) => patchActive({ width: Math.max(64, Number(e.target.value) || 0) })}
                      className="w-full rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                    />
                    <span className="text-gray-400">×</span>
                    <input
                      type="number"
                      value={active.height}
                      onChange={(e) => patchActive({ height: Math.max(64, Number(e.target.value) || 0) })}
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
                  {active.elements.map((element, index) => (
                    <div
                      key={element.id}
                      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] ${selectedId === element.id ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'}`}
                    >
                      <button type="button" onClick={() => setSelectedId(element.id)} className="min-w-0 flex-1 truncate text-left">
                        {element.kind === 'text' ? `文字 ${index + 1}｜${element.text.slice(0, 10) || '空'}` : `Logo ${index + 1}`}
                      </button>
                      <button type="button" onClick={() => removeElement(element.id)} className="shrink-0 text-gray-400 hover:text-red-500">✕</button>
                    </div>
                  ))}
                  {!active.elements.length && <p className="px-1 py-2 text-[11px] text-gray-400">还没有元素</p>}
                </div>

                {selected && (
                  <div className="space-y-2 rounded-lg bg-gray-50 p-2 dark:bg-white/[0.04]">
                    <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                      {selected.kind === 'text' ? '文字设置' : 'Logo 设置'}
                      <span className="ml-1 text-gray-400">拖蓝点移动</span>
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
                            min={8}
                            max={Math.max(48, Math.round(active.height * 0.3))}
                            step={1}
                            value={selected.fontSize}
                            onChange={(e) => patchElement(selected.id, { fontSize: Number(e.target.value) })}
                            className="flex-1 accent-blue-500"
                          />
                          <span className="flex items-center gap-0.5">
                            <input
                              type="number"
                              min={8}
                              value={selected.fontSize}
                              onChange={(e) => patchElement(selected.id, { fontSize: Math.max(1, Number(e.target.value) || 1) })}
                              className="w-12 rounded border border-gray-200 px-1 py-0.5 text-[11px] tabular-nums dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                            />
                            px
                          </span>
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
                        <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                          描边
                          <input
                            type="color"
                            value={selected.strokeColor}
                            onChange={(e) => patchElement(selected.id, { strokeColor: e.target.value })}
                            className="h-6 w-8 cursor-pointer rounded border border-gray-200 dark:border-white/10"
                          />
                          <input
                            type="range"
                            min={0}
                            max={24}
                            step={0.5}
                            value={selected.strokeWidth}
                            onChange={(e) => patchElement(selected.id, { strokeWidth: Number(e.target.value) })}
                            className="flex-1 accent-blue-500"
                          />
                          <span className="flex items-center gap-0.5">
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              value={selected.strokeWidth}
                              onChange={(e) => patchElement(selected.id, { strokeWidth: Math.max(0, Number(e.target.value) || 0) })}
                              className="w-11 rounded border border-gray-200 px-1 py-0.5 text-[11px] tabular-nums dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                            />
                            px
                          </span>
                        </div>
                        {selected.strokeWidth > 0 && (
                          <p className="text-[10px] text-gray-400">向外描边，不会吃掉笔画。</p>
                        )}
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
              </>
            )}

            <p className="mt-3 text-[10px] leading-relaxed text-gray-400">
              出图时先看这张图的比例，只套用比例对得上（误差 2% 内）且已启用的模板；
              同比例有多套时优先用标 ★ 的默认模板，没标就随机取一套；比例没配模板的图保持原图。
              字体默认思源黑体，缺失时按 Noto Sans / 微软雅黑兜底。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
