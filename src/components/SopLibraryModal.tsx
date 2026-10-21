import { useEffect, useMemo, useState } from 'react'
import type { SopLibraryTab } from '../lib/sopStore'
import { NO_PRESET, SOP_LIBRARY_LABEL, directionPath, useSopStore } from '../lib/sopStore'
import { useStore } from '../store'
import { firstTextFile, isFileDrag } from '../lib/fileDrop'
import AiRewriteBar from './AiRewriteBar'
import MarkdownEditor from './MarkdownEditor'
import SopLibraryImportModal from './SopLibraryImportModal'

/** 系统提示词和卖点/风格的字段形状一致，抽平了好统一渲染 */
interface LibraryItem {
  id: string
  name: string
  content: string
  updatedAt: number
}

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
  </svg>
)

const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
    <path strokeLinecap="round" d="M4 20h4l10-10-4-4L4 16v4z" />
  </svg>
)

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path strokeLinecap="round" d="M15 5.5A1.5 1.5 0 0013.5 4h-8A1.5 1.5 0 004 5.5v8A1.5 1.5 0 005.5 15" />
  </svg>
)

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3">
    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
  </svg>
)

/**
 * 提示词库：系统提示词 / 卖点 / 风格 三合一的弹窗。
 * 原来三者各自是输入框上方的窄下拉（w-72~80、编辑框 3~4 行），正文根本写不开；
 * 这里换成左列表 + 右大编辑区，正文可以按需铺满。
 */
export default function SopLibraryModal() {
  const libraryTab = useSopStore((s) => s.libraryTab)
  const setLibraryTab = useSopStore((s) => s.setLibraryTab)
  const directions = useSopStore((s) => s.directions)
  const activeDirectionId = useSopStore((s) => s.activeDirectionId)
  const systemPrompts = useSopStore((s) => s.systemPrompts)
  const presets = useSopStore((s) => s.presets)
  const lastPick = useSopStore((s) => s.lastPick)
  const defaultPick = useSopStore((s) => s.defaultPick)
  const setPick = useSopStore((s) => s.setPick)
  const setDefaultPick = useSopStore((s) => s.setDefaultPick)
  const addSystemPrompt = useSopStore((s) => s.addSystemPrompt)
  const updateSystemPrompt = useSopStore((s) => s.updateSystemPrompt)
  const removeSystemPrompt = useSopStore((s) => s.removeSystemPrompt)
  const addPreset = useSopStore((s) => s.addPreset)
  const updatePreset = useSopStore((s) => s.updatePreset)
  const removePreset = useSopStore((s) => s.removePreset)
  const showToast = useStore((s) => s.showToast)

  const tab: SopLibraryTab = libraryTab ?? 'prompt'
  const direction = directions.find((node) => node.id === activeDirectionId)
  const productId = direction?.kind === 'direction' ? direction.parentId ?? '' : direction?.id ?? ''
  const productName = directions.find((node) => node.id === productId)?.name ?? ''
  const path = activeDirectionId ? directionPath(directions, activeDirectionId) : ''

  /** pick 里三类各自对应的字段名 */
  const pickKey = tab === 'prompt' ? 'promptId' : tab === 'point' ? 'pointId' : 'styleId'
  const pick = defaultPick[activeDirectionId] ?? lastPick[activeDirectionId] ?? {}

  const items: LibraryItem[] = useMemo(() => {
    if (tab === 'prompt') {
      return systemPrompts
        .filter((item) => item.productId === productId)
        .map((item) => ({ id: item.id, name: item.name, content: item.content, updatedAt: item.updatedAt }))
    }
    return presets
      .filter((item) => item.productId === productId && item.kind === tab)
      .map((item) => ({ id: item.id, name: item.name, content: item.content, updatedAt: item.updatedAt }))
  }, [tab, systemPrompts, presets, productId])

  const counts = useMemo(() => ({
    prompt: systemPrompts.filter((item) => item.productId === productId).length,
    point: presets.filter((item) => item.productId === productId && item.kind === 'point').length,
    style: presets.filter((item) => item.productId === productId && item.kind === 'style').length,
  }), [systemPrompts, presets, productId])

  // 当前生效的那条：显式「不使用」优先，其次是指定项，最后退回第一条
  const rawPickId = pick[pickKey]
  const isNone = rawPickId === NO_PRESET
  const currentItem = isNone ? undefined : (rawPickId ? items.find((item) => item.id === rawPickId) : items[0])

  const [editingId, setEditingId] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [newName, setNewName] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  /** md 文件拖到右侧空白区（比如「不使用系统提示词」时）也能导入 */
  const [paneFileOver, setPaneFileOver] = useState(false)

  const loadDraft = (item: LibraryItem) => {
    setEditingId(item.id)
    setDraftName(item.name)
    setDraftContent(item.content)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 导入弹窗开着时，Esc 交给它自己处理
      if (event.key === 'Escape' && !importOpen) setLibraryTab(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setLibraryTab, importOpen])

  // 切换分组或方向时，编辑区跟着切到该组的当前项，避免停在上一组的内容上
  useEffect(() => {
    const target = currentItem
    if (target) {
      setEditingId(target.id)
      setDraftName(target.name)
      setDraftContent(target.content)
    } else {
      setEditingId('')
      setDraftName('')
      setDraftContent('')
    }
    setNewName('')
    // 只在分组 / 方向 / 当前项身份变化时重置，不因为打字覆盖草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeDirectionId, currentItem?.id])

  const editingItem = items.find((item) => item.id === editingId)
  const dirty = Boolean(editingItem) && (draftName !== editingItem?.name || draftContent !== editingItem?.content)

  const applyItem = (id: string) => {
    setPick(activeDirectionId, { ...lastPick[activeDirectionId], [pickKey]: id })
  }

  const updateItem = (id: string, patch: { name?: string; content?: string }) => {
    if (tab === 'prompt') updateSystemPrompt(id, patch)
    else updatePreset(id, patch)
  }

  const createItem = () => {
    const name = newName.trim()
    if (!name) return
    const id = tab === 'prompt'
      ? addSystemPrompt(productId, name, name)
      : addPreset(productId, tab, name, name)
    applyItem(id)
    loadDraft({ id, name, content: name, updatedAt: Date.now() })
    setNewName('')
  }

  const copyItem = (item: LibraryItem) => {
    const existing = new Set(items.map((entry) => entry.name))
    let name = `${item.name} 副本`
    let seq = 2
    while (existing.has(name)) {
      name = `${item.name} 副本 ${seq}`
      seq += 1
    }
    const id = tab === 'prompt'
      ? addSystemPrompt(productId, name, item.content)
      : addPreset(productId, tab, name, item.content)
    applyItem(id)
    showToast(`已复制为「${name}」`, 'success')
  }

  const removeItem = (item: LibraryItem) => {
    if (tab === 'prompt') removeSystemPrompt(item.id)
    else removePreset(item.id)
    if (editingId === item.id) setEditingId('')
  }

  /** 文件名（去掉 .md 后缀）→ 标题名；和列表里已有的重名时补序号，排除自己 */
  const nameFromFile = (fileName: string, excludeId = '') => {
    const base = fileName.replace(/\.(md|markdown|txt)$/i, '').trim() || `导入的${label}`
    const existing = new Set(items.filter((entry) => entry.id !== excludeId).map((entry) => entry.name))
    let name = base
    let seq = 2
    while (existing.has(name)) {
      name = `${base} ${seq}`
      seq += 1
    }
    return name
  }

  /**
   * 拖入 .md 文件：正文和标题都按文件来，并立即保存。
   * 有选中条目就覆盖它（顺带改名），没有就新建一条。
   */
  const importMarkdownFile = (text: string, fileName: string) => {
    if (editingId) {
      const name = nameFromFile(fileName, editingId)
      setDraftName(name)
      setDraftContent(text)
      updateItem(editingId, { name, content: text })
      showToast(`已导入并保存为「${name}」`, 'success')
      return
    }
    const name = nameFromFile(fileName)
    const id = tab === 'prompt'
      ? addSystemPrompt(productId, name, text)
      : addPreset(productId, tab, name, text)
    applyItem(id)
    loadDraft({ id, name, content: text, updatedAt: Date.now() })
    showToast(`已导入并保存为「${name}」`, 'success')
  }

  // 右侧面板整体也接住 md 拖放：没有选中条目（含「不使用」）时直接新建一条
  const handlePaneDragOver = (event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (!paneFileOver) setPaneFileOver(true)
  }

  const handlePaneDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return
    const next = event.relatedTarget as Node | null
    if (!next || !event.currentTarget.contains(next)) setPaneFileOver(false)
  }

  const handlePaneDrop = async (event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setPaneFileOver(false)
    const file = firstTextFile(event.dataTransfer.files)
    if (!file) {
      showToast('只支持 .md / .markdown / .txt 文件', 'error')
      return
    }
    try {
      const text = await file.text()
      if (!text.trim()) {
        showToast(`${file.name} 是空文件`, 'error')
        return
      }
      importMarkdownFile(text, file.name)
    } catch {
      showToast(`读取 ${file.name} 失败`, 'error')
    }
  }

  const saveDraft = () => {
    if (!editingId) return
    updateItem(editingId, { name: draftName.trim() || '未命名', content: draftContent })
    setDraftName(draftName.trim() || '未命名')
    showToast('已保存', 'success')
  }

  const label = SOP_LIBRARY_LABEL[tab]

  // hooks 全部走完再判断，避免开关弹窗时 Hook 数量变化
  if (!libraryTab) return null

  return (
    <>
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onClick={() => setLibraryTab(null)}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[86vh] max-h-[720px] w-full max-w-[940px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-gray-800"
      >
        {/* 头部：标题 + 归属，让人清楚这份列表是哪个产品、选择记在哪个方向 */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.06]">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">提示词库</h2>
            <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500" title={path}>
              归属 {path || '未选择方向'} · 列表按产品共享，选择只记在当前方向
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLibraryTab(null)}
            title="关闭（Esc）"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            <CloseIcon />
          </button>
        </div>

        {/* 分组 tab */}
        <div className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-4 dark:border-white/[0.06]">
          {(['prompt', 'point', 'style'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setLibraryTab(key)}
              className={`relative px-3 py-2.5 text-xs font-medium transition-colors ${
                tab === key
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {SOP_LIBRARY_LABEL[key]}
              <span className={`ml-1 text-[10px] tabular-nums ${tab === key ? 'text-blue-400' : 'text-gray-400'}`}>
                {counts[key]}
              </span>
              {tab === key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-blue-500" />}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：列表 */}
          <div className="flex w-64 shrink-0 flex-col border-r border-gray-100 dark:border-white/[0.06]">
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <button
                type="button"
                onClick={() => applyItem(NO_PRESET)}
                className={`mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                  isNone
                    ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-500/[0.18] dark:text-blue-200'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">不使用{tab === 'prompt' ? '系统提示词' : label}</span>
                {isNone && <span className="shrink-0 text-[10px]">当前</span>}
              </button>
              <div className="my-1 h-px bg-gray-100 dark:bg-white/[0.06]" />

              {!items.length && (
                <p className="px-2 py-6 text-center text-xs leading-relaxed text-gray-400">
                  还没有{label}
                  <br />
                  在下面输入名称回车新建
                </p>
              )}

              {items.map((item) => {
                const isCurrent = currentItem?.id === item.id
                const isEditing = editingId === item.id
                return (
                  <div
                    key={item.id}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setDefaultPick(activeDirectionId, { ...defaultPick[activeDirectionId], [pickKey]: item.id })
                      showToast(`已把「${item.name}」设为这个方向的默认${label}`, 'success')
                    }}
                    className={`group relative mb-0.5 rounded-lg transition-colors ${
                      isEditing
                        ? 'bg-gray-100 dark:bg-white/[0.08]'
                        : 'hover:bg-gray-50 dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    {/* 悬停时右侧浮出操作按钮，给它们让出宽度，别把名称压住 */}
                    <button
                      type="button"
                      onClick={() => {
                        applyItem(item.id)
                        loadDraft(item)
                      }}
                      className="block w-full min-w-0 px-2 py-1.5 pr-2 text-left transition-[padding] group-hover:pr-[70px]"
                    >
                      <div className="flex items-center gap-1">
                        <span
                          className={`min-w-0 flex-1 truncate text-xs ${
                            isCurrent
                              ? 'font-semibold text-blue-700 dark:text-blue-300'
                              : 'text-gray-700 dark:text-gray-200'
                          }`}
                        >
                          {item.name}
                        </span>
                        {isCurrent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
                      </div>
                      <div className="line-clamp-2 text-[10px] leading-relaxed text-gray-400">{item.content}</div>
                    </button>
                    <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded-md bg-white/90 p-0.5 shadow-sm group-hover:flex dark:bg-gray-800/90">
                      <button
                        type="button"
                        onClick={() => loadDraft(item)}
                        title="编辑"
                        className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-white/10"
                      >
                        <EditIcon />
                      </button>
                      <button
                        type="button"
                        onClick={() => copyItem(item)}
                        title="复制"
                        className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-white/10"
                      >
                        <CopyIcon />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeItem(item)}
                        title="删除"
                        className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="shrink-0 border-t border-gray-100 p-2 dark:border-white/[0.06]">
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                title="把这个产品下已有的系统提示词 / 卖点 / 风格复制过来"
                className="mb-1 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-gray-200 px-2 py-1.5 text-[11px] text-gray-500 transition-colors hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-400 dark:hover:border-blue-500/40 dark:hover:text-blue-300"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
                  <path strokeLinecap="round" d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                </svg>
                从其他产品导入
              </button>
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') createItem()
                }}
                placeholder={`新建${label}，回车添加`}
                className="w-full rounded-lg border border-dashed border-gray-200 px-2 py-1.5 text-xs text-gray-700 placeholder:text-gray-300 focus:border-blue-400 focus:outline-none dark:border-white/10 dark:bg-transparent dark:text-gray-200"
              />
            </div>
          </div>

          {/* 右：编辑区，正文可以铺满剩余高度；没有选中条目时整块也接住 md 拖放 */}
          <div
            onDragEnter={handlePaneDragOver}
            onDragOver={handlePaneDragOver}
            onDragLeave={handlePaneDragLeave}
            onDrop={handlePaneDrop}
            className={`flex min-w-0 flex-1 flex-col p-4 transition-colors ${
              paneFileOver ? 'bg-blue-50/60 ring-2 ring-inset ring-blue-300/60 dark:bg-blue-500/10 dark:ring-blue-500/30' : ''
            }`}
          >
            {editingItem ? (
              <>
                <div className="flex shrink-0 items-center gap-2">
                  <input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder="名称"
                    className="min-w-0 flex-1 rounded-lg border border-transparent bg-gray-50 px-2.5 py-1.5 text-sm font-medium text-gray-900 transition-colors focus:border-blue-400 focus:bg-white focus:outline-none dark:bg-white/[0.06] dark:text-white dark:focus:bg-white/[0.09]"
                  />
                  {currentItem?.id === editingItem.id ? (
                    <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-500/20 dark:text-blue-300">
                      使用中
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => applyItem(editingItem.id)}
                      className="shrink-0 rounded-full border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500 transition-colors hover:border-blue-300 hover:text-blue-600 dark:border-white/10 dark:text-gray-400 dark:hover:text-blue-300"
                    >
                      使用这条
                    </button>
                  )}
                  {dirty && <span className="shrink-0 text-[10px] text-amber-500">未保存</span>}
                </div>

                {/* 系统提示词本身是 Markdown 文件，用带工具栏和预览的编辑器，不要纯文本框 */}
                <MarkdownEditor
                  value={draftContent}
                  onChange={setDraftContent}
                  placeholder={tab === 'prompt'
                    ? '系统提示词正文，支持 Markdown：# 标题、- 列表、**重点**…'
                    : `${label}正文，支持 Markdown`}
                  className="mt-3 min-h-0 flex-1"
                  onSave={saveDraft}
                  onImportFile={importMarkdownFile}
                />

                <div className="mt-3 shrink-0">
                  <AiRewriteBar
                    value={draftContent}
                    currentName={draftName}
                    onDone={(result) => {
                      const base = result.name.trim() || `${draftName.trim() || editingItem.name}（AI）`
                      const existing = new Set(items.map((entry) => entry.name))
                      let name = base
                      let seq = 2
                      while (existing.has(name)) {
                        name = `${base} ${seq}`
                        seq += 1
                      }
                      const id = tab === 'prompt'
                        ? addSystemPrompt(productId, name, result.content)
                        : addPreset(productId, tab, name, result.content)
                      applyItem(id)
                      loadDraft({ id, name, content: result.content, updatedAt: Date.now() })
                      showToast(`已另存为新版本「${name}」，原内容未改动`, 'success')
                    }}
                  />
                </div>

                <div className="mt-3 flex shrink-0 items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-[10px] text-gray-400">
                    右键列表项可设为这个方向的默认{label}
                  </p>
                  <button
                    type="button"
                    onClick={() => loadDraft(editingItem)}
                    className="rounded-lg px-2.5 py-1 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:hover:bg-white/10"
                  >
                    还原
                  </button>
                  <button
                    type="button"
                    onClick={saveDraft}
                    disabled={!dirty}
                    className="rounded-lg bg-blue-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 dark:disabled:bg-white/10"
                  >
                    保存
                  </button>
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-center">
                <p className="text-sm text-gray-400 dark:text-gray-500">左边选一条，或者新建一条</p>
                <p className="text-xs text-gray-400 dark:text-gray-600">
                  {label}按产品共享，同一产品下所有方向都能用
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>

    {importOpen && (
      <SopLibraryImportModal
        targetProductId={productId}
        targetProductName={productName}
        defaultTab={tab}
        onClose={() => setImportOpen(false)}
      />
    )}
    </>
  )
}
