import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SopDirectionNode } from '../types'
import { useStore } from '../store'
import { directionPath, useSopStore, UNASSIGNED_FILTER } from '../lib/sopStore'
import { ensureImageCached } from '../lib/imageCache'
import PostTemplateModal from './PostTemplateModal'

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
  const collapsed = useSopStore((s) => s.sidebarCollapsed)
  const setCollapsed = useSopStore((s) => s.setSidebarCollapsed)
  const addNode = useSopStore((s) => s.addNode)
  const removeNode = useSopStore((s) => s.removeNode)
  const tasks = useStore((s) => s.tasks)

  const [postTarget, setPostTarget] = useState<{ id: string; name: string } | null>(null)
  const [postPreview, setPostPreview] = useState('')
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

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

  const categories = useMemo(() => directions.filter((node) => node.kind === 'category'), [directions])
  const childrenOf = (id: string) => directions.filter((node) => node.parentId === id)
  const promptCount = (productId: string) => systemPrompts.filter((item) => item.productId === productId).length

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const task of tasks) {
      const directionId = task.sopDirectionId
      if (!directionId) continue
      let cursor = directions.find((node) => node.id === directionId)
      while (cursor) {
        map.set(cursor.id, (map.get(cursor.id) ?? 0) + 1)
        const parentId = cursor.parentId
        cursor = parentId ? directions.find((node) => node.id === parentId) : undefined
      }
    }
    return map
  }, [tasks, directions])

  const unassigned = useMemo(() => tasks.filter((task) => !task.sopDirectionId).length, [tasks])
  const matches = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return []
    return directions.filter((node) => node.kind !== 'category' && node.name.toLowerCase().includes(keyword))
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
  const parentProduct = activeNode?.kind === 'direction'
    ? directions.find((node) => node.id === activeNode.parentId)
    : activeNode

  const submitDraft = () => {
    const name = draft.trim()
    if (!name) return
    addNode(parentProduct?.id ?? categories[0]?.id ?? null, name, 'direction')
    setDraft('')
  }

  if (collapsed) {
    return (
      <aside className="hidden shrink-0 lg:block">
        <div className="sticky top-20">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title="展开产品-方向"
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

  const rowClass = (selected: boolean) =>
    `group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${
      selected
        ? 'bg-gray-100 font-medium text-gray-900 dark:bg-white/[0.08] dark:text-white'
        : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'
    }`

  const tailBadge = (text: number, tone: 'muted' | 'accent' = 'muted') => (
    <span className={`shrink-0 text-[11px] tabular-nums ${tone === 'accent' ? 'text-blue-500' : 'text-gray-400'}`}>{text}</span>
  )

  const renderDirection = (node: SopDirectionNode) => (
    <div key={node.id} className="flex items-center pl-8">
      <button type="button" onClick={() => setActiveFilter(node.id)} className={rowClass(activeFilterId === node.id)}>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {counts.get(node.id) ? tailBadge(counts.get(node.id) ?? 0) : <span className="shrink-0 text-[11px] tabular-nums text-gray-300">0</span>}
      </button>
      <button
        type="button"
        onClick={() => removeNode(node.id)}
        title="删除方向"
        className="ml-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-gray-300 hover:bg-red-50 hover:text-red-500 group-hover:flex dark:hover:bg-red-500/10"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
          <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )

  const renderSearchResults = () => (
    <div className="mt-1 space-y-0.5">
      {matches.length === 0 && <p className="px-2 py-3 text-xs text-gray-400">没有匹配的项目</p>}
      {matches.map((node) => (
        <button
          key={node.id}
          type="button"
          onClick={() => {
            setActiveFilter(node.id)
            setSearch('')
          }}
          className={rowClass(activeFilterId === node.id)}
        >
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-gray-400">{directionPath(directions, node.id).replace(/\/\s*[^/]+$/, '').replace(/\/$/, '')} / </span>
            {node.name}
          </span>
          {tailBadge(counts.get(node.id) ?? 0)}
        </button>
      ))}
    </div>
  )

  return (
    <aside className="hidden w-56 shrink-0 lg:block">
      <div className="sticky top-20 max-h-[calc(100vh-11rem)] overflow-auto pr-1">
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

        {search.trim() ? renderSearchResults() : (
          <>
            <button type="button" onClick={() => setActiveFilter(null)} className={`${rowClass(activeFilterId === null)} mb-0.5`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0 text-gray-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 7l8-4 8 4-8 4-8-4zm0 5l8 4 8-4M4 17l8 4 8-4" />
              </svg>
              <span className="min-w-0 flex-1 truncate">全部任务</span>
              {tailBadge(tasks.length)}
            </button>

            {unassigned > 0 && (
              <button
                type="button"
                onClick={() => setActiveFilter(UNASSIGNED_FILTER)}
                className={`${rowClass(activeFilterId === UNASSIGNED_FILTER)} mb-0.5`}
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
                onClick={() => setAdding((v) => !v)}
                title="新建方向"
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

            {categories.map((category) => {
              const products = childrenOf(category.id)
              const isFolded = folded.has(category.id)
              return (
                <div key={category.id} className="mb-0.5">
                  <div className="flex items-center">
                    <button type="button" onClick={() => toggle(category.id)} className="flex h-7 w-5 shrink-0 items-center justify-center text-gray-400">
                      <Chevron open={!isFolded} />
                    </button>
                    <button type="button" onClick={() => setActiveFilter(category.id)} className={rowClass(activeFilterId === category.id)}>
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
                                  void openPostTemplate(product)
                                }}
                                title="右键：后处理模板"
                                className={rowClass(activeFilterId === product.id)}
                              >
                                <FolderIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                <span className="min-w-0 flex-1 truncate">{product.name}</span>
                                {promptCount(product.id) > 0 && tailBadge(promptCount(product.id), 'accent')}
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
                    if (e.key === 'Enter') {
                      submitDraft()
                      setAdding(false)
                    }
                    if (e.key === 'Escape') setAdding(false)
                  }}
                  onBlur={() => {
                    if (!draft.trim()) setAdding(false)
                  }}
                  placeholder={parentProduct ? `在「${parentProduct.name}」下新建` : '新建方向'}
                  className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                />
              </div>
            )}
          </>
        )}
      </div>

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
