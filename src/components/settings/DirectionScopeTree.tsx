import { useMemo, useState } from 'react'

import type { SopDirectionNode, TaskRecord } from '../../types'
import {
  ALL_SCOPE,
  buildScopeRows,
  countCardsByNode,
  nodeCheckState,
  scopeNodeIds,
  subtreeCardCounts,
  toggleScopeNode,
  type DirectionScope,
} from '../../lib/directionScope'
import { Checkbox } from '../Checkbox'

interface DirectionScopeTreeProps {
  nodes: SopDirectionNode[]
  tasks: TaskRecord[]
  scope: DirectionScope
  onChange: (scope: DirectionScope) => void
  /** 列表标题右侧的说明，如「共 N 张任务卡」 */
  hint?: string
}

/**
 * 业务 - 产品 - 方向 三级树，按方向勾选要带走哪些任务卡。
 * 导出和导入共用：导出用本地树，导入用备份自带的那棵树。
 */
export default function DirectionScopeTree({ nodes, tasks, scope, onChange, hint }: DirectionScopeTreeProps) {
  const rows = useMemo(() => buildScopeRows(nodes), [nodes])
  const counts = useMemo(() => countCardsByNode(tasks, nodes), [tasks, nodes])
  const subtree = useMemo(() => subtreeCardCounts(nodes, counts), [nodes, counts])
  const [folded, setFolded] = useState<Set<string>>(new Set())

  if (!rows.length) {
    return (
      <div className="rounded-xl bg-black/[0.03] px-3 py-2.5 text-xs text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
        本地还没有业务方向。先在左侧「产品-方向」里建好再选。
      </div>
    )
  }

  const selectedIds = scope.all ? rows.map((row) => row.id) : scope.ids
  const includeUnassigned = scope.all || scope.includeUnassigned

  /** 从「全部」点某个节点，意图是「只要这个」：直接切成单枝，而不是把它排除掉 */
  const toggleNode = (id: string) => {
    if (scope.all) {
      onChange({ all: false, ids: [...scopeNodeIds(nodes, [id])], includeUnassigned: false })
      return
    }
    onChange({ all: false, ids: toggleScopeNode(nodes, scope.ids, id), includeUnassigned })
  }

  /** 取消「未归属」：全选时等于只保留所有节点；否则把它从范围里去掉 */
  const toggleUnassigned = () => {
    if (scope.all) {
      onChange({ all: false, ids: rows.map((row) => row.id), includeUnassigned: false })
      return
    }
    onChange({ ...scope, includeUnassigned: !scope.includeUnassigned })
  }

  /** 取消「全部业务方向」时默认什么都不勾，交给用户自己挑 */
  const toggleAll = (checked: boolean) => {
    onChange(checked ? ALL_SCOPE : { all: false, ids: [], includeUnassigned: false })
  }

  const fold = (id: string) => {
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 折叠节点的后代一律不渲染；按祖先链判断，避免靠缩进猜层级 */
  const visibleRows = (() => {
    const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]))
    const hidden = new Set<string>()
    const result: typeof rows = []
    for (const row of rows) {
      const parentId = parentOf.get(row.id) ?? null
      if (parentId && (hidden.has(parentId) || folded.has(parentId))) {
        hidden.add(row.id)
        continue
      }
      result.push(row)
    }
    return result
  })()

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Checkbox
          checked={scope.all}
          onChange={toggleAll}
          label="全部业务方向"
        />
        {hint && <span className="shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-gray-500">{hint}</span>}
      </div>

      <div className={`max-h-56 overflow-y-auto rounded-xl border border-gray-200 p-1 custom-scrollbar dark:border-white/10 ${scope.all ? 'opacity-60' : ''}`}>
        {visibleRows.map((row) => {
          const state = nodeCheckState(nodes, selectedIds, row.id)
          const count = subtree[row.id] ?? 0
          return (
            <div
              key={row.id}
              className="flex items-center gap-1 rounded-lg pr-2 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              style={{ paddingLeft: 4 + row.depth * 14 }}
            >
              <button
                type="button"
                aria-label={folded.has(row.id) ? '展开' : '折叠'}
                onClick={() => fold(row.id)}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 transition hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ${row.hasChildren ? '' : 'invisible'}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${folded.has(row.id) ? '-rotate-90' : ''}`}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={state === 'all'}
                  ref={(el) => { if (el) el.indeterminate = state === 'some' }}
                  onChange={() => toggleNode(row.id)}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-500"
                />
                <span className={`min-w-0 truncate text-xs ${state === 'none' ? 'text-gray-600 dark:text-gray-300' : 'font-medium text-gray-800 dark:text-gray-100'}`}>
                  {row.name}
                </span>
                <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500">
                  {row.kind === 'category' ? '业务' : row.kind === 'product' ? '产品' : '方向'}
                </span>
                <span className="flex-1" />
                <span className={`shrink-0 text-[11px] tabular-nums ${count ? 'text-gray-500 dark:text-gray-400' : 'text-gray-300 dark:text-gray-600'}`}>{count}</span>
              </label>
            </div>
          )
        })}
        <div className="mt-0.5 flex items-center gap-1 rounded-lg pr-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]" style={{ paddingLeft: 24 }}>
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1">
            <input
              type="checkbox"
              checked={includeUnassigned}
              onChange={toggleUnassigned}
              className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-blue-500"
            />
            <span className="min-w-0 truncate text-xs text-gray-600 dark:text-gray-300">未归属</span>
            <span className="flex-1" />
            <span className={`shrink-0 text-[11px] tabular-nums ${counts.unassigned ? 'text-gray-500 dark:text-gray-400' : 'text-gray-300 dark:text-gray-600'}`}>{counts.unassigned}</span>
          </label>
        </div>
      </div>
    </div>
  )
}
