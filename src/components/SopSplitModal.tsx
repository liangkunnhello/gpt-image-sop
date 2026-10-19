import { useMemo, useState } from 'react'
import { useSopStore } from '../lib/sopStore'
import { splitEven } from '../lib/sopPipeline'

export interface SopRunOptions {
  directionId: string
  systemPromptText: string
  groupCount: number
  promptsPerGroup: number
}

interface Props {
  imageCount: number
  onClose: () => void
  onConfirm: (options: SopRunOptions) => void
}

type SplitMode = 'one' | 'perImage' | 'custom'

export default function SopSplitModal({ imageCount, onClose, onConfirm }: Props) {
  const directions = useSopStore((s) => s.directions)
  const systemPrompts = useSopStore((s) => s.systemPrompts)
  const addSystemPrompt = useSopStore((s) => s.addSystemPrompt)
  const updateSystemPrompt = useSopStore((s) => s.updateSystemPrompt)

  const products = useMemo(() => directions.filter((node) => node.kind !== 'direction'), [directions])
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const activeNode = directions.find((node) => node.id === activeDirectionId)
  const [productId, setProductId] = useState(
    (activeNode?.kind === 'direction' ? activeNode.parentId : activeNode?.id) || products[0]?.id || '',
  )
  const productChildren = useMemo(
    () => directions.filter((node) => node.parentId === productId),
    [directions, productId],
  )
  const [directionId, setDirectionId] = useState(activeNode?.kind === 'direction' ? activeNode.id : '')
  const currentDirectionId = productChildren.some((n) => n.id === directionId)
    ? directionId
    : productChildren.find((n) => n.kind === 'direction')?.id || ''

  const options = useMemo(
    () => systemPrompts.filter((item) => item.directionId === currentDirectionId),
    [systemPrompts, currentDirectionId],
  )
  const [promptId, setPromptId] = useState('')
  const [draft, setDraft] = useState('')
  const selectedPrompt = options.find((item) => item.id === promptId) || options[0]
  const systemPromptText = draft || selectedPrompt?.content || ''

  const [mode, setMode] = useState<SplitMode>('one')
  const [customCount, setCustomCount] = useState(String(Math.max(1, Math.min(4, imageCount))))
  const [perGroup, setPerGroup] = useState('5')

  const groupCount = mode === 'one'
    ? 1
    : mode === 'perImage'
      ? imageCount
      : Math.max(1, Math.min(Number(customCount) || 1, imageCount))

  const preview = splitEven(Array.from({ length: imageCount }, (_, i) => i + 1), groupCount)
    .map((group) => group.length)
    .join(' / ')

  const canRun = Boolean(currentDirectionId && systemPromptText.trim() && imageCount > 0)

  const savePrompt = () => {
    const text = systemPromptText.trim()
    if (!text || !currentDirectionId) return
    const name = text.split('\n')[0].slice(0, 24) || '系统提示词'
    if (selectedPrompt && draft) updateSystemPrompt(selectedPrompt.id, { content: text })
    else addSystemPrompt(currentDirectionId, name, text)
    setDraft('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">SOP 生图</h2>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            参考图 {imageCount} 张
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            取消
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">产品 / 方向</div>
            <div className="flex gap-2">
              <select
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value)
                  setDirectionId('')
                  setPromptId('')
                  setDraft('')
                }}
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              >
                {products.map((node) => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
              <select
                value={currentDirectionId}
                onChange={(e) => {
                  setDirectionId(e.target.value)
                  setPromptId('')
                  setDraft('')
                }}
                className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
              >
                {productChildren.filter((n) => n.kind === 'direction').map((node) => (
                  <option key={node.id} value={node.id}>{node.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
              <span>系统提示词</span>
              {options.length > 0 && (
                <select
                  value={selectedPrompt?.id || ''}
                  onChange={(e) => {
                    setPromptId(e.target.value)
                    setDraft('')
                  }}
                  className="max-w-[220px] rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                >
                  {options.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              )}
              <div className="flex-1" />
              <button type="button" onClick={savePrompt} disabled={!systemPromptText.trim()} className="text-xs text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400">
                {selectedPrompt ? '保存修改' : '保存为新提示词'}
              </button>
            </div>
            <textarea
              value={systemPromptText}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              placeholder="写这个方向通用的系统提示词，例如：你是京东保品牌视觉，主色墨绿，标题必须含「赔付总限额600万」…"
              className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 placeholder:text-gray-300 dark:border-white/10 dark:bg-gray-800 dark:text-gray-200 dark:placeholder:text-gray-600"
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">分成几个任务卡</div>
            <div className="flex flex-wrap gap-2">
              {([
                ['one', '1 张卡（共用一份 SOP）'],
                ['perImage', `每张参考图一张卡（${imageCount} 张）`],
                ['custom', '自定义'],
              ] as Array<[SplitMode, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    mode === value
                      ? 'border-blue-500 bg-blue-50 text-blue-600 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-blue-300'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                  }`}
                >
                  {label}
                </button>
              ))}
              {mode === 'custom' && (
                <input
                  type="number"
                  min={1}
                  max={imageCount}
                  value={customCount}
                  onChange={(e) => setCustomCount(e.target.value)}
                  className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
                />
              )}
            </div>
            <div className="mt-1.5 text-[11px] text-gray-400">
              共 {groupCount} 张卡，参考图分配：{preview || '—'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">每张卡出几张图</span>
            <input
              type="number"
              min={1}
              max={30}
              value={perGroup}
              onChange={(e) => setPerGroup(e.target.value)}
              className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm dark:border-white/10 dark:bg-gray-800 dark:text-gray-200"
            />
            <span className="text-[11px] text-gray-400">每条提示词出一张，共约 {groupCount * (Number(perGroup) || 0)} 张</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">参考图只用于反推 SOP，不参与最终生图。</span>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => onConfirm({
              directionId: currentDirectionId,
              systemPromptText: systemPromptText.trim(),
              groupCount,
              promptsPerGroup: Math.max(1, Number(perGroup) || 1),
            })}
            className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.06]"
          >
            开始生成
          </button>
        </div>
      </div>
    </div>
  )
}
