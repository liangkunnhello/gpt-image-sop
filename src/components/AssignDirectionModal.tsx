import { useMemo, useState } from 'react'

import { useSopStore } from '../lib/sopStore'
import type { SopDirectionNode } from '../types'

interface Props {
  count: number
  onClose: () => void
  onConfirm: (directionId: string | null) => void
}

/** 批量把选中的任务归到某个「产品-方向」下 */
export default function AssignDirectionModal({ count, onClose, onConfirm }: Props) {
  const directions = useSopStore((s) => s.directions)
  const [pickedId, setPickedId] = useState<string | null>(null)

  const rows = useMemo(() => {
    const out: Array<{ node: SopDirectionNode; depth: number }> = []
    const walk = (parentId: string | null, depth: number) => {
      for (const node of directions.filter((item) => item.parentId === parentId)) {
        out.push({ node, depth })
        walk(node.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [directions])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">设置归属</h2>
          <span className="text-[11px] text-gray-400">已选 {count} 个任务</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            取消
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <button
            type="button"
            onClick={() => setPickedId(null)}
            className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition ${
              pickedId === null
                ? 'bg-gray-100 font-medium text-gray-900 dark:bg-white/[0.08] dark:text-gray-100'
                : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'
            }`}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 dark:border-white/20">
              {pickedId === null && <span className="h-2 w-2 rounded-full bg-blue-500" />}
            </span>
            不归属任何方向
          </button>

          {rows.map(({ node, depth }) => (
            <button
              key={node.id}
              type="button"
              onClick={() => setPickedId(node.id)}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] transition ${
                pickedId === node.id
                  ? 'bg-gray-100 font-medium text-gray-900 dark:bg-white/[0.08] dark:text-gray-100'
                  : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.04]'
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-gray-300 dark:border-white/20">
                {pickedId === node.id && <span className="h-2 w-2 rounded-full bg-blue-500" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span className="shrink-0 text-[10px] text-gray-400">
                {node.kind === 'category' ? '类目' : node.kind === 'product' ? '产品' : '方向'}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">可以选类目或产品，筛选时整棵子树都会包含。</span>
          <button
            type="button"
            onClick={() => onConfirm(pickedId)}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
