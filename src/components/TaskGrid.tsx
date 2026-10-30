import { useMemo, useRef, useState, useEffect } from 'react'
import { useStore, countResumableTasks, resumeInterruptedTasks, reuseConfig, editOutputs, removeTask, taskMatchesFilterStatus, taskMatchesSearchQuery, trashTask } from '../store'
import { taskMatchesChannel } from '../lib/channel'
import { ALL_FAVORITES_COLLECTION_ID, getTaskFavoriteCollectionIds } from '../lib/favoriteState'
import { isTauri } from '../lib/platform'
import { getIndexesInRect } from '../lib/virtualGrid'
import { scrollOffsetInRoot, scrollRootBy, scrollRootOf, scrollRootRect } from '../lib/scrollRoot'
import { groupSopTasks } from '../lib/sopGroup'
import { collectSubtreeIds, UNASSIGNED_FILTER, useSopStore } from '../lib/sopStore'
import { useVirtualGrid } from '../hooks/useVirtualGrid'
import TaskCard from './TaskCard'
import { useClipStore } from '../lib/clipSimilarity'
import { useInspectConfig } from '../lib/inspectConfig'

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const defaultFavoriteCollectionId = useStore((s) => s.defaultFavoriteCollectionId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [selectionBox, setSelectionBox] = useState<{ startPageX: number; startPageY: number; currentPageX: number; currentPageY: number } | null>(null)
  /**
   * 断点继续：中断 / 软件被意外关掉之后，列表顶部给一条「接着跑完」的入口。
   * 按全量任务算（不受筛选影响），否则筛到「已完成」就看不到入口了。
   */
  const resumableCount = useStore((s) => countResumableTasks(s.tasks))
  /** 用户点了「忽略」就把当时那批记下来，本次会话不再反复提醒 */
  const [dismissedResumeKey, setDismissedResumeKey] = useState('')
  const resumableKey = useStore((s) => s.tasks.filter((task) => task.status === 'error' && !task.outputImages?.length).map((task) => task.id).join(','))
  const showResumeBar = resumableCount > 0 && dismissedResumeKey !== resumableKey
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const isDragging = useRef(false)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const dragScrollDirectionRef = useRef<-1 | 1 | null>(null)
  const lastToastTimeRef = useRef(0)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const activeFilterId = useSopStore((s) => s.activeFilterId)
  const channelFilter = useStore((s) => s.channelFilter)
  const sopDirections = useSopStore((s) => s.directions)
  const directionFilter = useMemo(
    () => (activeFilterId && activeFilterId !== UNASSIGNED_FILTER ? collectSubtreeIds(sopDirections, activeFilterId) : null),
    [activeFilterId, sopDirections],
  )

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      // 渠道与业务树是两个独立维度，同时生效（取交集）
      if (!taskMatchesChannel(t, channelFilter)) return false
      if (activeFilterId === UNASSIGNED_FILTER) {
        if (t.sopDirectionId) return false
      } else if (directionFilter) {
        if (!t.sopDirectionId || !directionFilter.has(t.sopDirectionId)) return false
      }
      if (filterFavorite) {
        if (!t.isFavorite) return false
        if (activeFavoriteCollectionId && activeFavoriteCollectionId !== ALL_FAVORITES_COLLECTION_ID && !getTaskFavoriteCollectionIds(t, defaultFavoriteCollectionId).includes(activeFavoriteCollectionId)) return false
      }
      if (!taskMatchesFilterStatus(t, filterStatus)) return false
      return taskMatchesSearchQuery(t, q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId, defaultFavoriteCollectionId, directionFilter, activeFilterId, channelFilter])
  // 同一份 SOP 生成的多个任务合并成一张卡，其余任务原样展示
  const displayTasks = useMemo(() => groupSopTasks(filteredTasks), [filteredTasks])

  // 后台算一次当前视图的 CLIP 重复度，算完各自卡片会显示平均重复度。
  // 口径（卡内 / 同方向）由设置决定：卡内就按卡分组，方向就把整个方向放一起比
  const ensureClip = useClipStore((s) => s.ensure)
  const duplicateScope = useInspectConfig((s) => s.config.duplicateScope)
  useEffect(() => {
    if (!filteredTasks.length) return
    ensureClip(filteredTasks, duplicateScope)
  }, [ensureClip, filteredTasks, duplicateScope])
  // 框选的事件处理只在挂载时注册，通过 ref 读取最新列表
  const filteredTasksRef = useRef(displayTasks)
  filteredTasksRef.current = displayTasks
  const { startIndex, endIndex, paddingTop, paddingBottom, metricsRef } = useVirtualGrid(gridRef, displayTasks.length)

  const handleDelete = (task: typeof tasks[0]) => {
    setConfirmDialog({
      title: '移入回收站',
      message: '确定要删除这个任务吗？会先放进回收站，可以在「回收站」里恢复，清空回收站才真正删除图片。',
      action: () => trashTask(task),
    })
  }

  // 框选用「内容坐标」：画廊模式的滚动量来自任务卡容器，Agent 模式来自整页
  const scrollOffset = () => scrollOffsetInRoot(scrollRootOf(gridRef.current))

  const getPagePoint = (clientX: number, clientY: number) => {
    const offset = scrollOffset()
    return { pageX: clientX + offset.x, pageY: clientY + offset.y }
  }

  // 框选遮罩是 fixed，绘制时要把内容坐标减回视口坐标
  const contentScroll = scrollOffset()

  const beginSelection = (target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    const point = getPagePoint(clientX, clientY)

    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = point
    lastClientPoint.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startPageX: point.pageX,
      startPageY: point.pageY,
      currentPageX: point.pageX,
      currentPageY: point.pageY,
    })
  }

  const updateSelectionFromPoint = (pageX: number, pageY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.pageX, pageX)
    const maxX = Math.max(start.pageX, pageX)
    const minY = Math.min(start.pageY, pageY)
    const maxY = Math.max(start.pageY, pageY)

    // 虚拟列表只渲染了部分卡片，按布局计算框选范围内的全部卡片
    const list = filteredTasksRef.current
    const gridRect = gridRef.current.getBoundingClientRect()
    const offset = scrollOffset()
    const gridLeft = gridRect.left + offset.x
    const gridTop = gridRect.top + offset.y
    const hit = new Set(getIndexesInRect(list.length, metricsRef.current, {
      left: minX - gridLeft,
      right: maxX - gridLeft,
      top: minY - gridTop,
      bottom: maxY - gridTop,
    }))
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    list.forEach((task, idx) => {
      const taskId = task.id
      if (hit.has(idx)) {
        if (initialSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
      } else if (!initialSelected.has(taskId)) {
        newSelected.delete(taskId)
      }
    })

    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    const stopDragScroll = () => {
      if (dragScrollIntervalRef.current) {
        clearInterval(dragScrollIntervalRef.current)
        dragScrollIntervalRef.current = null
      }
      dragScrollDirectionRef.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return
      stopDragScroll()
      dragScrollDirectionRef.current = direction
      dragScrollIntervalRef.current = window.setInterval(() => {
        // 画廊模式滚任务卡容器，Agent 模式滚整页
        scrollRootBy(scrollRootOf(gridRef.current), direction * 15)
      }, 16)
    }

    const endSelection = (clearEmptySurfaceClick = false, suppressClick = false) => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && clearEmptySurfaceClick && !hasDragged.current && !startedOnCard.current && !startedWithCtrl.current) {
        clearSelection()
      }
      if (isDragging.current && suppressClick && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      stopDragScroll()
      isDragging.current = false
      dragStart.current = null
      lastClientPoint.current = null
      setSelectionBox(null)
    }

    const getEventElement = (e: MouseEvent) => {
      if (e.target instanceof Element) return e.target
      return document.elementFromPoint(e.clientX, e.clientY)
    }

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target as HTMLElement, e.clientX, e.clientY, isCtrl)
      e.preventDefault()
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
      e.preventDefault()

      // 拖到滚动容器上下边缘时自动滚
      const scrollThreshold = 40
      const rootRect = scrollRootRect(scrollRootOf(gridRef.current))
      if (e.clientY < rootRect.top + scrollThreshold) {
        startDragScroll(-1)
      } else if (e.clientY > rootRect.bottom - scrollThreshold) {
        startDragScroll(1)
      } else {
        stopDragScroll()
      }
    }

    const handleDocumentScroll = () => {
      if (!isDragging.current || !dragStart.current || !lastClientPoint.current || !hasDragged.current) return

      const point = getPagePoint(lastClientPoint.current.x, lastClientPoint.current.y)
      const start = dragStart.current
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const handleDocumentWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return

      e.preventDefault()
      const now = Date.now()
      if (now - lastToastTimeRef.current > 3000) {
        lastToastTimeRef.current = now
        const keyName = isMac ? '⌘' : 'Ctrl'
        useStore.getState().showToast(`松开 ${keyName} 键使用滚轮，或拖至边缘自动滚动`, 'info')
      }
    }

    const handleDocumentMouseUp = () => {
      endSelection(true, true)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    document.addEventListener('mousemove', handleDocumentMouseMove, true)
    document.addEventListener('mouseup', handleDocumentMouseUp, true)
    document.addEventListener('wheel', handleDocumentWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleDocumentScroll, true)
    return () => {
      stopDragScroll()
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
      document.removeEventListener('mousemove', handleDocumentMouseMove, true)
      document.removeEventListener('mouseup', handleDocumentMouseUp, true)
      document.removeEventListener('wheel', handleDocumentWheel, true)
      window.removeEventListener('scroll', handleDocumentScroll, true)
    }
  }, [clearSelection, isMac])

  if (!displayTasks.length) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {searchQuery || filterFavorite ? (
          <p className="text-sm">没有找到匹配的任务</p>
        ) : (
          <>
            <svg
              className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-sm">输入提示词开始生成图片</p>
            {isTauri && !tasks.length && (
              <p className="mt-3 text-xs">
                从网页版迁移：在网页版的「设置 → 数据管理」中导出备份，再
                <button
                  type="button"
                  onClick={() => setShowSettings(true, 'data')}
                  className="mx-0.5 text-blue-500 hover:text-blue-600 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                >
                  在这里导入
                </button>
              </p>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div 
      ref={rootRef}
      data-task-grid-root
      className="relative min-h-[50vh] pb-10"
    >
      {/* 断点继续：中断 / 软件被关掉后没跑完的那批，一条也不用自己找 */}
      {showResumeBar && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l2.5 2.5M3.05 11a9 9 0 1118 0 9 9 0 01-18 0z" />
          </svg>
          <span className="min-w-0 flex-1">
            有 {resumableCount} 个任务没跑完（中途停止，或软件被关掉），可以接着跑
          </span>
          <button
            type="button"
            onClick={() => { void resumeInterruptedTasks() }}
            className="shrink-0 rounded-lg bg-amber-500 px-2.5 py-1 font-medium text-white transition-colors hover:bg-amber-600"
          >
            继续
          </button>
          <button
            type="button"
            onClick={() => setDismissedResumeKey(resumableKey)}
            className="shrink-0 rounded-lg px-2 py-1 text-amber-700/80 transition-colors hover:bg-amber-100 dark:text-amber-300/80 dark:hover:bg-white/[0.06]"
          >
            忽略
          </button>
        </div>
      )}
      <div ref={gridRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" style={{ paddingTop, paddingBottom }}>
        {displayTasks.slice(startIndex, endIndex).map((task) => (
          <div key={task.id} className="task-card-wrapper" data-task-id={task.id}>
            <TaskCard
              task={task}
              onClick={(e) => {
                if (Date.now() < suppressClickUntil.current) {
                  e.preventDefault()
                  return
                }
                suppressClickUntil.current = 0
                const isCtrl = isMac ? e.metaKey : e.ctrlKey
                if (isCtrl) {
                  useStore.getState().toggleTaskSelection(task.id)
                  return
                }

                setDetailTaskId(task.id)
              }}
              onReuse={() => reuseConfig(task)}
              onEditOutputs={() => editOutputs(task)}
              onDelete={() => handleDelete(task)}
              isSelected={selectedTaskIds.includes(task.id)}
            />
          </div>
        ))}
      </div>
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[30]"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - contentScroll.x,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - contentScroll.y,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
    </div>
  )
}
