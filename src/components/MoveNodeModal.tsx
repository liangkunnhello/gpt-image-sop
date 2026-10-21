import { useMemo, useState } from 'react'
import type { SopDirectionNode } from '../types'
import { useSopStore } from '../lib/sopStore'
import { directionPath } from '../lib/sopStore'

interface Props {
  /** 要移动的节点 */
  node: SopDirectionNode
  onClose: () => void
  onConfirm: (parentId: string | null) => void
}

const KIND_LABEL: Record<SopDirectionNode['kind'], string> = {
  category: '类目',
  product: '产品',
  direction: '方向',
}

/**
 * 移动节点：选一个新的父级。
 *
 * 严格三级结构下，合法目标是由节点类型决定的：
 * - 类目 → 只能顶层（不列出任何父级）
 * - 产品 → 只能挂类目
 * - 方向 → 只能挂产品
 * 所以候选列表直接按规则过滤，不给用户选出会被拒绝的选项。
 */
export default function MoveNodeModal({ node, onClose, onConfirm }: Props) {
  const directions = useSopStore((s) => s.directions)

  /** 该节点自身 + 全部子孙：都不能当自己的父级 */
  const forbidden = useMemo(() => {
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
  }, [directions, node.id])

  const candidates = useMemo(() => {
    if (node.kind === 'category') return []
    const wantKind: SopDirectionNode['kind'] = node.kind === 'product' ? 'category' : 'product'
    return directions
      .filter((item) => !item.deletedAt && item.kind === wantKind && !forbidden.has(item.id))
      .sort((a, b) => directionPath(directions, a.id).localeCompare(directionPath(directions, b.id), 'zh'))
  }, [directions, node.kind, forbidden])

  const [pickedId, setPickedId] = useState<string | null>(
    candidates.some((item) => item.id === node.parentId) ? node.parentId : null,
  )

  const canMove = node.kind === 'category' ? node.parentId !== null : Boolean(pickedId)

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">移动到</h2>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            {KIND_LABEL[node.kind]}：{node.name}
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            取消
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {node.kind === 'category' ? (
            <p className="px-3 py-8 text-center text-xs leading-relaxed text-gray-400">
              类目在最顶层，没有可移动的上级。
              <br />
              需要调整顺序时请改名或删除重建。
            </p>
          ) : !candidates.length ? (
            <p className="px-3 py-8 text-center text-xs leading-relaxed text-gray-400">
              没有可用的目标。
              <br />
              {node.kind === 'product' ? '需要先建一个类目。' : '需要先在该类目下建一个产品。'}
            </p>
          ) : (
            candidates.map((item) => {
              const active = pickedId === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setPickedId(item.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition ${
                    active
                      ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-500/[0.18] dark:text-blue-200'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    active ? 'border-blue-500' : 'border-gray-300 dark:border-white/20'
                  }`}>
                    {active && <span className="h-2 w-2 rounded-full bg-blue-500" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={directionPath(directions, item.id)}>
                    {directionPath(directions, item.id)}
                  </span>
                  <span className="shrink-0 text-[10px] text-gray-400">{KIND_LABEL[item.kind]}</span>
                </button>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">
            {node.kind === 'direction' ? '方向只能放在产品下' : node.kind === 'product' ? '产品只能放在类目下' : '类目在最顶层'}
          </span>
          <button
            type="button"
            disabled={!canMove}
            onClick={() => onConfirm(node.kind === 'category' ? null : pickedId)}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/10"
          >
            移动
          </button>
        </div>
      </div>
    </div>
  )
}
