import { useEffect, useMemo, useState } from 'react'

import { uniqueImportName } from '../lib/libraryImport'
import { SOP_LIBRARY_LABEL, useSopStore } from '../lib/sopStore'
import { useStore } from '../store'

export type LibraryImportKind = 'prompt' | 'variable' | 'sop' | 'point' | 'style'

interface Props {
  /** 导入到哪个产品 */
  targetProductId: string
  targetProductName: string
  /** 打开时默认展开的分组 */
  defaultTab: LibraryImportKind
  onClose: () => void
}

interface Candidate {
  key: string
  kind: LibraryImportKind
  id: string
  name: string
  content: string
}

const KINDS: LibraryImportKind[] = ['prompt', 'variable', 'sop', 'point', 'style']

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
  </svg>
)

/**
 * 从其他产品复制系统提示词 / 卖点 / 风格到当前产品。
 * 只做复制，不改动来源产品的内容。
 */
export default function SopLibraryImportModal({ targetProductId, targetProductName, defaultTab, onClose }: Props) {
  const directions = useSopStore((s) => s.directions)
  const systemPrompts = useSopStore((s) => s.systemPrompts)
  const variablePrompts = useSopStore((s) => s.variablePrompts)
  const savedSops = useSopStore((s) => s.savedSops)
  const presets = useSopStore((s) => s.presets)
  const addSystemPrompt = useSopStore((s) => s.addSystemPrompt)
  const addVariablePrompt = useSopStore((s) => s.addVariablePrompt)
  const addSavedSop = useSopStore((s) => s.addSavedSop)
  const addPreset = useSopStore((s) => s.addPreset)
  const showToast = useStore((s) => s.showToast)

  /** 其他产品 */
  const products = useMemo(
    () => directions.filter((node) => node.kind === 'product' && node.id !== targetProductId),
    [directions, targetProductId],
  )

  const itemsOf = (productId: string): Candidate[] => [
    ...systemPrompts
      .filter((item) => item.productId === productId)
      .map((item) => ({ key: `prompt:${item.id}`, kind: 'prompt' as const, id: item.id, name: item.name, content: item.content })),
    ...variablePrompts
      .filter((item) => item.productId === productId)
      .map((item) => ({ key: `variable:${item.id}`, kind: 'variable' as const, id: item.id, name: item.name, content: item.content })),
    ...savedSops
      .filter((item) => item.productId === productId)
      .map((item) => ({ key: `sop:${item.id}`, kind: 'sop' as const, id: item.id, name: item.name, content: item.content })),
    ...presets
      .filter((item) => item.productId === productId && (item.kind === 'point' || item.kind === 'style'))
      .map((item) => ({ key: `${item.kind}:${item.id}`, kind: item.kind as LibraryImportKind, id: item.id, name: item.name, content: item.content })),
  ]

  const byProduct = useMemo(() => {
    const map = new Map<string, Candidate[]>()
    for (const product of products) map.set(product.id, itemsOf(product.id))
    return map
    // itemsOf 依赖几个 store 数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, systemPrompts, variablePrompts, savedSops, presets])

  const firstWithItems = products.find((product) => (byProduct.get(product.id)?.length ?? 0) > 0)
  const [sourceId, setSourceId] = useState(firstWithItems?.id ?? products[0]?.id ?? '')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<LibraryImportKind | ''>(defaultTab)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // 只关导入弹窗，别把外面的提示词库一起关掉
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const sourceProduct = products.find((product) => product.id === sourceId)
  const candidates = byProduct.get(sourceId) ?? []
  const grouped = KINDS.map((kind) => ({
    kind,
    items: candidates.filter((item) => item.kind === kind),
  }))

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleKind = (kind: LibraryImportKind) => {
    const keys = candidates.filter((item) => item.kind === kind).map((item) => item.key)
    const allSelected = keys.length > 0 && keys.every((key) => selected.has(key))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        if (allSelected) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const selectedCount = selected.size

  const runImport = () => {
    if (!selectedCount) return
    const targetPrompts = new Set(systemPrompts.filter((item) => item.productId === targetProductId).map((item) => item.name))
    const targetVariablePrompts = new Set(variablePrompts.filter((item) => item.productId === targetProductId).map((item) => item.name))
    const targetSops = new Set(savedSops.filter((item) => item.productId === targetProductId).map((item) => item.name))
    const targetPreset = (kind: LibraryImportKind) => new Set(
      presets.filter((item) => item.productId === targetProductId && item.kind === kind).map((item) => item.name),
    )
    const pointNames = targetPreset('point')
    const styleNames = targetPreset('style')

    let imported = 0
    // 按来源产品顺序导入，命中重名时前面导入的也算进「已存在」
    for (const product of products) {
      const list = byProduct.get(product.id) ?? []
      for (const item of list) {
        if (!selected.has(item.key)) continue
        if (item.kind === 'prompt') {
          const name = uniqueImportName(targetPrompts, item.name, product.name)
          addSystemPrompt(targetProductId, name, item.content)
          targetPrompts.add(name)
        } else if (item.kind === 'variable') {
          const name = uniqueImportName(targetVariablePrompts, item.name, product.name)
          addVariablePrompt(targetProductId, name, item.content)
          targetVariablePrompts.add(name)
        } else if (item.kind === 'sop') {
          const name = uniqueImportName(targetSops, item.name, product.name)
          addSavedSop(targetProductId, name, item.content)
          targetSops.add(name)
        } else {
          const names = item.kind === 'point' ? pointNames : styleNames
          const name = uniqueImportName(names, item.name, product.name)
          addPreset(targetProductId, item.kind, name, item.content)
          names.add(name)
        }
        imported += 1
      }
    }
    showToast(`已从其他产品导入 ${imported} 条`, 'success')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[70vh] max-h-[600px] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-gray-800"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.06]">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">从其他产品导入</h2>
            <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">
              复制到「{targetProductName || '当前产品'}」，来源产品不会被改动
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭（Esc）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：来源产品 */}
          <div className="w-48 shrink-0 overflow-y-auto border-r border-gray-100 p-2 dark:border-white/[0.06]">
            {!products.length && <p className="px-2 py-6 text-center text-xs text-gray-400">还没有其他产品</p>}
            {products.map((product) => {
              const list = byProduct.get(product.id) ?? []
              return (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => { setSourceId(product.id); setExpanded(defaultTab) }}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    sourceId === product.id
                      ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-500/[0.18] dark:text-blue-200'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-gray-400">{list.length}</span>
                </button>
              )
            })}
          </div>

          {/* 右：条目 */}
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {!candidates.length && (
              <p className="px-2 py-10 text-center text-xs leading-relaxed text-gray-400">
                这个产品还没有系统提示词、卖点或风格
              </p>
            )}
            {grouped.map(({ kind, items }) => {
              if (!items.length) return null
              const open = expanded === kind
              const allSelected = items.every((item) => selected.has(item.key))
              return (
                <section key={kind} className="mb-2 rounded-lg border border-gray-100 dark:border-white/[0.06]">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? '' : kind)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-medium text-gray-600 dark:text-gray-300"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                      </svg>
                      {SOP_LIBRARY_LABEL[kind]}
                      <span className="text-gray-400">{items.length}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleKind(kind)}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10"
                    >
                      {allSelected ? '取消全选' : '全选'}
                    </button>
                  </div>
                  {open && (
                    <div className="border-t border-gray-100 p-1 dark:border-white/[0.06]">
                      {items.map((item) => (
                        <label
                          key={item.key}
                          className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 transition-colors hover:bg-gray-50 dark:hover:bg-white/[0.04]"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(item.key)}
                            onChange={() => toggle(item.key)}
                            className="mt-0.5 h-3 w-3 accent-blue-500"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-gray-700 dark:text-gray-200">{item.name}</span>
                            <span className="block line-clamp-1 text-[10px] text-gray-400">{item.content || '（空）'}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-gray-100 px-4 py-2.5 dark:border-white/[0.06]">
          <span className="min-w-0 flex-1 truncate text-[11px] text-gray-400">
            已选 {selectedCount} 条{sourceProduct ? `（当前查看：${sourceProduct.name}）` : ''}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:hover:bg-white/10"
          >
            取消
          </button>
          <button
            type="button"
            onClick={runImport}
            disabled={!selectedCount}
            className="rounded-lg bg-blue-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/10"
          >
            {selectedCount ? `导入 ${selectedCount} 条` : '导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
