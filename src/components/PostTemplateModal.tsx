import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useStore } from '../store'
import { buildAvoidHint, collectAvoidZones } from '../lib/postReserve'
import { CHANNELS, NO_CHANNEL, channelLabel } from '../lib/channel'
import { ensureImageCached, ensureImageThumbnailCached, subscribeImageThumbnail } from '../lib/imageCache'
import { storeImage } from '../lib/db'
import {
  POST_FONT_STACK,
  POST_LETTER_SPACING_RANGE,
  POST_LINE_HEIGHT_RANGE,
  POST_RATIO_FILTERS,
  POST_SIZE_PRESETS,
  ELEMENT_POS_LIMIT,
  clampElementPos,
  sanitizeNumberDraft,
  commitNumberInput,
  createPostTemplate,
  elementLineHeight,
  newPostElement,
  postTemplateRatioKey,
  type PostElement,
  type PostTemplate,
} from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'
import { parseSizeLimitKb } from '../lib/outputFileSize'
import { productIdForDirection, type PostTemplateScope } from '../lib/applyPostTemplate'

/** 尺寸下限：太小既排不了版，后端也撑不住 */
const MIN_SIZE = 64

/**
 * 带下限的数字输入框。
 *
 * 不能直接受控于模板值：边输边把值夹到区间，用户删到只剩「2」时
 * 立刻被改写成下限（尺寸是 64），接着再敲 5 就变成 645，还顺带把光标/选区重置掉，
 * 表现就是「一直跳 64、没法长按框选」。
 * 所以输入期间只存草稿字符串，失焦或回车才解析并夹取值域。
 */
export function NumberInput({
  value,
  min,
  max,
  step,
  allowDecimal = false,
  allowNegative = false,
  onCommit,
  className,
}: {
  value: number
  min: number
  max?: number
  step?: number
  allowDecimal?: boolean
  /** 允许负数：元素位置可以移出画布（传负坐标），不传就是老行为（只收非负） */
  allowNegative?: boolean
  onCommit: (next: number) => void
  className?: string
}) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  // 外部改了值（点预设、撤销）时跟随，但编辑期间不打断用户输入
  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  const commit = () => {
    const next = commitNumberInput(draft, value, { min, max, step, integer: !allowDecimal })
    setDraft(String(next))
    setEditing(false)
    if (next !== value) onCommit(next)
  }

  return (
    <input
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      value={draft}
      onFocus={() => setEditing(true)}
      // 过滤逻辑交给 sanitizeNumberDraft：老的正则会把负号一起删掉，位置框根本输不进负数
      onChange={(e) => setDraft(sanitizeNumberDraft(e.target.value, { allowDecimal, allowNegative }))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          setDraft(String(value))
          setEditing(false)
        }
      }}
      className={className ?? 'w-full rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200'}
    />
  )
}

/** 筛选条上的小胶囊，和画廊的渠道筛选保持同一种观感 */
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? 'bg-blue-500 text-white'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.12]'
      }`}
    >
      {children}
    </button>
  )
}

/** 底图候选：只读取缩略图，避免为了挑一张图把原图全解出来 */
function PreviewThumb({ imageId, active, onPick }: { imageId: string; active: boolean; onPick: () => void }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let cancelled = false
    const apply = (thumbnail: { src: string }) => {
      if (!cancelled) setSrc(thumbnail.src)
    }
    const unsubscribe = subscribeImageThumbnail(imageId, apply)
    ensureImageThumbnailCached(imageId).then((thumbnail) => {
      if (thumbnail) apply(thumbnail)
    }).catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [imageId])

  return (
    <button
      type="button"
      onClick={onPick}
      title="用这张图当预览底图"
      className={`relative h-20 overflow-hidden rounded-lg border bg-gray-50 transition-shadow hover:shadow-md dark:bg-white/[0.04] ${
        active ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-200 dark:border-white/10'
      }`}
    >
      {src
        ? <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
        : <span className="flex h-full w-full items-center justify-center text-[10px] text-gray-300">加载中</span>}
    </button>
  )
}

interface Props {
  /** 模板挂在哪个节点上：产品 id 或方向 id，两者各存各的键 */
  ownerId: string
  ownerName: string
  /**
   * 模板作用域。方向下配的是「方向专属模板」：只对这一个方向生效，
   * 配了之后该方向不再套产品模板；产品下配的则被整个产品共用。
   */
  scope?: PostTemplateScope
  onClose: () => void
}

export default function PostTemplateModal({ ownerId, ownerName, scope = 'product', onClose }: Props) {
  const stored = useSopStore((s) => s.postTemplates[ownerId])
  /**
   * 全量模板：只用来提示「这个方向现在会不会回落到产品模板」。
   * 弹窗里的编辑还没保存，所以这层信息始终读存档值。
   */
  const storedAll = useSopStore((s) => s.postTemplates)
  const setPostTemplates = useSopStore((s) => s.setPostTemplates)
  const setPostPreviewImage = useSopStore((s) => s.setPostPreviewImage)
  const directions = useSopStore((s) => s.directions)
  const tasks = useStore((s) => s.tasks)

  const [templates, setTemplates] = useState<PostTemplate[]>(() => stored ?? [])
  const [activeId, setActiveId] = useState<string>(() => stored?.[0]?.id ?? '')
  const [selectedId, setSelectedId] = useState<string>('')
  /** 列表筛选：渠道 + 尺寸（按比例归组）。只影响列表显示，不改模板本身 */
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [ratioFilter, setRatioFilter] = useState<string>('all')
  /**
   * 预览底图：比例档 → imageId。只影响预览，不参与出图。
   * 跟模板一样本地编辑、点保存才落盘，取消就还原。
   */
  const [previewMap, setPreviewMap] = useState<Record<string, string>>(
    () => ({ ...(useSopStore.getState().postPreviewImages[ownerId] ?? {}) }),
  )
  /** 底图解码后的 dataUrl；空表示用默认底色 */
  const [previewSrc, setPreviewSrc] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [previewWidth, setPreviewWidth] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    id: string
    startX: number
    startY: number
    originX: number
    originY: number
    /** 指针真的挪动过才算拖动，避免点一下也记一步历史 */
    moved: boolean
  } | null>(null)
  /**
   * 正在输入文字的元素。文字默认不可编辑（整块都能拖，跟 PS 一样），
   * 双击才进入编辑；不然一按下就把光标插进去、拖不动。
   */
  const [editingTextId, setEditingTextId] = useState('')
  const editingNodeRef = useRef<HTMLDivElement | null>(null)

  // ===== 撤销 / 重做 =====
  // 所有改动都走 commit，改动前的样子留在 past 里；拖动、连续输入按「一次操作」合并
  const templatesRef = useRef(templates)
  templatesRef.current = templates
  const pastRef = useRef<PostTemplate[][]>([])
  const futureRef = useRef<PostTemplate[][]>([])
  /** 同一段连续操作的标记：600ms 内同 key 的改动只记一次历史 */
  const coalesceRef = useRef<{ key: string; at: number } | null>(null)
  const [, bumpHistory] = useState(0)
  const refreshHistory = () => bumpHistory((value) => value + 1)

  const HISTORY_LIMIT = 50

  const pushHistory = (snapshot: PostTemplate[]) => {
    pastRef.current = [...pastRef.current, snapshot].slice(-HISTORY_LIMIT)
    futureRef.current = []
    refreshHistory()
  }

  const commit = (next: PostTemplate[], options: { coalesceKey?: string; record?: boolean } = {}) => {
    const prev = templatesRef.current
    if (next === prev) return
    if (options.record !== false) {
      const now = Date.now()
      const last = coalesceRef.current
      const sameGesture = Boolean(options.coalesceKey && last && last.key === options.coalesceKey && now - last.at < 600)
      if (!sameGesture) pushHistory(prev)
      coalesceRef.current = options.coalesceKey ? { key: options.coalesceKey, at: now } : null
    }
    templatesRef.current = next
    setTemplates(next)
  }

  const applyTemplates = (
    updater: (prev: PostTemplate[]) => PostTemplate[],
    options?: { coalesceKey?: string; record?: boolean },
  ) => commit(updater(templatesRef.current), options)

  const canUndo = pastRef.current.length > 0
  const canRedo = futureRef.current.length > 0

  const undo = () => {
    const past = pastRef.current
    if (!past.length) return
    const snapshot = past[past.length - 1]
    pastRef.current = past.slice(0, -1)
    futureRef.current = [templatesRef.current, ...futureRef.current].slice(0, HISTORY_LIMIT)
    coalesceRef.current = null
    templatesRef.current = snapshot
    setTemplates(snapshot)
    // 撤销后原来选中的元素可能已经不存在
    if (selectedId && !snapshot.some((item) => item.elements.some((element) => element.id === selectedId))) setSelectedId('')
    refreshHistory()
  }

  const redo = () => {
    const future = futureRef.current
    if (!future.length) return
    const snapshot = future[0]
    futureRef.current = future.slice(1)
    pastRef.current = [...pastRef.current, templatesRef.current].slice(-HISTORY_LIMIT)
    coalesceRef.current = null
    templatesRef.current = snapshot
    setTemplates(snapshot)
    if (selectedId && !snapshot.some((item) => item.elements.some((element) => element.id === selectedId))) setSelectedId('')
    refreshHistory()
  }

  // Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl+Y 重做；输入框里保留浏览器自己的撤销
  const undoRef = useRef(undo)
  const redoRef = useRef(redo)
  undoRef.current = undo
  redoRef.current = redo
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      if (key === 'y' || (key === 'z' && event.shiftKey)) redoRef.current()
      else undoRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    setPreviewWidth(el.clientWidth)
    const observer = new ResizeObserver((entries) => setPreviewWidth(entries[0].contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [activeId])

  // 换一套模板就退出文字编辑，否则编辑焦点留在上一套的元素上
  useEffect(() => {
    setEditingTextId('')
  }, [activeId])

  const active = useMemo(
    () => templates.find((item) => item.id === activeId) ?? templates[0] ?? null,
    [templates, activeId],
  )
  const selected = useMemo(
    () => active?.elements.find((item) => item.id === selectedId) ?? null,
    [active, selectedId],
  )

  /** 底图按比例档存：同比例的多套模板共用一张，换模板时不用重选 */
  const activeRatioKey = active ? postTemplateRatioKey(active) : ''
  const previewImageId = activeRatioKey ? previewMap[activeRatioKey] ?? '' : ''

  useEffect(() => {
    setPreviewSrc('')
    if (!previewImageId) return
    let cancelled = false
    ensureImageCached(previewImageId).then((url) => {
      if (!cancelled && url) setPreviewSrc(url)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [previewImageId])

  /** 可选底图：这个节点（产品及其方向 / 单个方向）下已完成的成品图，最近完成的排前面 */
  const previewCandidates = useMemo(() => {
    const subtree = new Set([ownerId])
    let grew = true
    while (grew) {
      grew = false
      for (const node of directions) {
        if (node.parentId && subtree.has(node.parentId) && !subtree.has(node.id)) {
          subtree.add(node.id)
          grew = true
        }
      }
    }
    const seen = new Set<string>()
    const list: string[] = []
    const ordered = [...tasks].sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
    for (const task of ordered) {
      if (task.status !== 'done' || !task.sopDirectionId || !subtree.has(task.sopDirectionId)) continue
      for (const imageId of task.outputImages) {
        if (!imageId || seen.has(imageId)) continue
        seen.add(imageId)
        list.push(imageId)
        if (list.length >= 60) return list
      }
    }
    return list
  }, [tasks, directions, ownerId])

  /** 选一张本地图当底图：先入图片库拿 id，和成品图走同一套引用 */
  const uploadPreviewImage = async (file: File) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取失败'))
        reader.readAsDataURL(file)
      })
      if (!dataUrl) return
      const imageId = await storeImage(dataUrl, 'upload')
      setPreviewMap((prev) => (activeRatioKey ? { ...prev, [activeRatioKey]: imageId } : prev))
      setPickerOpen(false)
    } catch (err) {
      console.error(err)
    }
  }

  const visibleTemplates = useMemo(
    () => templates.filter((item) => {
      if (ratioFilter !== 'all' && postTemplateRatioKey(item) !== ratioFilter) return false
      if (channelFilter === 'all') return true
      if (channelFilter === NO_CHANNEL) return !item.channel
      return item.channel === channelFilter
    }),
    [templates, channelFilter, ratioFilter],
  )

  // 筛选把正在编辑的模板挡掉了就切到第一套可见的，否则右侧改的是看不见的模板
  useEffect(() => {
    if (!visibleTemplates.length) return
    if (visibleTemplates.some((item) => item.id === active?.id)) return
    setActiveId(visibleTemplates[0]!.id)
    setSelectedId('')
  }, [visibleTemplates, active?.id])

  const patchActive = (next: Partial<PostTemplate>, options?: { coalesceKey?: string; record?: boolean }) => applyTemplates(
    (prev) => prev.map((item) => (item.id === active?.id ? { ...item, ...next } : item)),
    options,
  )

  /**
   * 体积上限的输入草稿：直接绑 maxFileKb 的数字会把「清空」当场变回上一个值，
   * 最后一位数字永远删不掉。草稿随选中的模板同步，失焦时才写回。
   */
  const [sizeLimitDraft, setSizeLimitDraft] = useState(
    () => (active?.maxFileKb == null ? '' : String(active.maxFileKb)),
  )
  useEffect(() => {
    setSizeLimitDraft(active?.maxFileKb == null ? '' : String(active.maxFileKb))
  }, [active?.id, active?.maxFileKb])

  const commitSizeLimit = () => {
    const kb = parseSizeLimitKb(sizeLimitDraft)
    if ((kb ?? null) !== (active?.maxFileKb ?? null)) {
      patchActive({ maxFileKb: kb }, { coalesceKey: 'template:maxFileKb' })
    }
    setSizeLimitDraft(kb == null ? '' : String(kb))
  }

  const patchElement = (
    id: string,
    next: Partial<PostElement>,
    options?: { coalesceKey?: string; record?: boolean },
  ) => applyTemplates(
    (prev) => prev.map((item) => (
      item.id === active?.id
        ? { ...item, elements: item.elements.map((element) => (element.id === id ? { ...element, ...next } : element)) }
        : item
    )),
    options,
  )

  const addTemplate = (width: number, height: number, label: string) => {
    // 筛选的是具体渠道，新建的模板就归到这个渠道；筛「全部 / 通用」时建通用模板
    const channel = channelFilter !== 'all' && channelFilter !== NO_CHANNEL ? channelFilter : undefined
    const template = { ...createPostTemplate(width, height, label), enabled: true, channel }
    // 同渠道、同比例还没有默认的，就把新的一套设为默认
    const hasDefault = templatesRef.current.some(
      (item) => item.isDefault
        && (item.channel ?? '') === (channel ?? '')
        && Math.abs(item.width / item.height - width / height) < 0.02,
    )
    template.isDefault = !hasDefault
    applyTemplates((prev) => [...prev, template])
    setActiveId(template.id)
    setSelectedId('')
  }

  const removeTemplate = (id: string) => {
    applyTemplates((prev) => prev.filter((item) => item.id !== id))
    if (activeId === id) setActiveId(templatesRef.current.find((item) => item.id !== id)?.id ?? '')
  }

  const addElement = (kind: PostElement['kind']) => {
    if (!active) return
    const element = newPostElement(kind, active.elements.length + 1)
    patchActive({ elements: [...active.elements, element] })
    setSelectedId(element.id)
  }

  /** 常用固定位：Logo 一般在角上，警示语/免责声明贴在底部，一键摆好并记下名称 */
  const addPresetSlot = (kind: 'logo-tl' | 'logo-tr' | 'notice') => {
    if (!active) return
    if (kind === 'notice') {
      const element: PostElement = {
        ...newPostElement('text', active.elements.length + 1),
        text: '免赔额、赔付比例、费率等请见保险条款及投保须知',
        label: '警示语',
        x: 0.06,
        y: 0.93,
        fontSize: Math.max(12, Math.round(active.height * 0.011)),
        fontWeight: 400,
        color: '#9ca3af',
      }
      patchActive({ elements: [...active.elements, element] })
      setSelectedId(element.id)
      return
    }
    const left = kind === 'logo-tl'
    const element: PostElement = {
      ...newPostElement('logo', active.elements.length + 1),
      label: 'Logo',
      x: left ? 0.05 : 0.81,
      y: 0.04,
      width: 0.14,
    }
    patchActive({ elements: [...active.elements, element] })
    setSelectedId(element.id)
  }

  const removeElement = (id: string) => {
    if (!active) return
    patchActive({ elements: active.elements.filter((item) => item.id !== id) })
    if (selectedId === id) setSelectedId('')
    if (editingTextId === id) setEditingTextId('')
  }

  const startDrag = (event: React.PointerEvent, element: PostElement) => {
    if (!stageRef.current) return
    // 只认主键；文字处于编辑态时把按下让给光标与选区
    if (event.button !== 0) return
    if (editingTextId === element.id) return
    event.stopPropagation()
    setSelectedId(element.id)
    // 历史点在真正开始移动时才记（见 onDrag），单纯点一下不该多一步撤销
    dragRef.current = {
      id: element.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: element.x,
      originY: element.y,
      moved: false,
    }
    // 捕获到元素自己身上：指针滑出画布也不会掉，事件继续冒泡到 stage 的 onPointerMove
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current
    const el = stageRef.current
    if (!drag || !el) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    // 手抖几像素不算拖动，否则单击选中的同时元素会轻微位移
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return
    if (!drag.moved) {
      drag.moved = true
      // 一次拖动只留一个历史点
      pushHistory(templatesRef.current)
    }
    // 按指针位移移动，不把锚点吸到指针上：抓哪儿都不会跳一下
    // 允许拖出画布：logo 常常要整块推到框外，锁在 0~1 就推不动
    patchElement(drag.id, {
      x: clampElementPos(drag.originX + (event.clientX - drag.startX) / rect.width),
      y: clampElementPos(drag.originY + (event.clientY - drag.startY) / rect.height),
    }, { record: false })
  }

  /** 双击进入文字编辑，并把光标放到末尾（直接全选会让一敲键盘就清空原文） */
  const beginTextEdit = (element: PostElement) => {
    setSelectedId(element.id)
    setEditingTextId(element.id)
  }

  useEffect(() => {
    if (!editingTextId) return
    const node = editingNodeRef.current
    if (!node) return
    node.focus()
    const range = document.createRange()
    range.selectNodeContents(node)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [editingTextId])

  /** 退出编辑：同步一次正文（拖选、粘贴可能没触发 onInput），但不额外记历史 */
  const endTextEdit = (element: PostElement, node: HTMLDivElement) => {
    const text = node.textContent || ''
    if (text !== element.text) patchElement(element.id, { text }, { record: false })
    setEditingTextId('')
  }

  /** 读图片顺便记下高宽比，避让区域要靠它算预留高度 */
  const logoAspect = (dataUrl: string): Promise<number | undefined> => new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(
      image.naturalWidth > 0 ? image.naturalHeight / image.naturalWidth : undefined,
    )
    image.onerror = () => resolve(undefined)
    image.src = dataUrl
  })

  const uploadLogo = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('读取失败'))
      reader.readAsDataURL(file)
    })
    const aspect = await logoAspect(dataUrl)
    if (selected?.kind === 'logo') {
      patchElement(selected.id, { text: dataUrl, ...(aspect ? { aspect } : {}) })
    } else if (active) {
      const element = { ...newPostElement('logo', active.elements.length + 1), text: dataUrl, ...(aspect ? { aspect } : {}) }
      patchActive({ elements: [...active.elements, element] })
      setSelectedId(element.id)
    }
  }

  const save = () => {
    setPostTemplates(ownerId, templates)
    // 底图只写有变化的档位，顺便把本次清空的档位删掉
    const prev = useSopStore.getState().postPreviewImages[ownerId] ?? {}
    const keys = new Set([...Object.keys(prev), ...Object.keys(previewMap)])
    for (const key of keys) {
      const next = previewMap[key] ?? null
      if ((prev[key] ?? null) !== next) setPostPreviewImage(ownerId, key, next)
    }
    onClose()
  }

  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)
  const ratio = active ? active.width / active.height : 1
  // 预览按成品宽等比缩小，字号与描边都要跟着缩
  const scale = active && active.width > 0 && previewWidth > 0 ? previewWidth / active.width : 1
  const enabledCount = templates.filter((item) => item.enabled).length
  // 方向专属模板与产品模板是二选一：这里把「现在到底用哪层」说清楚，
  // 否则在方向里配了一套、产品里也配了，出图效果对不上也看不出原因
  const parentProductId = scope === 'direction' ? productIdForDirection(directions, ownerId) : ''
  const parentProductName = directions.find((node) => node.id === parentProductId)?.name ?? ''
  const parentProductEnabled = parentProductId
    ? (storedAll[parentProductId] ?? []).filter((item) => item.enabled).length
    : 0
  const scopeHint = scope === 'direction'
    ? templates.length
      ? `方向专属模板：只对「${ownerName}」生效。这个方向已不再套用产品「${parentProductName || '上级产品'}」的模板。`
      : `方向专属模板：保存后只对「${ownerName}」生效。现在还没配，出图仍沿用产品「${parentProductName || '上级产品'}」的模板${parentProductEnabled ? `（已启用 ${parentProductEnabled} 套）` : ''}。`
    : '产品通用模板：这个产品下的方向共用；某个方向配了专属模板后，那个方向改用自己的。'
  // 预留区：这套模板里参与避让的 Logo / 警示语位置，写提示词时会原样带进去
  const avoidHint = useMemo(() => buildAvoidHint(active), [active])
  const avoidZoneCount = useMemo(() => collectAvoidZones(active).length, [active])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {ownerName} · {scope === 'direction' ? '方向专属模板' : '后处理模板'}
          </h2>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            {enabledCount} 套启用 / 共 {templates.length} 套
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              title={`撤销${isMac ? '（⌘Z）' : '（Ctrl+Z）'}`}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 14L4 9l5-5" />
                <path strokeLinecap="round" d="M4 9h9a6 6 0 110 12h-3" />
              </svg>
              撤销
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              title={`重做${isMac ? '（⌘⇧Z）' : '（Ctrl+Shift+Z）'}`}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 14l5-5-5-5" />
                <path strokeLinecap="round" d="M20 9h-9a6 6 0 100 12h3" />
              </svg>
              重做
            </button>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">取消</button>
          <button type="button" onClick={save} className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600">保存</button>
        </div>

        {/* 作用域说明：方向专属与产品通用只能生效一层，不写清楚很难判断为什么没套上 */}
        <div className={`border-b px-4 py-1.5 text-[11px] ${
          scope === 'direction'
            ? 'border-amber-100 bg-amber-50/70 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/[0.08] dark:text-amber-300'
            : 'border-gray-100 bg-gray-50/70 text-gray-500 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-gray-400'
        }`}>
          {scopeHint}
        </div>

        {/* 模板筛选：渠道 + 尺寸（按比例归组），只筛列表，不影响按比例自动套用 */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 px-4 py-2 dark:border-white/[0.08]">
          <span className="mr-0.5 text-[10px] text-gray-400">渠道</span>
          <FilterChip active={channelFilter === 'all'} onClick={() => setChannelFilter('all')}>全部</FilterChip>
          <FilterChip active={channelFilter === NO_CHANNEL} onClick={() => setChannelFilter(NO_CHANNEL)}>通用</FilterChip>
          {CHANNELS.map((item) => (
            <FilterChip key={item.value} active={channelFilter === item.value} onClick={() => setChannelFilter(item.value)}>
              {item.label}
            </FilterChip>
          ))}
          <span className="mx-1.5 h-4 w-px bg-gray-200 dark:bg-white/10" />
          <span className="mr-0.5 text-[10px] text-gray-400">尺寸</span>
          <FilterChip active={ratioFilter === 'all'} onClick={() => setRatioFilter('all')}>全部</FilterChip>
          {POST_RATIO_FILTERS.map((item) => (
            <FilterChip key={item.value} active={ratioFilter === item.value} onClick={() => setRatioFilter(item.value)}>
              {item.value}
            </FilterChip>
          ))}
          {templates.some((item) => postTemplateRatioKey(item) === 'other') && (
            <FilterChip active={ratioFilter === 'other'} onClick={() => setRatioFilter('other')}>其他</FilterChip>
          )}
          <div className="flex-1" />
          <span className="text-[10px] tabular-nums text-gray-400">
            显示 {visibleTemplates.length} / {templates.length} 套
          </span>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 画布预览 */}
          <div className="relative flex min-w-0 flex-1 flex-col bg-gray-100 dark:bg-black/30">
            {/* 底图按比例档存：不给就一直是默认底色，不会自动拿成品图来顶 */}
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-gray-200 px-3 py-1.5 dark:border-white/[0.06]">
              <span className="text-[10px] text-gray-400">预览底图</span>
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/10 dark:text-gray-300">
                {activeRatioKey === 'other' ? '其他比例' : activeRatioKey || '—'}
              </span>
              <span className="text-[10px] text-gray-400">{previewImageId ? '已设置' : '默认底色'}</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                disabled={!active}
                className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-600 hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-gray-800 dark:text-gray-300"
              >
                选择底图…
              </button>
              {previewImageId && (
                <button
                  type="button"
                  onClick={() => {
                    if (!activeRatioKey) return
                    setPreviewMap((prev) => {
                      const next = { ...prev }
                      delete next[activeRatioKey]
                      return next
                    })
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-red-500"
                >
                  用默认
                </button>
              )}
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
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
                  <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-200 to-gray-300 px-6 text-center text-xs text-gray-500 dark:from-gray-800 dark:to-gray-700">
                    未设置预览底图，按默认底色排版
                  </div>
                )}

                {active.elements.map((element) => {
                  const isActive = selectedId === element.id
                  const isEditing = element.kind === 'text' && editingTextId === element.id
                  return (
                    <div
                      key={element.id}
                      // 整块都能拖：按下即抓取，位移按指针算，抓左上角还是右下角都一样（和 PS 一致）
                      onPointerDown={(e) => startDrag(e, element)}
                      onDoubleClick={(e) => {
                        if (element.kind !== 'text') return
                        e.stopPropagation()
                        beginTextEdit(element)
                      }}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(element.id) }}
                      title={element.kind === 'text' ? '拖动调整位置，双击编辑文字' : '拖动调整位置'}
                      className={`absolute ${isEditing ? 'cursor-text' : 'cursor-move touch-none select-none'} ${
                        isActive ? 'ring-2 ring-blue-500' : 'ring-1 ring-transparent hover:ring-blue-300'
                      }`}
                      style={{ left: `${element.x * 100}%`, top: `${element.y * 100}%`, opacity: element.opacity }}
                    >
                      {isActive && !isEditing && (
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
                                lineHeight: elementLineHeight(element),
                                letterSpacing: `${(element.letterSpacing ?? 0) * scale}px`,
                                whiteSpace: 'pre',
                                pointerEvents: 'none',
                              }}
                            >
                              {element.text}
                            </div>
                          )}
                          <div
                            // 只有编辑态才挂 ref：非编辑态复用同一个节点时别把焦点抢过来
                            ref={(node) => {
                              if (node && isEditing) editingNodeRef.current = node
                            }}
                            contentEditable={isEditing}
                            suppressContentEditableWarning
                            spellCheck={false}
                            // 编辑态下的按下要留给光标/选区，不能当成拖动
                            onPointerDown={(e) => {
                              if (isEditing) e.stopPropagation()
                            }}
                            onInput={(e) => patchElement(element.id, { text: e.currentTarget.textContent || '' }, { coalesceKey: `text:${element.id}` })}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                e.currentTarget.blur()
                              }
                            }}
                            onBlur={(e) => endTextEdit(element, e.currentTarget)}
                            style={{
                              position: 'relative',
                              fontFamily: POST_FONT_STACK,
                              fontSize: `${Math.max(1, element.fontSize * scale)}px`,
                              fontWeight: element.fontWeight,
                              color: element.color,
                              textAlign: element.align,
                              lineHeight: elementLineHeight(element),
                              letterSpacing: `${(element.letterSpacing ?? 0) * scale}px`,
                              whiteSpace: 'pre',
                              cursor: isEditing ? 'text' : 'inherit',
                              // 画布上 x 是锚点：居中/右对齐时文字往左展开，预览要跟绘制一致
                              transform: element.align === 'center'
                                ? 'translateX(-50%)'
                                : element.align === 'right'
                                  ? 'translateX(-100%)'
                                  : undefined,
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

            {/* 底图选择：列出这个产品下的成品图，也可以传自己的图 */}
            {pickerOpen && active && (
              <div className="absolute inset-0 z-20 flex flex-col bg-white/95 dark:bg-gray-900/95">
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-white/10">
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-gray-700 dark:text-gray-200">
                      选择 {activeRatioKey === 'other' ? '该比例' : activeRatioKey} 的预览底图
                    </div>
                    <div className="text-[10px] text-gray-400">只影响预览，不参与出图；保存后才生效</div>
                  </div>
                  <div className="flex-1" />
                  <label className="cursor-pointer rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-300">
                    上传图片
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void uploadPreviewImage(file)
                        e.target.value = ''
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setPickerOpen(false)}
                    className="rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
                  >
                    关闭
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <div className="grid grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewMap((prev) => {
                          const next = { ...prev }
                          delete next[activeRatioKey]
                          return next
                        })
                        setPickerOpen(false)
                      }}
                      className={`flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-[10px] ${
                        previewImageId
                          ? 'border-gray-300 text-gray-400 hover:border-blue-300 hover:text-blue-600 dark:border-white/15'
                          : 'border-blue-500 text-blue-600 ring-2 ring-blue-500'
                      }`}
                    >
                      <span className="text-[11px] font-medium">默认底色</span>
                      <span>不用底图</span>
                    </button>
                    {previewCandidates.map((imageId) => (
                      <PreviewThumb
                        key={imageId}
                        imageId={imageId}
                        active={imageId === previewImageId}
                        onPick={() => {
                          setPreviewMap((prev) => ({ ...prev, [activeRatioKey]: imageId }))
                          setPickerOpen(false)
                        }}
                      />
                    ))}
                  </div>
                  {!previewCandidates.length && (
                    <p className="mt-3 text-center text-[11px] text-gray-400">这个产品还没有成品图，可以点右上角上传一张</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 右侧面板 */}
          <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-gray-200 p-3 dark:border-white/[0.08]">
            <div className="mb-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">模板（按出图比例自动选）</div>
            <div className="mb-2 space-y-1">
              {visibleTemplates.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] ${active?.id === item.id ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'}`}
                >
                  <button type="button" onClick={() => { setActiveId(item.id); setSelectedId('') }} className="min-w-0 flex-1 truncate text-left">
                    {item.label}
                    <span className="ml-1 text-gray-400">{item.width}×{item.height}</span>
                    {item.channel && (
                      <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
                        {channelLabel(item.channel)}
                      </span>
                    )}
                    {item.isDefault && <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-600 dark:bg-blue-500/20 dark:text-blue-300">默认</span>}
                  </button>
                  <label className="flex shrink-0 items-center gap-0.5 text-[10px] text-gray-400" title="启用后参与自动套用">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(e) => applyTemplates((prev) => prev.map((t) => (t.id === item.id ? { ...t, enabled: e.target.checked } : t)))}
                      className="h-3 w-3 accent-blue-500"
                    />
                    启用
                  </label>
                  <button
                    type="button"
                    title="设为默认"
                    onClick={() => applyTemplates((prev) => prev.map((t) => {
                      if (t.id === item.id) return { ...t, isDefault: true }
                      // 默认是「同渠道 + 同比例」范围内唯一，别把别的渠道默认也清掉
                      const sameChannel = (t.channel ?? '') === (item.channel ?? '')
                      return sameChannel && Math.abs(t.width / t.height - item.width / item.height) < 0.02
                        ? { ...t, isDefault: false }
                        : t
                    }))}
                    className={`shrink-0 rounded px-1 ${item.isDefault ? 'text-blue-500' : 'text-gray-300 hover:text-blue-500'}`}
                  >
                    ★
                  </button>
                  <button type="button" onClick={() => removeTemplate(item.id)} className="shrink-0 text-gray-300 hover:text-red-500">✕</button>
                </div>
              ))}
              {!visibleTemplates.length && (
                <p className="px-1 py-1 text-[11px] text-gray-400">
                  {templates.length ? '没有符合筛选的模板' : '还没有模板'}
                </p>
              )}
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
                    onChange={(e) => patchActive({ label: e.target.value }, { coalesceKey: 'template:label' })}
                    className="mb-1 w-full rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                  />
                  <div className="flex items-center gap-1">
                    <NumberInput
                      value={active.width}
                      min={MIN_SIZE}
                      onCommit={(width) => patchActive({ width }, { coalesceKey: 'template:width' })}
                    />
                    <span className="text-gray-400">×</span>
                    <NumberInput
                      value={active.height}
                      min={MIN_SIZE}
                      onCommit={(height) => patchActive({ height }, { coalesceKey: 'template:height' })}
                    />
                  </div>
                </div>

                <div className="mb-2">
                  <div className="mb-1 text-[10px] text-gray-400">投放渠道（通用模板任何渠道都能套）</div>
                  <select
                    value={active.channel ?? ''}
                    onChange={(e) => patchActive({ channel: e.target.value || undefined })}
                    className="w-full rounded border border-gray-200 bg-white px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                  >
                    <option value="">通用（不限定渠道）</option>
                    {CHANNELS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>

                {/*
                  体积上限跟模板走：各家平台的要求是绑在「渠道 + 尺寸」上的，
                  放在输入区的全局开关里做不到一尺寸一值。留空表示这套模板不额外限制。
                */}
                <div className="mb-2">
                  <div className="mb-1 text-[10px] text-gray-400">限制文件大小（留空不限制）</div>
                  <div className="flex items-center gap-1">
                    <input
                      value={sizeLimitDraft}
                      onChange={(e) => setSizeLimitDraft(e.target.value.replace(/[^\d]/g, ''))}
                      onBlur={commitSizeLimit}
                      inputMode="numeric"
                      placeholder="不限"
                      className="min-w-0 flex-1 rounded border border-gray-200 px-1.5 py-1 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                    />
                    <span className="shrink-0 text-[10px] text-gray-400">KB</span>
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-gray-400">
                    套这套模板出图后压到这个体积以内，比输入区「更多 → 限制大小」优先。
                    PNG 无损压不下去，会转成 WebP；模板配了上限时 PNG 也会被压。
                  </p>
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

                <div className="mb-1 text-[10px] text-gray-400">常用固定位（点了再上传 logo / 改文字）</div>
                <div className="mb-2 flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => addPresetSlot('logo-tl')}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-300"
                  >
                    Logo 左上
                  </button>
                  <button
                    type="button"
                    onClick={() => addPresetSlot('logo-tr')}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-300"
                  >
                    Logo 右上
                  </button>
                  <button
                    type="button"
                    onClick={() => addPresetSlot('notice')}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-300"
                  >
                    警示语 底部
                  </button>
                </div>

                <label className="mb-2 flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 px-2 py-1.5 dark:border-white/10" title="写提示词时自动带上「画面预留区」说明">
                  <input
                    type="checkbox"
                    checked={active.avoidOverlay !== false}
                    onChange={(e) => patchActive({ avoidOverlay: e.target.checked })}
                    className="mt-0.5 h-3 w-3 accent-blue-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium text-gray-700 dark:text-gray-200">提示词自动避让预留区</span>
                    <span className="block text-[10px] leading-relaxed text-gray-400">
                      开启后生图前会把这套模板的 Logo / 警示语位置写进提示词，让主体和文字避开；当前 {avoidZoneCount} 处参与避让。
                    </span>
                  </span>
                </label>

                <div className="mb-3">
                  <div className="mb-1.5 flex items-baseline justify-between px-0.5">
                    <span className="text-[10px] font-semibold tracking-wide text-gray-500 dark:text-gray-400">
                      图层
                      <span className="ml-1 rounded-full bg-gray-100 px-1.5 py-px text-[9px] font-medium tabular-nums text-gray-500 dark:bg-white/10 dark:text-gray-400">
                        {active.elements.length}
                      </span>
                    </span>
                    <span className="text-[9px] text-gray-300 dark:text-gray-500">选中后画布上直接拖</span>
                  </div>

                  <div className="space-y-1">
                    {active.elements.map((element, index) => {
                      const isActive = selectedId === element.id
                      // 有自定义名称就优先显示名称，没有才退回「文字 1 / Logo 2」
                      const title = element.label?.trim() || (element.kind === 'text' ? `文字 ${index + 1}` : `Logo ${index + 1}`)
                      const subtitle = element.kind === 'text'
                        ? (element.text.replace(/\s*\n\s*/g, ' ').trim() || '空内容')
                        : `宽 ${Math.round(element.width * 100)}%`
                      const avoid = element.avoid !== false
                      return (
                        <div
                          key={element.id}
                          className={`group relative flex items-center gap-1.5 rounded-lg border py-1 pl-2 pr-1 transition ${
                            isActive
                              ? 'border-blue-300/80 bg-blue-50 shadow-sm dark:border-blue-400/40 dark:bg-blue-500/[0.12]'
                              : 'border-gray-200/90 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-white/20 dark:hover:bg-white/[0.06]'
                          }`}
                        >
                          {/* 选中态左侧蓝条，比纯底色更好认 */}
                          <span className={`absolute inset-y-1 left-0 w-[3px] rounded-full ${isActive ? 'bg-blue-500' : 'bg-transparent'}`} />

                          <button
                            type="button"
                            onClick={() => setSelectedId(element.id)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            <span
                              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold ${
                                element.kind === 'text'
                                  ? 'bg-sky-100 text-sky-600 dark:bg-sky-500/20 dark:text-sky-300'
                                  : 'bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300'
                              }`}
                            >
                              {element.kind === 'text' ? 'T' : (
                                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.4">
                                  <rect x="2" y="3" width="12" height="10" rx="1.5" />
                                  <path d="M2 10.5l3-3 2.5 2.5L10 7.5l4 4" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className={`block truncate text-[11px] font-medium ${isActive ? 'text-blue-700 dark:text-blue-200' : 'text-gray-700 dark:text-gray-200'}`}>
                                {title}
                              </span>
                              <span className="block truncate text-[10px] leading-tight text-gray-400 dark:text-gray-500">
                                {subtitle}
                              </span>
                            </span>
                          </button>

                          {/* 「避让」做成小开关：亮蓝=参与避让，灰色=这块是设计的一部分 */}
                          <label
                            className="flex shrink-0 cursor-pointer items-center"
                            title={avoid ? '写提示词时会让主体避开这块位置（点击关闭）' : '这块不参与避让，生图时不需要特意留白（点击开启）'}
                          >
                            <input
                              type="checkbox"
                              checked={avoid}
                              onChange={(e) => patchElement(element.id, { avoid: e.target.checked })}
                              className="peer sr-only"
                            />
                            <span
                              className={`flex items-center gap-1 rounded-md border px-1 py-[3px] text-[9px] leading-none transition peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/60 ${
                                avoid
                                  ? 'border-blue-300/70 bg-blue-500/10 font-medium text-blue-600 dark:border-blue-400/40 dark:bg-blue-500/15 dark:text-blue-300'
                                  : 'border-gray-200 bg-gray-50 text-gray-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-500'
                              }`}
                            >
                              <span className={`h-1 w-1 rounded-full ${avoid ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
                              避让
                            </span>
                          </label>

                          <button
                            type="button"
                            onClick={() => removeElement(element.id)}
                            title="删除这个图层"
                            className="shrink-0 rounded p-0.5 text-[11px] leading-none text-gray-300 transition hover:bg-red-50 hover:text-red-500 dark:text-gray-500 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                          >
                            ✕
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  {!active.elements.length && (
                    <div className="rounded-lg border border-dashed border-gray-200 px-2 py-3 text-center text-[10px] text-gray-400 dark:border-white/10 dark:text-gray-500">
                      还没有元素，用上面的「+ 文字」「+ Logo」添加
                    </div>
                  )}
                </div>

                {selected && (
                  <div className="space-y-2 rounded-lg bg-gray-50 p-2 dark:bg-white/[0.04]">
                    <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                      {selected.kind === 'text' ? '文字设置' : 'Logo 设置'}
                      {/* 整块都能拖（和 PS 一样），提示别再引导用户去找左上角的小圆点 */}
                      <span className="ml-1 text-gray-400">{selected.kind === 'text' ? '整块可拖 · 双击改字' : '整块可拖'}</span>
                    </div>

                    <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                      名称
                      <input
                        value={selected.label ?? ''}
                        placeholder={selected.kind === 'logo' ? 'Logo' : '警示语'}
                        onChange={(e) => patchElement(selected.id, { label: e.target.value }, { coalesceKey: `label:${selected.id}` })}
                        className="min-w-0 flex-1 rounded border border-gray-200 px-1.5 py-0.5 text-[11px] dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                      />
                    </label>

                    <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400" title="关闭表示这块是设计的一部分，生图时不用特意留白">
                      <input
                        type="checkbox"
                        checked={selected.avoid !== false}
                        onChange={(e) => patchElement(selected.id, { avoid: e.target.checked })}
                        className="h-3 w-3 accent-blue-500"
                      />
                      写提示词时避开这块位置
                    </label>

                    {selected.kind === 'text' ? (
                      <>
                        <textarea
                          value={selected.text}
                          onChange={(e) => patchElement(selected.id, { text: e.target.value }, { coalesceKey: `text:${selected.id}` })}
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
                            onChange={(e) => patchElement(selected.id, { fontSize: Number(e.target.value) }, { coalesceKey: `fontSize:${selected.id}` })}
                            className="flex-1 accent-blue-500"
                          />
                          <span className="flex items-center gap-0.5">
                            <NumberInput
                              value={selected.fontSize}
                              min={1}
                              onCommit={(fontSize) => patchElement(selected.id, { fontSize }, { coalesceKey: `fontSize:${selected.id}` })}
                              className="w-12 rounded border border-gray-200 px-1 py-0.5 text-[11px] tabular-nums dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                            />
                            px
                          </span>
                        </label>
                        {/* 对齐：画布上 x 是锚点，居中/右对齐时文字往左展开 */}
                        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                          对齐
                          <div className="flex overflow-hidden rounded border border-gray-200 dark:border-white/10">
                            {([
                              ['left', '左'],
                              ['center', '中'],
                              ['right', '右'],
                            ] as Array<[PostElement['align'], string]>).map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => patchElement(selected.id, { align: value })}
                                className={`px-2 py-0.5 text-[11px] transition-colors ${
                                  selected.align === value
                                    ? 'bg-blue-500 text-white'
                                    : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/10'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => patchElement(selected.id, { align: 'center', x: 0.5 })}
                            title="把这一行文字摆到画面正中（x=50%，居中对齐）"
                            className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 transition-colors hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-300"
                          >
                            居中到画布
                          </button>
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                          行距
                          <input
                            type="range"
                            min={POST_LINE_HEIGHT_RANGE.min}
                            max={POST_LINE_HEIGHT_RANGE.max}
                            step={POST_LINE_HEIGHT_RANGE.step}
                            value={elementLineHeight(selected)}
                            onChange={(e) => patchElement(selected.id, { lineHeight: Number(e.target.value) }, { coalesceKey: `lineHeight:${selected.id}` })}
                            className="flex-1 accent-blue-500"
                          />
                          <span className="w-10 text-right tabular-nums">{elementLineHeight(selected).toFixed(2)}</span>
                        </label>
                        <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                          字间距
                          <input
                            type="range"
                            min={POST_LETTER_SPACING_RANGE.min}
                            max={POST_LETTER_SPACING_RANGE.max}
                            step={POST_LETTER_SPACING_RANGE.step}
                            value={selected.letterSpacing ?? 0}
                            onChange={(e) => patchElement(selected.id, { letterSpacing: Number(e.target.value) }, { coalesceKey: `letterSpacing:${selected.id}` })}
                            className="flex-1 accent-blue-500"
                          />
                          <span className="flex items-center gap-0.5">
                            <NumberInput
                              value={selected.letterSpacing ?? 0}
                              min={POST_LETTER_SPACING_RANGE.min}
                              onCommit={(letterSpacing) => patchElement(selected.id, { letterSpacing }, { coalesceKey: `letterSpacing:${selected.id}` })}
                              className="w-11 rounded border border-gray-200 px-1 py-0.5 text-[11px] tabular-nums dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                            />
                            px
                          </span>
                        </label>
                        <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                          颜色
                          <input
                            type="color"
                            value={selected.color}
                            onChange={(e) => patchElement(selected.id, { color: e.target.value }, { coalesceKey: `color:${selected.id}` })}
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
                            onChange={(e) => patchElement(selected.id, { strokeColor: e.target.value }, { coalesceKey: `strokeColor:${selected.id}` })}
                            className="h-6 w-8 cursor-pointer rounded border border-gray-200 dark:border-white/10"
                          />
                          <input
                            type="range"
                            min={0}
                            max={24}
                            step={0.5}
                            value={selected.strokeWidth}
                            onChange={(e) => patchElement(selected.id, { strokeWidth: Number(e.target.value) }, { coalesceKey: `strokeWidth:${selected.id}` })}
                            className="flex-1 accent-blue-500"
                          />
                          <span className="flex items-center gap-0.5">
                            <NumberInput
                              value={selected.strokeWidth}
                              min={0}
                              step={0.5}
                              allowDecimal
                              onCommit={(strokeWidth) => patchElement(selected.id, { strokeWidth }, { coalesceKey: `strokeWidth:${selected.id}` })}
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
                          onChange={(e) => patchElement(selected.id, { width: Number(e.target.value) }, { coalesceKey: `logoWidth:${selected.id}` })}
                          className="flex-1 accent-blue-500"
                        />
                        <span className="w-8 tabular-nums">{Math.round(selected.width * 100)}%</span>
                      </label>
                    )}

                    <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                      位置
                      <span className="flex items-center gap-0.5">
                        X
                        <NumberInput
                          value={Math.round(selected.x * 1000) / 10}
                          // 允许负值：把这块推到画布外（成品图上会被裁掉），想留空版位时用
                          min={-ELEMENT_POS_LIMIT * 100}
                          step={0.1}
                          allowDecimal
                          allowNegative
                          onCommit={(percent) => patchElement(selected.id, { x: clampElementPos(percent / 100) }, { coalesceKey: `x:${selected.id}` })}
                          className="w-12 rounded border border-gray-200 px-1 py-0.5 text-[11px] tabular-nums dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                        />
                        %
                      </span>
                      <span className="flex items-center gap-0.5">
                        Y
                        <NumberInput
                          value={Math.round(selected.y * 1000) / 10}
                          min={-ELEMENT_POS_LIMIT * 100}
                          step={0.1}
                          allowDecimal
                          allowNegative
                          onCommit={(percent) => patchElement(selected.id, { y: clampElementPos(percent / 100) }, { coalesceKey: `y:${selected.id}` })}
                          className="w-12 rounded border border-gray-200 px-1 py-0.5 text-[11px] tabular-nums dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                        />
                        %
                      </span>
                    </div>

                    {/* 位置可以填负值把这块推到画布外（成品图上会被裁掉）。
                        推出去之后预览里就看不见了，给一个一键归位，免得找不回来 */}
                    {(selected.x < 0 || selected.y < 0) && (
                      <div className="flex items-start justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] leading-relaxed text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
                        <span>这块已被推到画布外，成品图上看不到它。</span>
                        <button
                          type="button"
                          onClick={() => patchElement(selected.id, { x: Math.max(0, selected.x), y: Math.max(0, selected.y) }, { coalesceKey: `posReset:${selected.id}` })}
                          className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
                        >
                          移回框内
                        </button>
                      </div>
                    )}

                    <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                      透明度
                      <input
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.05}
                        value={selected.opacity}
                        onChange={(e) => patchElement(selected.id, { opacity: Number(e.target.value) }, { coalesceKey: `opacity:${selected.id}` })}
                        className="flex-1 accent-blue-500"
                      />
                      <span className="w-8 tabular-nums">{Math.round(selected.opacity * 100)}%</span>
                    </label>
                  </div>
                )}
              </>
            )}

            {avoidHint && (
              <div className="mt-3 rounded-lg bg-blue-50 p-2 dark:bg-blue-500/10">
                <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-300">
                  写进提示词的避让说明
                  <span className="text-[10px] font-normal text-blue-500/70 dark:text-blue-300/70">{avoidZoneCount} 处预留区</span>
                </div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-blue-700 dark:text-blue-200">
                  {avoidHint}
                </pre>
              </div>
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
