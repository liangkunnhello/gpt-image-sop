import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SopDirectionNode } from '../types'
import { useStore } from '../store'
import { groupSopTasks } from '../lib/sopGroup'
import { directionPath, useSopStore, UNASSIGNED_FILTER } from '../lib/sopStore'
import { resolveTreeRowHighlight, resolveViewToggleHighlight, type TreeRowHighlight } from '../lib/treeHighlight'
import { effectiveNodeKind, trashNodeWithTasks } from '../lib/directionTree'
import { nearestScopeId } from '../lib/sopScope'
import { taskMatchesChannel } from '../lib/channel'
import { isTaskUnread } from '../lib/unread'
import { generatingNodeIds } from '../lib/generating'
import { clampSidebarWidth, readSidebarWidth, saveSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from '../lib/sidebarWidth'

import type { PostTemplateScope } from '../lib/applyPostTemplate'
import LingjingImportModal from './LingjingImportModal'
import PostTemplateModal from './PostTemplateModal'
import PostTemplateImportModal from './PostTemplateImportModal'
import MoveNodeModal from './MoveNodeModal'
import DeliveryDirModal from './DeliveryDirModal'

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
  const postTemplates = useSopStore((s) => s.postTemplates)
  const setTrashOpen = useSopStore((s) => s.setTrashOpen)
  const tasks = useStore((s) => s.tasks)
  const trashedTasks = useStore((s) => s.trashedTasks)
  /**
   * 左栏宽度可拖：方向名常常很长（「3D插画-京东硬广」这种），固定 224px 一定截断。
   * 存在 localStorage 而不是 store：这是纯界面偏好，没必要进持久化的数据模型。
   */
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth)
  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  /** 按下右边缘：记住起点，指针捕获后即使划出细条也继续跟手 */
  const beginSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidthRef.current }
  }
  const moveSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current
    if (!drag) return
    setSidebarWidth(clampSidebarWidth(drag.startWidth + (event.clientX - drag.startX)))
  }
  const endSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return
    resizeRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    saveSidebarWidth(sidebarWidthRef.current)
  }
  const resetSidebarWidth = () => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    saveSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
  }
  /** 回收站里的条目数：删掉的方向节点 + 任务卡 + 详情页单张回收的图 */
  const trashCount = useMemo(() => {
    let count = 0
    for (const node of directions) {
      if (node.deletedAt) count += 1
    }
    count += trashedTasks.length
    for (const task of tasks) count += task.trashedOutputImages?.length ?? 0
    return count
  }, [directions, tasks, trashedTasks])
  const channelFilter = useStore((s) => s.channelFilter)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)

  const [lingjingOpen, setLingjingOpen] = useState(false)
  const [postTarget, setPostTarget] = useState<{ id: string; name: string; scope: PostTemplateScope } | null>(null)
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  /** 新增下级时的父节点；null 表示新建顶层类目 */
  const [addingUnder, setAddingUnder] = useState<{ parentId: string | null; kind: SopDirectionNode['kind'] } | null>(null)
  /** 右键菜单：位置 + 目标节点 */
  const [menu, setMenu] = useState<{ x: number; y: number; node: SopDirectionNode | null } | null>(null)
  const [moveTarget, setMoveTarget] = useState<SopDirectionNode | null>(null)
  /** 配置交付地址的目标节点：三级都可配 */
  const [deliveryTarget, setDeliveryTarget] = useState<SopDirectionNode | null>(null)
  /** 导入后处理模板的目标节点：产品 / 方向两级可导入 */
  const [importTarget, setImportTarget] = useState<SopDirectionNode | null>(null)
  const deliveryDirs = useSopStore((s) => s.deliveryDirs)
  const moveSibling = useSopStore((s) => s.moveSibling)
  const reorderNode = useSopStore((s) => s.reorderNode)
  /** 拖拽排序的当前拖动项与落点（落点记的是「放到谁的前/后」） */
  const [dragNodeId, setDragNodeId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null)

  // 预览底图由弹窗里自己选（按比例存、默认底色），这里只负责打开。
  // 产品上的是通用模板，方向上的是专属模板 —— 两者各存各的，互不出现在对方的列表里。
  const openPostTemplate = (node: SopDirectionNode, scope: PostTemplateScope) => {
    setPostTarget({ id: node.id, name: node.name, scope })
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

  // 顶层节点就算 kind 写错过也得能显示出来，否则节点在树里「消失」
  const categories = useMemo(() => directions.filter((node) => !node.parentId && !node.deletedAt), [directions])
  const childrenOf = (id: string) => directions.filter((node) => node.parentId === id && !node.deletedAt)
  /**
   * 每层显示「这棵子树里一共配了几条系统提示词」。
   * 提示词可能配在产品上，也可能配在更深一层，父级累加才不会看着像没配。
   */
  const promptCounts = useMemo(() => {
    const alive = new Map(directions.filter((node) => !node.deletedAt).map((node) => [node.id, node]))
    const map = new Map<string, number>()
    for (const prompt of systemPrompts) {
      if (!prompt.productId) continue
      const seen = new Set<string>()
      let cursor = alive.get(prompt.productId)
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id)
        map.set(cursor.id, (map.get(cursor.id) ?? 0) + 1)
        cursor = cursor.parentId ? alive.get(cursor.parentId) : undefined
      }
    }
    return map
  }, [directions, systemPrompts])
  const promptCount = (nodeId: string) => promptCounts.get(nodeId) ?? 0

  // 数量统一按「任务卡」算：SOP 一卡多条提示词也只算一张，跟画廊里看到的卡片数一致
  // 并且跟随渠道筛选：否则选了渠道后，左边数字和右边列表对不上
  const cards = useMemo(
    () => groupSopTasks(tasks.filter((task) => taskMatchesChannel(task, channelFilter))),
    [tasks, channelFilter],
  )

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

  /**
   * 有未读结果的归属节点。红点挂在节点名字右上角，
   * 和卡片右上角的红点同源：点开卡片详情后两边一起消失。
   */
  const unreadNodeIds = useMemo(() => {
    const set = new Set<string>()
    for (const card of cards) {
      if (card.sopDirectionId && isTaskUnread(card)) set.add(card.sopDirectionId)
    }
    return set
  }, [cards])

  /**
   * 有任务正在生成的归属节点（含其祖先）。
   *
   * 用原始 tasks 而不是聚合后的 cards：同一张卡由几十条任务拼成，
   * cards 里留下的是代表任务，它的 status 未必反映「其中有一条在跑」。
   */
  const generatingNodeIdsSet = useMemo(() => {
    const alive = new Map(directions.filter((node) => !node.deletedAt).map((node) => [node.id, node]))
    const ancestorOf = (nodeId: string): string[] => {
      const out: string[] = []
      const seen = new Set<string>()
      let cursor = alive.get(nodeId)
      while (cursor?.parentId && !seen.has(cursor.parentId)) {
        seen.add(cursor.parentId)
        out.push(cursor.parentId)
        cursor = alive.get(cursor.parentId)
      }
      return out
    }
    return generatingNodeIds(
      tasks.filter((task) => taskMatchesChannel(task, channelFilter)),
      ancestorOf,
    )
  }, [tasks, directions, channelFilter])

  /** 收起侧栏时也要提示「有东西在跑」：集合非空即可 */
  const hasGenerating = generatingNodeIdsSet.size > 0

  /**
   * 状态点：未读（红）+ 正在生成（蓝，呼吸）。
   *
   * 两个点各自绝对定位在同一个位置会互相盖住，所以统一由一个容器排：
   * 贴着名字末尾，两个点时并排、一个点时也在这个位置。
   * 颜色要分开 —— 红点是「有新图等你去看」，蓝点是「还在等图出来」，两件事。
   */
  const statusDots = (nodeId: string) => {
    const unread = unreadNodeIds.has(nodeId)
    const generating = generatingNodeIdsSet.has(nodeId)
    if (!unread && !generating) return null
    return (
      // 普通内联元素，跟在名字块后面，与徽章/计数同排：
      // 既不压住名字文字，也不会因为名字太长被挤到裁剪区外
      <span className="flex shrink-0 items-center gap-0.5">
        {unread && (
          <span
            title="这个归属下有未读结果"
            aria-label="有未读结果"
            className="block h-1.5 w-1.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-gray-900"
          />
        )}
        {generating && (
          <span
            title="这个归属下正在生成"
            aria-label="正在生成"
            className="block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500 ring-2 ring-white dark:ring-gray-900"
          />
        )}
      </span>
    )
  }

  /** 同级里还有没有位置可以挪：顶/底那条菜单项就不出现了 */
  const canMoveSibling = (node: SopDirectionNode, step: -1 | 1) => {
    const siblings = directions.filter((item) => item.parentId === node.parentId && !item.deletedAt)
    const at = siblings.findIndex((item) => item.id === node.id)
    return at >= 0 && Boolean(siblings[at + step])
  }

  /**
   * 行的拖拽排序绑定。
   *
   * 只允许同级之间换位置（跨层级是「移动到…」的活，拖错了会把子树挂飞），
   * 落点按鼠标在一行里的上半/下半决定插到前面还是后面。
   */
  const rowDragProps = (node: SopDirectionNode) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.effectAllowed = 'move'
      // Firefox 不 setData 就不会真正开始拖
      event.dataTransfer.setData('text/plain', node.id)
      setDragNodeId(node.id)
    },
    onDragOver: (event: React.DragEvent) => {
      if (!dragNodeId || dragNodeId === node.id) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const rect = event.currentTarget.getBoundingClientRect()
      setDropHint({ id: node.id, after: event.clientY > rect.top + rect.height / 2 })
    },
    onDragLeave: () => {
      setDropHint((prev) => (prev?.id === node.id ? null : prev))
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      if (dragNodeId && dropHint && dragNodeId !== dropHint.id) {
        reorderNode(dragNodeId, dropHint.id, dropHint.after ? 'after' : 'before')
      }
      setDragNodeId(null)
      setDropHint(null)
    },
    onDragEnd: () => {
      setDragNodeId(null)
      setDropHint(null)
    },
  })

  /**
   * 拖拽时的视觉反馈：落点用内阴影画一条线，不改布局（边框会把这行顶高一下）。
   * 被拖的那一行本身压暗，让人知道拖的是哪个。
   */
  const dragClass = (node: SopDirectionNode) => {
    if (dragNodeId === node.id) return 'opacity-45'
    if (dropHint?.id !== node.id) return ''
    return dropHint.after
      ? 'shadow-[inset_0_-2px_0_0_rgb(59,130,246)]'
      : 'shadow-[inset_0_2px_0_0_rgb(59,130,246)]'
  }

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
  const parentProduct = activeNode
    ? directions.find((node) => node.id === nearestScopeId(directions, activeNode.id))
    : undefined

  /** 打开「新建」输入框；不传参时沿用旧行为：在当前产品下建方向 */
  const beginAdd = (parentId: string | null, kind: SopDirectionNode['kind']) => {
    setAddingUnder({ parentId, kind })
    setDraft('')
    setAdding(true)
    // 新建在多层级下，需要先展开父级和它的祖先，否则输入框藏在折叠里
    if (parentId) {
      setFolded((prev) => {
        const next = new Set(prev)
        let cursorId: string | null = parentId
        let guard = 0
        while (cursorId && guard < 10) {
          next.delete(cursorId)
          const current: SopDirectionNode | undefined = directions.find((item) => item.id === cursorId)
          cursorId = current?.parentId ?? null
          guard += 1
        }
        return next.size === prev.size ? prev : next
      })
    }
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

  /**
   * 新建输入框：直接渲染在目标节点下方。
   * 早先统一放在列表最底部，从右键菜单点「新建方向」后输入框在看不见的地方，
   * 用户会以为没有反应 —— 所以这里跟着父节点走。
   */
  const renderAddInput = (parentId: string | null) => {
    const target = addingUnder?.parentId ?? null
    if (!adding || target !== parentId) return null
    const parentName = parentId ? directions.find((node) => node.id === parentId)?.name ?? '' : ''
    const placeholder = !addingUnder || addingUnder.parentId === null
      ? '新建业务线（类目），回车确认'
      : `在「${parentName}」下新建${addingUnder.kind === 'product' ? '产品' : '方向'}`
    return (
      <div className="mt-1 mb-0.5 px-1">
        <input
          key={parentId ?? '__root__'}
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
          onFocus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest' })}
          placeholder={placeholder}
          className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
        />
      </div>
    )
  }

  /** 删除：二次确认 → 节点连子孙 + 归属它的任务卡一起进回收站，可整批恢复 */
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
    const affected = cards.filter((card) => card.sopDirectionId && subs.has(card.sopDirectionId))
    const cardCount = affected.length
    const subCount = subs.size - 1
    setConfirmDialog({
      title: `移入回收站`,
      message: [
        `确定删除「${node.name}」吗？`,
        subCount > 0 ? `它下面的 ${subCount} 个下级节点会一起进回收站。` : '',
        cardCount > 0 ? `归属这些方向的 ${cardCount} 张任务卡也会一起进回收站。` : '',
        '可以在「回收站」里整批恢复，任务卡的归属会原样回来。',
      ].filter(Boolean).join('\n'),
      action: () => {
        void trashNodeWithTasks(node.id).then(({ trashedCards }) => {
          showToast(
            trashedCards > 0
              ? `已移入回收站，连同 ${trashedCards} 张任务卡`
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

  /** 节点在树里的实际身份：按层级算，不信可能写错的 kind 字段（见 effectiveNodeKind） */
  const kindOf = (node: SopDirectionNode) => effectiveNodeKind(directions, node.id)

  /** 右键菜单项：按节点类型给可用操作 */
  const menuItemsOf = (node: SopDirectionNode) => {
    const items: Array<{ label: string; danger?: boolean; onSelect: () => void }> = []
    const kind = kindOf(node)
    if (kind === 'category') {
      items.push({ label: '新建产品', onSelect: () => beginAdd(node.id, 'product') })
    } else if (kind === 'product') {
      items.push({ label: '新建方向', onSelect: () => beginAdd(node.id, 'direction') })
      items.push({
        label: '后处理模板',
        onSelect: () => { openPostTemplate(node, 'product') },
      })
      items.push({
        label: '导入其他模板',
        onSelect: () => { setImportTarget(node) },
      })
    } else if (kind === 'direction') {
      // 方向专属模板：配了之后这个方向就不再套产品模板
      items.push({
        label: '方向专属模板',
        onSelect: () => { openPostTemplate(node, 'direction') },
      })
      items.push({
        label: '导入其他模板',
        onSelect: () => { setImportTarget(node) },
      })
    }
    // 三级都可配交付地址：自己配了只用专属的，没配才向上级复用
    items.push({
      label: deliveryDirs[node.id]?.trim() ? '交付地址（已配置）' : '配置交付地址',
      onSelect: () => setDeliveryTarget(node),
    })
    items.push({
      label: '重命名',
      onSelect: () => {
        const next = window.prompt('新的名称', node.name)
        if (next?.trim()) renameNode(node.id, next)
      },
    })
    if (kind !== 'category') {
      items.push({ label: '移动到…', onSelect: () => setMoveTarget(node) })
    }
    // 排序：同级内上移 / 下移（拖拽也行，这里给个精确的微调方式）
    if (canMoveSibling(node, -1)) {
      items.push({ label: '上移一位', onSelect: () => moveSibling(node.id, -1) })
    }
    if (canMoveSibling(node, 1)) {
      items.push({ label: '下移一位', onSelect: () => moveSibling(node.id, 1) })
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
            title={[
              currentPath ? `展开产品-方向（当前归属：${currentPath}）` : '展开产品-方向',
              // 收起来了也得知道「下面有东西在跑」，否则要展开才发现
              hasGenerating ? '有任务正在生成' : '',
            ].filter(Boolean).join(' · ')}
            className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-800 dark:border-white/10 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
            </svg>
            {hasGenerating && (
              <span
                aria-label="有任务正在生成"
                className="absolute -right-0.5 -top-0.5 block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500 ring-2 ring-white dark:ring-gray-800"
              />
            )}
          </button>
        </div>
      </aside>
    )
  }

  /**
   * 行样式分三档，优先级从高到低：
   * - selected：正在筛选这一行 → 唯一的蓝色实底
   * - current：当前归属，新图归到这里 → 蓝字 + 左侧竖条，不铺底色
   * - onPath：当前归属的祖先链 → 淡灰底，让整条路径连起来
   *
   * 只有一档会用实底。原来 current 也是蓝色实底，和 selected 撞在一起，
   * 导致「全部任务」选中后（activeFilterId 已是 null）归属方向还蓝着，
   * 看着像两个方向同时被选中。
   */
  const rowHighlight = (nodeId: string) => resolveTreeRowHighlight({
    nodeId,
    activeFilterId,
    activeDirectionId,
    currentPathIds,
  })

  const rowClass = (state: TreeRowHighlight) => {
    const base = 'group relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors'
    if (state.selected) return `${base} bg-blue-50 font-semibold text-blue-700 dark:bg-blue-500/[0.18] dark:text-blue-200`
    if (state.current) return `${base} font-semibold text-blue-600 dark:text-blue-300`
    if (state.onPath) return `${base} bg-gray-50 font-medium text-gray-800 dark:bg-white/[0.04] dark:text-gray-100`
    return `${base} text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]`
  }

  /** 当前归属左侧的竖条，和文字错开不重叠 */
  const currentBar = <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-blue-500 dark:bg-blue-400" />

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

  /** 方向行的紫色胶囊：这个方向配了几套专属模板（配了就不再套产品模板） */
  const templateBadge = (count: number, enabled: number) => (
    <span
      title={`方向专属后处理模板 ${count} 套（启用 ${enabled} 套）：这个方向不再套用产品模板`}
      className="shrink-0 cursor-default rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] leading-none text-violet-500 dark:bg-violet-500/15 dark:text-violet-300"
    >
      模板
    </span>
  )

  const renderDirection = (node: SopDirectionNode) => {
    const highlight = rowHighlight(node.id)
    const isCurrent = node.id === activeDirectionId
    const ownTemplates = postTemplates[node.id] ?? []
    return (
      <div key={node.id} className={`group flex items-center pl-8 ${dragClass(node)}`} {...rowDragProps(node)}>
        <button
          type="button"
          // data-current 只做「自动滚动到这里」的锚点，跟视觉高亮无关：
          // 选了全部任务时树不该亮，但归属节点仍然要能被滚到视野里
          data-current={isCurrent || undefined}
          onClick={() => setActiveFilter(node.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY, node })
          }}
          title={isCurrent
            ? '当前归属：新生成的图会归到这个方向（右键：方向专属模板 / 重命名 / 删除）'
            : '点击设为当前归属并筛选（右键：方向专属模板 / 重命名 / 删除）'}
          className={rowClass(highlight)}
        >
          {highlight.current && currentBar}
          <span className="flex min-w-0 flex-1 items-center gap-0.5">
            <span className="relative inline-block min-w-0 max-w-full align-middle">
              <span className="block truncate">{node.name}</span>
            </span>
            {statusDots(node.id)}
          </span>
          {ownTemplates.length > 0 && templateBadge(ownTemplates.length, ownTemplates.filter((item) => item.enabled).length)}
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
        const highlight = rowHighlight(node.id)
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
            className={rowClass(highlight)}
          >
            {highlight.current && currentBar}
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-gray-400">{directionPath(directions, node.id).replace(/\/\s*[^/]+$/, '').replace(/\/$/, '')} / </span>
              {node.name}
            </span>
            {tailBadge(counts.get(node.id) ?? 0)}
          </button>
        )
      })}
    </div>
  )

  return (
    <aside
      className="relative hidden shrink-0 lg:flex lg:flex-col lg:pb-28 lg:pt-6"
      style={{ width: sidebarWidth }}
    >
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

          {/*
            默认归属常驻显示：树折叠或滚走了也能一眼看到现在归到哪。
            用中性卡而不是蓝色实底 —— 蓝色实底会被误读成「这个方向正被选中」，
            点了「全部任务」之后尤其明显。这里只表示新图会归到哪，点击才去筛选它。

            点「全部任务」「未归属」会把归属清空，这时卡片也要在：
            显示「未归属」，否则用户看不到「新图不会挂方向」这件事。
          */}
          <button
            type="button"
            onClick={() => setActiveFilter(currentNode ? activeDirectionId : UNASSIGNED_FILTER)}
            title={currentNode
              ? `${sopStyleMode ? '当前归属' : '默认归属'}：${currentPath}（新生成的图归到这里，点击只看这个方向）`
              : `${sopStyleMode ? '当前归属' : '默认归属'}：未归属（新生成的图不挂方向，点击只看未归属）`}
            className="mb-2 flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-left transition-colors hover:border-gray-300 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:bg-white/[0.07]"
          >
            <span className="flex items-center gap-1 text-[10px] font-medium text-gray-500 dark:text-gray-400">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${currentNode ? 'bg-blue-500 dark:bg-blue-400' : 'bg-gray-300 dark:bg-gray-600'}`} />
              {sopStyleMode ? '当前归属' : '默认归属'}
              <span className="font-normal text-gray-400 dark:text-gray-500">
                {currentNode ? '· 新图归到这里' : '· 新图不挂方向'}
              </span>
            </span>
            <span className={`min-w-0 truncate text-[12px] font-semibold ${currentNode ? 'text-gray-700 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'}`}>
              {currentNode ? currentPath : '未归属'}
            </span>
          </button>
        </div>

        {search.trim() ? (
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-1">
            {renderSearchResults()}
          </div>
        ) : (
          <>
            <div className="shrink-0">
              {/*
                「全部任务」「未归属」是最外层的两个视图开关，不是树节点。
                选中态用主色描边 + 加粗，和树里「正在筛选这一行」（灰底）区分开，
                这样点完全部任务，能明确看出「现在什么都没筛」。
              */}
              <button
                type="button"
                onClick={() => setActiveFilter(null)}
                className={`${rowClass(resolveViewToggleHighlight(activeFilterId === null))} mb-0.5 ${activeFilterId === null ? 'ring-1 ring-inset ring-blue-300 dark:ring-blue-400/40' : ''}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={`h-4 w-4 shrink-0 ${activeFilterId === null ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400'}`}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7l8-4 8 4-8 4-8-4zm0 5l8 4 8-4M4 17l8 4 8-4" />
                </svg>
                <span className={`min-w-0 flex-1 truncate ${activeFilterId === null ? 'font-semibold text-blue-600 dark:text-blue-300' : ''}`}>全部任务</span>
                {tailBadge(cards.length)}
              </button>

              {unassigned > 0 && (
                <button
                  type="button"
                  onClick={() => setActiveFilter(UNASSIGNED_FILTER)}
                  className={`${rowClass(resolveViewToggleHighlight(activeFilterId === UNASSIGNED_FILTER))} mb-0.5 ${activeFilterId === UNASSIGNED_FILTER ? 'ring-1 ring-inset ring-blue-300 dark:ring-blue-400/40' : ''}`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={`h-4 w-4 shrink-0 ${activeFilterId === UNASSIGNED_FILTER ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400'}`}>
                    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
                  </svg>
                  <span className={`min-w-0 flex-1 truncate ${activeFilterId === UNASSIGNED_FILTER ? 'font-semibold text-blue-600 dark:text-blue-300' : ''}`}>未归属</span>
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
                  onClick={() => setLingjingOpen(true)}
                  title="从灵境导入：分组/产品/方向 + 水印转后处理模板"
                  className="flex h-5 w-5 items-center justify-center rounded text-gray-300 transition-colors hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-500/10 dark:hover:text-blue-400"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v10m0 0l-3.5-3.5M12 13l3.5-3.5M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setTrashOpen(true)}
                  title={trashCount > 0
                    ? `回收站（${trashCount} 项）：恢复或彻底删除已删的业务线、任务卡与单张图片`
                    : '回收站：恢复或彻底删除已删的业务线与任务卡'}
                  className="relative flex h-5 w-5 items-center justify-center rounded text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-300"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={`h-3 w-3 ${trashCount > 0 ? 'text-red-400' : ''}`}>
                    <path strokeLinecap="round" d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                  </svg>
                  {trashCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                  )}
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
                    <div className={`group flex items-center ${dragClass(category)}`} {...rowDragProps(category)}>
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
                        className={rowClass(rowHighlight(category.id))}
                      >
                        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                        {/*
                          名字和状态点必须是 flex 的兄弟：
                          早先把点塞进名字那个 inline-block 里，而名字是 block 占满整行，
                          点只能掉到第二行、贴着文字左边缘，看着就像「点歪了」。
                        */}
                        <span className="flex min-w-0 flex-1 items-center gap-0.5">
                          <span className="relative inline-block min-w-0 max-w-full align-middle">
                            <span className="block truncate">{category.name}</span>
                          </span>
                          {statusDots(category.id)}
                        </span>
                        {tailBadge(counts.get(category.id) ?? 0)}
                      </button>
                      {/* 悬停直接给个「加产品」，不用记着去右键 */}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          beginAdd(category.id, 'product')
                        }}
                        title="在这个业务线下新建产品"
                        className="ml-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-300 hover:bg-gray-100 hover:text-gray-700 group-hover:flex dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                          <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                        </svg>
                      </button>
                    </div>

                    {!isFolded && (
                      <div className="ml-[13px] border-l border-gray-100 pl-2 dark:border-white/[0.06]">
                        {products.map((product) => {
                          const productFolded = folded.has(product.id)
                          return (
                            <div key={product.id} className="mb-0.5">
                              <div className={`group flex items-center ${dragClass(product)}`} {...rowDragProps(product)}>
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
                                  className={rowClass(rowHighlight(product.id))}
                                >
                                  <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                  {/* 同业务线：点要和名字同排，不能塞进名字块里 */}
                                  <span className="flex min-w-0 flex-1 items-center gap-0.5">
                                    <span className="relative inline-block min-w-0 max-w-full align-middle">
                                      <span className="block truncate">{product.name}</span>
                                    </span>
                                    {statusDots(product.id)}
                                  </span>
                                  {promptCount(product.id) > 0 && promptBadge(promptCount(product.id))}
                                  {tailBadge(counts.get(product.id) ?? 0)}
                                </button>
                                {/* 悬停直接给个「加方向」，不用记着去右键 */}
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    beginAdd(product.id, 'direction')
                                  }}
                                  title="在这个产品下新建方向"
                                  className="ml-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-300 hover:bg-gray-100 hover:text-gray-700 group-hover:flex dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
                                    <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                                  </svg>
                                </button>
                              </div>
                              {!productFolded && (
                                <div className="ml-[13px] border-l border-gray-100 pl-2 dark:border-white/[0.06]">
                                  {childrenOf(product.id).map(renderDirection)}
                                  {renderAddInput(product.id)}
                                </div>
                              )}
                            </div>
                          )
                        })}
                        {renderAddInput(category.id)}
                      </div>
                    )}
                  </div>
                )
              })}

              {renderAddInput(null)}
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
          ownerId={postTarget.id}
          ownerName={postTarget.name}
          scope={postTarget.scope}
          onClose={() => setPostTarget(null)}
        />,
        document.body,
      )}

      {importTarget && createPortal(
        <PostTemplateImportModal
          ownerId={importTarget.id}
          ownerName={importTarget.name}
          onClose={() => setImportTarget(null)}
        />,
        document.body,
      )}

      {deliveryTarget && createPortal(
        <DeliveryDirModal
          node={deliveryTarget}
          onClose={() => setDeliveryTarget(null)}
        />,
        document.body,
      )}

      {lingjingOpen && createPortal(
        <LingjingImportModal onClose={() => setLingjingOpen(false)} />,
        document.body,
      )}

      {/*
        拖拽条压在右边缘：方向名太长时往右拖就能看全。
        双击回到默认宽度 —— 拖歪了不用去翻设置。
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整左栏宽度，双击恢复默认"
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={beginSidebarResize}
        onPointerMove={moveSidebarResize}
        onPointerUp={endSidebarResize}
        onPointerCancel={endSidebarResize}
        onDoubleClick={resetSidebarWidth}
        className="absolute right-0 top-0 z-10 hidden h-full w-1.5 cursor-col-resize touch-none transition-colors hover:bg-blue-400/50 active:bg-blue-500/60 lg:block"
      />
    </aside>
  )
}
