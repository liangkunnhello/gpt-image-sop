import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SopDirectionNode } from '../types'
import { useStore } from '../store'
import { groupSopTasks } from '../lib/sopGroup'
import { directionPath, useSopStore, UNASSIGNED_FILTER } from '../lib/sopStore'
import { trashNodeWithTasks } from '../lib/directionTree'
import { ensureImageCached } from '../lib/imageCache'
import PostTemplateModal from './PostTemplateModal'
import MoveNodeModal from './MoveNodeModal'

const FolderIcon = ({ className = 'h-4 w-4' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2h9A1.5 1.5 0 0121 9.5v8A1.5 1.5 0 0119.5 19h-15A1.5 1.5 0 013 17.5v-10z" />
  </svg>
)

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
  </svg>
)

/** 左侧「产品-方向」任务栏：常驻、可收起、任意层级筛选 */
export default function SopDirectionTree() {
  const directions = useSopStore((s) => s.directions)
  const systemPrompts = useSopStore((s) => s.systemPrompts)
  const activeFilterId = useSopStore((s) => s.activeFilterId)
  const setActiveFilter = useSopStore((s) => s.setActiveFilter)
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const sopMode = useSopStore((s) => s.sopMode)
  const variableMode = useSopStore((s) => s.variableMode)
  // 两个模式都会把任务挂到当前方向，侧栏提示统一处理
  const sopStyleMode = sopMode || variableMode
  const collapsed = useSopStore((s) => s.sidebarCollapsed)
  const setCollapsed = useSopStore((s) => s.setSidebarCollapsed)
  const addNode = useSopStore((s) => s.addNode)
  const moveNode = useSopStore((s) => s.moveNode)
  const renameNode = useSopStore((s) => s.renameNode)
  const setTrashOpen = useSopStore((s) => s.setTrashOpen)
  const tasks = useStore((s) => s.tasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  const [postTarget, setPostTarget] = useState<{ id: string; name: string } | null>(null)
  const [postPreview, setPostPreview] = useState('')
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  /** 新增下级时的父节点；null 表示新建顶层类目 */
  const [addingUnder, setAddingUnder] = useState<{ parentId: string | null; kind: SopDirectionNode['kind'] } | null>(null)
  /** 右键菜单：位置 + 目标节点 */
  const [menu, setMenu] = useState<{ x: number; y: number; node: SopDirectionNode | null } | null>(null)
  const [moveTarget, setMoveTarget] = useState<SopDirectionNode | null>(null)

  const openPostTemplate = async (product: SopDirectionNode) => {
    setPostTarget({ id: product.id, name: product.name })
    setPostPreview('')
    const subtree = new Set([product.id])
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
    const latest = [...tasks]
      .filter((task) => task.status === 'done' && task.outputImages.length && task.sopDirectionId && subtree.has(task.sopDirectionId))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!latest) return
    const dataUrl = await ensureImageCached(latest.outputImages[0])
    if (dataUrl) setPostPreview(dataUrl)
  }
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  /** 当前归属节点及其全部祖先，用于让整条路径高亮 + 自动展开 */
  const currentPathIds = useMemo(() => {
    const set = new Set<string>()
    let cursor = directions.find((node) => node.id === activeDirectionId)
    while (cursor) {
      set.add(cursor.id)
      const parentId = cursor.parentId
      cursor = parentId ? directions.find((node) => node.id === parentId) : undefined
    }
    return set
  }, [directions, activeDirectionId])

  // 当前归属被折叠在树里时自动展开祖先，否则用户看不到高亮在哪。
  // 只在归属本身变化时做，避免别处改动把用户手动折叠的层级又强行展开。
  const expandedFor = useRef('')
  useEffect(() => {
    if (!activeDirectionId || expandedFor.current === activeDirectionId) return
    expandedFor.current = activeDirectionId
    setFolded((prev) => {
      if (!prev.size) return prev
      const next = new Set(prev)
      let changed = false
      for (const id of currentPathIds) {
        if (id !== activeDirectionId && next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
    // 展开后等一帧再滚动，否则节点还没渲染出来
    const timer = setTimeout(() => {
      scrollRef.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ block: 'nearest' })
    }, 60)
    return () => clearTimeout(timer)
  }, [activeDirectionId, currentPathIds])

  const categories = useMemo(() => directions.filter((node) => node.kind === 'category' && !node.deletedAt), [directions])
  const childrenOf = (id: string) => directions.filter((node) => node.parentId === id && !node.deletedAt)
  const promptCount = (productId: string) => systemPrompts.filter((item) => item.productId === productId).length

  // 数量统一按「任务卡」算：SOP 一卡多条提示词也只算一张，跟画廊里看到的卡片数一致
  const cards = useMemo(() => groupSopTasks(tasks), [tasks])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const card of cards) {
      const directionId = card.sopDirectionId
      if (!directionId) continue
      let cursor = directions.find((node) => node.id === directionId)
      while (cursor) {
        map.set(cursor.id, (map.get(cursor.id) ?? 0) + 1)
        const parentId = cursor.parentId
        cursor = parentId ? directions.find((node) => node.id === parentId) : undefined
      }
    }
    return map
  }, [cards, directions])

  const unassigned = useMemo(() => cards.filter((card) => !card.sopDirectionId).length, [cards])
  const matches = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return []
    return directions.filter((node) => node.kind !== 'category' && !node.deletedAt && node.name.toLowerCase().includes(keyword))
  }, [directions, search])

  const toggle = (id: string) => {
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const activeNode = directions.find((node) => node.id === activeFilterId)
  const currentNode = directions.find((node) => node.id === activeDirectionId)
  const currentPath = currentNode ? directionPath(directions, activeDirectionId) : ''
  const parentProduct = activeNode?.kind === 'direction'
    ? directions.find((node) => node.id === activeNode.parentId)
    : activeNode

  /** 打开「新建」输入框；不传参时沿用旧行为：在当前产品下建方向 */
  const beginAdd = (parentId: string | null, kind: SopDirectionNode['kind']) => {
    setAddingUnder({ parentId, kind })
    setDraft('')
    setAdding(true)
    // 新建在多层级下，需要先展开父级，否则输入框藏在折叠里
    if (parentId) setFolded((prev) => {
      if (!prev.has(parentId)) return prev
      const next = new Set(prev)
      next.delete(parentId)
      return next
    })
  }

  const submitDraft = () => {
    const name = draft.trim()
    if (!name) return
    const target = addingUnder ?? {
      parentId: parentProduct?.id ?? categories[0]?.id ?? null,
      kind: 'direction' as const,
    }
    addNode(target.parentId, name, target.kind)
    setDraft('')
    setAdding(false)
    setAddingUnder(null)
  }

  /** 删除：二次确认 → 连子孙进回收站 → 下属任务卡划为未归属 */
  const trashNode = (node: SopDirectionNode) => {
    const subs = (() => {
      const ids = new Set([node.id])
      let grew = true
      while (grew) {
        grew = false
        for (const item of directions) {
          if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
            ids.add(item.id)
            grew = true
          }
        }
      }
      return ids
    })()
    const cardCount = cards.filter((card) => card.sopDirectionId && subs.has(card.sopDirectionId)).length
    const kindLabel = node.kind === 'category' ? '类目' : node.kind === 'product' ? '产品' : '方向'
    const subCount = subs.size - 1
    setConfirmDialog({
      title: `删除${kindLabel}`,
      message: [
        `确定删除「${node.name}」吗？`,
        subCount > 0 ? `它下面的 ${subCount} 个下级节点会一起进回收站。` : '',
        cardCount > 0 ? `${cardCount} 张任务卡会变为「未归属」。` : '',
        '删除后可以在「回收站」里恢复，不会立即丢失。',
      ].filter(Boolean).join('\n'),
      action: () => {
        void trashNodeWithTasks(node.id).then(({ clearedCards }) => {
          showToast(
            clearedCards > 0
              ? `已移入回收站，${clearedCards} 张任务卡已划为未归属`
              : '已移入回收站',
            'success',
          )
        })
      },
    })
  }

  const submitMove = (parentId: string | null) => {
    if (!moveTarget) return
    const error = moveNode(moveTarget.id, parentId)
    setMoveTarget(null)
    if (error) {
      showToast(error, 'error')
      return
    }
    showToast('已移动', 'success')
  }

  /** 右键菜单项：按节点类型给可用操作 */
  const menuItemsOf = (node: SopDirectionNode) => {
    const items: Array<{ label: string; danger?: boolean; onSelect: () => void }> = []
    if (node.kind === 'category') {
      items.push({ label: '新建产品', onSelect: () => beginAdd(node.id, 'product') })
    } else if (node.kind === 'product') {
      items.push({ label: '新建方向', onSelect: () => beginAdd(node.id, 'direction') })
      items.push({
        label: '后处理模板',
        onSelect: () => { void openPostTemplate(node) },
      })
    }
    items.push({
      label: '重命名',
      onSelect: () => {
        const next = window.prompt('新的名称', node.name)
        if (next?.trim()) renameNode(node.id, next)
      },
    })
    if (node.kind !== 'category') {
      items.push({ label: '移动到…', onSelect: () => setMoveTarget(node) })
    }
    items.push({ label: '删除', danger: true, onSelect: () => trashNode(node) })
    return items
  }

  // 右键菜单点外面就关
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  if (collapsed) {
    return (
      <aside className="hidden shrink-0 lg:block">
        <div className="sticky top-20">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title={currentPath ? `展开产品-方向（当前归属：${currentPath}）` : '展开产品-方向'}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-800 dark:border-white/10 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </aside>
    )
  }

  /**
   * 行样式分三档，优先级从高到低：
   * - current：当前归属，新生成的图会归到这里 → 蓝色主色 + 左侧竖条
   * - selected：正在筛选这一层 → 中性灰底
   * - onPath：属于当前归属的祖先链 → 淡底，让整条路径连起来
   */
  const rowClass = (state: { current?: boolean; selected?: boolean; onPath?: boolean }) => {
    const base = 'group relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors'
    if (state.current) return `${base} bg-blue-50 font-semibold text-blue-700 dark:bg-blue-500/[0.18] dark:text-blue-200`
    if (state.selected) return `${base} bg-gray-100 font-medium text-gray-900 dark:bg-white/[0.08] dark:text-white`
    if (state.onPath) return `${base} bg-gray-50 font-medium text-gray-800 dark:bg-white/[0.04] dark:text-gray-100`
    return `${base} text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]`
  }

  /** 当前归属左侧的竖条，和文字错开不重叠 */
  const currentBar = <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-blue-500 dark:bg-blue-400" />

  /** 当前归属尾部的小圆点，竖条被遮挡时也能认出来 */
  const currentDot = <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 dark:bg-blue-400" />

  const tailBadge = (text: number) => (
    <span className="shrink-0 text-[11px] tabular-nums text-gray-400">{text}</span>
  )

  /** 产品行的蓝色胶囊：这个产品下存了几条系统提示词，跟右侧的卡片数区分开 */
  const promptBadge = (count: number) => (
    <span
      title={`这个产品下有 ${count} 条系统提示词`}
      className="shrink-0 cursor-default rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] leading-none tabular-nums text-blue-500 dark:bg-blue-500/15 dark:text-blue-300"
    >
      {count}
    </span>
  )

  const renderDirection = (node: SopDirectionNode) => {
    const isCurrent = node.id === activeDirectionId
    return (
      <div key={node.id} className="flex items-center pl-8">
        <button
          type="button"
          data-current={isCurrent || undefined}
          onClick={() => setActiveFilter(node.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY, node })
          }}
          title={isCurrent ? '当前归属：新生成的图会归到这个方向（右键：更多操作）' : '点击设为当前归属并筛选（右键：更多操作）'}
          className={rowClass({ current: isCurrent, selected: activeFilterId === node.id })}
        >
          {isCurrent && currentBar}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {isCurrent && currentDot}
          {counts.get(node.id) ? tailBadge(counts.get(node.id) ?? 0) : <span className="shrink-0 text-[11px] tabular-nums text-gray-300">0</span>}
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            trashNode(node)
          }}
          title="删除方向（可在回收站恢复）"
          className="ml-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-300 hover:bg-red-50 hover:text-red-500 group-hover:flex dark:hover:bg-red-500/10"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    )
  }

  const renderSearchResults = () => (
    <div className="mt-1 space-y-0.5">
      {matches.length === 0 && <p className="px-2 py-3 text-xs text-gray-400">没有匹配的项目</p>}
      {matches.map((node) => {
        const isCurrent = node.id === activeDirectionId
        return (
          <button
            key={node.id}
            type="button"
            data-current={isCurrent || undefined}
            onClick={() => {
              setActiveFilter(node.id)
              setSearch('')
            }}
            title={isCurrent ? '当前归属：新生成的图会归到这个方向' : '点击设为当前归属并筛选'}
            className={rowClass({ current: isCurrent, selected: activeFilterId === node.id })}
          >
            {isCurrent && currentBar}
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-gray-400">{directionPath(directions, node.id).replace(/\/\s*[^/]+$/, '').replace(/\/$/, '')} / </span>
              {node.name}
            </span>
            {isCurrent && currentDot}
            {tailBadge(counts.get(node.id) ?? 0)}
          </button>
        )
      })}
    </div>
  )

  return (
    <aside className="hidden w-56 shrink-0 lg:flex lg:flex-col lg:pb-28 lg:pt-6">
      {/* 外层只负责占满可用高度：搜索、当前归属、全部任务这几块固定，滚动条只管下面的方向树 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0">
          <div className="relative mb-3">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400">
              <circle cx="11" cy="11" r="6.5" />
              <path strokeLinecap="round" d="M16 16l4 4" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="筛选项目、方向…"
              className="w-full rounded-lg bg-gray-100 py-1.5 pl-8 pr-2 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:bg-white/[0.06] dark:text-gray-200 dark:placeholder:text-gray-500 dark:focus:ring-white/20"
            />
          </div>

          {/* 当前归属常驻显示：树折叠或滚走了也能一眼看到现在归到哪 */}
          {currentNode && (
            <button
              type="button"
              onClick={() => setActiveFilter(activeDirectionId)}
              title={`${sopStyleMode ? '当前归属' : '默认归属'}：${currentPath}（点击只看这个方向）`}
              className="mb-2 flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-left transition-colors hover:bg-blue-100 dark:border-blue-500/30 dark:bg-blue-500/[0.14] dark:hover:bg-blue-500/20"
            >
              <span className="flex items-center gap-1 text-[10px] font-medium text-blue-600 dark:text-blue-300">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 dark:bg-blue-400" />
                {sopStyleMode ? '当前归属' : '默认归属'}
              </span>
              <span className="min-w-0 truncate text-[12px] font-semibold text-blue-800 dark:text-blue-100">{currentPath}</span>
            </button>
          )}
        </div>

        {search.trim() ? (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
            {renderSearchResults()}
          </div>
        ) : (
          <>
            <div className="shrink-0">
              <button type="button" onClick={() => setActiveFilter(null)} className={`${rowClass({ selected: activeFilterId === null })} mb-0.5`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0 text-gray-400">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7l8-4 8 4-8 4-8-4zm0 5l8 4 8-4M4 17l8 4 8-4" />
                </svg>
                <span className="min-w-0 flex-1 truncate">全部任务</span>
                {tailBadge(cards.length)}
              </button>

              {unassigned > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveFilter(UNASSIGNED_FILTER)}
                  className={`${rowClass({ selected: activeFilterId === UNASSIGNED_FILTER })} mb-0.5`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0 text-gray-400">
                    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate">未归属</span>
                  {tailBadge(unassigned)}
                </button>
              )}

              <div className="my-2 h-px bg-gray-100 dark:bg-white/[0.06]" />

              <div className="mb-1 flex items-center gap-1.5 px-2">
                <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500">项目</span>
                <span className="rounded-full bg-gray-100 px-1.5 text-[10px] tabular-nums text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
                  {categories.length}
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setTrashOpen(true)}
                  title="回收站：恢复或彻底删除已删的业务线与任务卡"
                  className="flex h-5 w-5 items-center justify-center rounded text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-300"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3">
                    <path strokeLinecap="round" d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => (adding && addingUnder === null ? setAdding(false) : beginAdd(null, 'category'))}
                  title="新建业务线（类目）"
                  className="flex h-5 w-5 items-center justify-center rounded border border-gray-200 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                    <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setCollapsed(true)}
                  title="收起侧栏"
                  className="flex h-5 w-5 items-center justify-center rounded text-gray-300 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-300"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
                  </svg>
                </button>
              </div>
            </div>

            {/* 只有这块滚：分类 / 产品 / 方向树 */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
              {categories.map((category) => {
                const products = childrenOf(category.id)
                const isFolded = folded.has(category.id)
                return (
                  <div key={category.id} className="mb-0.5">
                    <div className="flex items-center">
                      <button type="button" onClick={() => toggle(category.id)} className="flex h-7 w-5 shrink-0 items-center justify-center text-gray-400">
                        <Chevron open={!isFolded} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveFilter(category.id)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setMenu({ x: event.clientX, y: event.clientY, node: category })
                        }}
                        title="右键：新建产品 / 重命名 / 删除"
                        className={rowClass({ selected: activeFilterId === category.id, onPath: currentPathIds.has(category.id) })}
                      >
                        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                        <span className="min-w-0 flex-1 truncate">{category.name}</span>
                        {tailBadge(counts.get(category.id) ?? 0)}
                      </button>
                    </div>

                    {!isFolded && (
                      <div className="ml-[13px] border-l border-gray-100 pl-2 dark:border-white/[0.06]">
                        {products.map((product) => {
                          const productFolded = folded.has(product.id)
                          return (
                            <div key={product.id} className="mb-0.5">
                              <div className="flex items-center">
                                <button type="button" onClick={() => toggle(product.id)} className="flex h-7 w-5 shrink-0 items-center justify-center text-gray-400">
                                  <Chevron open={!productFolded} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setActiveFilter(product.id)}
                                  onContextMenu={(event) => {
                                    event.preventDefault()
                                    setMenu({ x: event.clientX, y: event.clientY, node: product })
                                  }}
                                  title="右键：新建方向 / 后处理模板 / 移动到 / 删除"
                                  className={rowClass({ selected: activeFilterId === product.id, onPath: currentPathIds.has(product.id) })}
                                >
                                  <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                                  {promptCount(product.id) > 0 && promptBadge(promptCount(product.id))}
                                  {tailBadge(counts.get(product.id) ?? 0)}
                                </button>
                              </div>
                              {!productFolded && (
                                <div className="ml-[13px] border-l border-gray-100 pl-2 dark:border-white/[0.06]">
                                  {childrenOf(product.id).map(renderDirection)}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}

              {adding && (
                <div className="mt-2 px-1">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitDraft()
                      if (e.key === 'Escape') {
                        setAdding(false)
                        setAddingUnder(null)
                      }
                    }}
                    onBlur={() => {
                      if (!draft.trim()) {
                        setAdding(false)
                        setAddingUnder(null)
                      }
                    }}
                    placeholder={
                      !addingUnder || addingUnder.parentId === null
                        ? '新建业务线（类目），回车确认'
                        : `在「${directions.find((n) => n.id === addingUnder.parentId)?.name ?? ''}」下新建${
                          addingUnder.kind === 'product' ? '产品' : '方向'
                        }`
                    }
                    className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* 右键菜单：按节点类型给出可做的操作 */}
      {menu && createPortal(
        <div
          className="fixed z-[70] w-40 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-gray-800"
          style={{ left: Math.min(menu.x, window.innerWidth - 172), top: Math.min(menu.y, window.innerHeight - 220) }}
          onClick={(event) => event.stopPropagation()}
        >
          {menu.node && (
            <div className="truncate px-2.5 py-1 text-[10px] text-gray-400">{menu.node.name}</div>
          )}
          {(menu.node ? menuItemsOf(menu.node) : [{ label: '新建业务线', onSelect: () => beginAdd(null, 'category') }]).map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setMenu(null)
                item.onSelect()
              }}
              className={`block w-full px-2.5 py-1.5 text-left text-xs transition-colors ${
                item.danger
                  ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
                  : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-white/[0.06]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}

      {moveTarget && createPortal(
        <MoveNodeModal
          node={moveTarget}
          onClose={() => setMoveTarget(null)}
          onConfirm={submitMove}
        />,
        document.body,
      )}

      {postTarget && createPortal(
        <PostTemplateModal
          productId={postTarget.id}
          productName={postTarget.name}
          previewSrc={postPreview}
          onClose={() => setPostTarget(null)}
        />,
        document.body,
      )}
    </aside>
  )
}
