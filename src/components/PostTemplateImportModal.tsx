/**
 * 导入后处理模板：从别的产品 / 方向复制模板到当前节点。
 *
 * 与模板编辑器是两件事：编辑器负责「改」，这里只负责「搬」。
 * 所以不复用编辑器那套撤销重做 —— 搬完就落盘，用户不满意可以再删。
 */
import { useMemo, useState } from 'react'
import type { PostTemplate } from '../lib/postTemplate'
import { collectPostTemplateSources, importPostTemplates } from '../lib/postTemplateImport'
import { useSopStore } from '../lib/sopStore'
import { useStore } from '../store'

interface Props {
  /** 导入到哪个节点：产品 id 或方向 id */
  ownerId: string
  ownerName: string
  onClose: () => void
}

/** 模板在列表里的摘要：尺寸 + 元素数，够用来分辨是哪一套 */
function templateSummary(template: PostTemplate): string {
  const labels = template.elements
    .map((el) => el.label?.trim())
    .filter((item): item is string => Boolean(item))
  const size = `${template.width}×${template.height}`
  const parts = [size]
  if (template.channel) parts.push(template.channel)
  parts.push(`${template.elements.length} 个元素`)
  if (labels.length) parts.push(labels.slice(0, 3).join(' / '))
  return parts.join(' · ')
}

export default function PostTemplateImportModal({ ownerId, ownerName, onClose }: Props) {
  const directions = useSopStore((s) => s.directions)
  const postTemplates = useSopStore((s) => s.postTemplates)
  const setPostTemplates = useSopStore((s) => s.setPostTemplates)
  const showToast = useStore((s) => s.showToast)

  const groups = useMemo(
    () => collectPostTemplateSources(postTemplates, directions, { excludeId: ownerId }),
    [postTemplates, directions, ownerId],
  )

  /** 当前展开的源节点 id；同时只开一个，避免几十套模板铺满整屏 */
  const [openSourceId, setOpenSourceId] = useState<string>(() => groups[0]?.sources[0]?.id ?? '')
  /** 选中的模板：key 为 `${源节点id}::${模板id}`，跨节点选择也不会串 */
  const [picked, setPicked] = useState<Set<string>>(() => new Set())

  const keyOf = (sourceId: string, templateId: string) => `${sourceId}::${templateId}`
  const templatesOf = (sourceId: string): PostTemplate[] => postTemplates[sourceId] ?? []

  const toggle = (sourceId: string, templateId: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      const key = keyOf(sourceId, templateId)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 某个源节点下选中的数量，用来在分组标题上显示「已选 N」 */
  const pickedCountOf = (sourceId: string) => {
    let count = 0
    for (const key of picked) {
      if (key.startsWith(`${sourceId}::`)) count += 1
    }
    return count
  }

  const totalSources = groups.reduce((sum, group) => sum + group.sources.length, 0)

  const submit = () => {
    if (!picked.size) return
    // 按源节点归拢：一次导入可能来自多个节点，逐个节点合并后再写回
    const bySource = new Map<string, PostTemplate[]>()
    for (const key of picked) {
      const splitAt = key.indexOf('::')
      const sourceId = key.slice(0, splitAt)
      const templateId = key.slice(splitAt + 2)
      const template = templatesOf(sourceId).find((item) => item.id === templateId)
      if (!template) continue
      const list = bySource.get(sourceId) ?? []
      list.push(template)
      bySource.set(sourceId, list)
    }

    let merged = postTemplates[ownerId] ?? []
    let imported = 0
    for (const list of bySource.values()) {
      merged = importPostTemplates(
        merged,
        list,
        // id 必须换新：与源节点那套同 id 会让列表 key 撞车，删一套会误删另一套
        (source, index) => `${source.id}-copy-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 5)}`,
      )
      imported += list.length
    }
    setPostTemplates(ownerId, merged)
    showToast(`已导入 ${imported} 套模板到「${ownerName}」`, 'success')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">导入后处理模板</h2>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            导入到 {ownerName}
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            取消
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          {!totalSources ? (
            <p className="py-8 text-center text-xs leading-relaxed text-gray-400">
              其他产品 / 方向还没有配置过后处理模板
              <br />
              先在那边配好模板，再回到这里导入
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map((group) => (
                <div key={group.categoryName}>
                  <div className="mb-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">{group.categoryName}</div>
                  <div className="space-y-1">
                    {group.sources.map((source) => {
                      const list = templatesOf(source.id)
                      const open = openSourceId === source.id
                      const count = pickedCountOf(source.id)
                      return (
                        <div key={source.id} className="overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
                          <button
                            type="button"
                            onClick={() => setOpenSourceId(open ? '' : source.id)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-white/[0.04]"
                          >
                            <span className="text-[11px] text-gray-400">{open ? '▾' : '▸'}</span>
                            <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                              {source.kind === 'product' ? '产品' : '方向'}
                              {source.parentName ? `（${source.parentName}）` : ''}：{source.name}
                            </span>
                            <div className="flex-1" />
                            {count > 0 && (
                              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
                                已选 {count}
                              </span>
                            )}
                            <span className="text-[10px] text-gray-400">{list.length} 套</span>
                          </button>

                          {open && (
                            <div className="border-t border-gray-100 bg-gray-50/60 dark:border-white/[0.06] dark:bg-white/[0.02]">
                              {list.map((template) => {
                                const checked = picked.has(keyOf(source.id, template.id))
                                return (
                                  <label
                                    key={template.id}
                                    className="flex cursor-pointer items-start gap-2 px-3 py-1.5 transition-colors hover:bg-white dark:hover:bg-white/[0.05]"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggle(source.id, template.id)}
                                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-500"
                                    />
                                    <span className="min-w-0">
                                      <span className="block truncate text-xs text-gray-700 dark:text-gray-200">
                                        {template.label}
                                        {template.isDefault && <span className="ml-1 text-blue-500">★</span>}
                                      </span>
                                      <span className="block truncate text-[10px] text-gray-400">
                                        {templateSummary(template)}
                                      </span>
                                    </span>
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <span className="text-[11px] text-gray-400">
            导入是复制一份，源节点的模板不会被改动。
          </span>
          <button
            type="button"
            disabled={!picked.size}
            onClick={submit}
            className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/[0.06]"
          >
            导入选中的 {picked.size} 套
          </button>
        </div>
      </div>
    </div>
  )
}
