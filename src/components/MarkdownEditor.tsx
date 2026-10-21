import { useCallback, useEffect, useRef, useState } from 'react'

import { firstTextFile, isFileDrag } from '../lib/fileDrop'
import { useStore } from '../store'
import MarkdownRenderer from './MarkdownRenderer'

type ViewMode = 'edit' | 'split' | 'preview'

interface Props {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  /** 额外类名，作用在最外层容器上 */
  className?: string
  /** 自动聚焦编辑区 */
  autoFocus?: boolean
  /** 右上角额外内容（例如「未保存」提示） */
  headerExtra?: React.ReactNode
  /** 支持 Ctrl/⌘+S 触发保存 */
  onSave?: () => void
  /**
   * 把 .md 文件拖进编辑区时的回调。不传则只把内容填进编辑框（由调用方自己保存）。
   * 传了就可以在这里顺便落库。
   */
  onImportFile?: (text: string, fileName: string) => void
}


/** 工具栏按钮：把选区包起来，或给每一行加前缀 */
type Action = {
  key: string
  label: string
  title: string
  kind: 'wrap' | 'line' | 'insert'
  before?: string
  after?: string
  placeholder?: string
  prefix?: string
  /** 有序列表：自动接上序号 */
  ordered?: boolean
}

const WRAP_ACTIONS: Action[] = [
  { key: 'h1', label: 'H1', title: '一级标题（行首 #）', kind: 'line', prefix: '# ' },
  { key: 'h2', label: 'H2', title: '二级标题（行首 ##）', kind: 'line', prefix: '## ' },
  { key: 'h3', label: 'H3', title: '三级标题（行首 ###）', kind: 'line', prefix: '### ' },
  { key: 'bold', label: 'B', title: '粗体（Ctrl/⌘+B）', kind: 'wrap', before: '**', after: '**', placeholder: '粗体' },
  { key: 'italic', label: 'I', title: '斜体（Ctrl/⌘+I）', kind: 'wrap', before: '*', after: '*', placeholder: '斜体' },
  { key: 'strike', label: 'S', title: '删除线', kind: 'wrap', before: '~~', after: '~~', placeholder: '删除线' },
  { key: 'code', label: '</>', title: '行内代码', kind: 'wrap', before: '`', after: '`', placeholder: 'code' },
  { key: 'ul', label: '•', title: '无序列表', kind: 'line', prefix: '- ' },
  { key: 'ol', label: '1.', title: '有序列表', kind: 'line', prefix: '1. ', ordered: true },
  { key: 'quote', label: '❯', title: '引用', kind: 'line', prefix: '> ' },
  { key: 'pre', label: '```', title: '代码块', kind: 'insert', before: '```\n', after: '\n```', placeholder: '代码' },
  { key: 'link', label: '链接', title: '链接', kind: 'wrap', before: '[', after: '](https://)', placeholder: '文字' },
  { key: 'hr', label: '—', title: '分割线', kind: 'insert', before: '\n---\n', after: '' },
]

/** 取选区所在行的起止位置，行级操作要按行处理 */
function lineRange(text: string, start: number, end: number) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextBreak = text.indexOf('\n', end)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  return { lineStart, lineEnd }
}

export default function MarkdownEditor({
  value,
  onChange,
  placeholder = '支持 Markdown：**粗体**、## 标题、- 列表、> 引用…',
  className = '',
  autoFocus = false,
  headerExtra,
  onSave,
  onImportFile,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = useState<ViewMode>('edit')
  const [focused, setFocused] = useState(false)
  /** 有 md 文件拖到编辑区上方时给个淡蓝描边，松手即导入 */
  const [fileOver, setFileOver] = useState(false)

  /** 改完值后把光标/选区放回去，否则受控 textarea 会跳到末尾 */
  const applyEdit = (next: string, selectionStart: number, selectionEnd: number) => {
    onChange(next)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(selectionStart, selectionEnd)
    })
  }

  const runAction = useCallback((action: Action) => {
    const el = textareaRef.current
    if (!el) return
    const text = value
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = text.slice(start, end)

    if (action.kind === 'wrap') {
      const before = action.before ?? ''
      const after = action.after ?? ''
      const body = selected || action.placeholder || ''
      const next = `${text.slice(0, start)}${before}${body}${after}${text.slice(end)}`
      const bodyStart = start + before.length
      applyEdit(next, bodyStart, bodyStart + body.length)
      return
    }

    if (action.kind === 'insert') {
      const before = action.before ?? ''
      const after = action.after ?? ''
      const body = selected || action.placeholder || ''
      const next = `${text.slice(0, start)}${before}${body}${after}${text.slice(end)}`
      const bodyStart = start + before.length
      applyEdit(next, bodyStart, bodyStart + body.length)
      return
    }

    // 行级：给选中的每一行加/去前缀
    const { lineStart, lineEnd } = lineRange(text, start, end)
    const block = text.slice(lineStart, lineEnd) || ''
    const prefix = action.prefix ?? ''
    const lines = block.split('\n')
    const allPrefixed = lines.every((line) => (action.ordered
      ? /^\s*\d+\.\s/.test(line)
      : line.startsWith(prefix)))

    const nextLines = lines.map((line, index) => {
      if (allPrefixed) {
        return action.ordered ? line.replace(/^\s*\d+\.\s/, '') : line.slice(prefix.length)
      }
      if (!line.trim()) return line
      return action.ordered ? `${index + 1}. ${line}` : `${prefix}${line}`
    })
    const nextBlock = nextLines.join('\n')
    const next = `${text.slice(0, lineStart)}${nextBlock}${text.slice(lineEnd)}`
    applyEdit(next, lineStart, lineStart + nextBlock.length)
  }, [value, onChange])

  // Ctrl/⌘+B 粗体，Ctrl/⌘+I 斜体；Tab 缩进两格，不跳出输入框
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.metaKey || event.ctrlKey
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'b') {
        event.preventDefault()
        runAction(WRAP_ACTIONS.find((item) => item.key === 'bold')!)
        return
      }
      if (key === 'i') {
        event.preventDefault()
        runAction(WRAP_ACTIONS.find((item) => item.key === 'italic')!)
        return
      }
      if (key === 's' && onSave) {
        event.preventDefault()
        onSave()
        return
      }
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const el = event.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      const next = `${value.slice(0, start)}  ${value.slice(end)}`
      applyEdit(next, start + 2, start + 2)
      return
    }
    // 回车时接着上一行的列表标记，省得每次都手打
    if (event.key === 'Enter' && !event.shiftKey) {
      const el = event.currentTarget
      const start = el.selectionStart
      const { lineStart } = lineRange(value, start, el.selectionEnd)
      const currentLine = value.slice(lineStart, start)
      const bullet = currentLine.match(/^(\s*)([-*+])\s+(.*)$/)
      const ordered = currentLine.match(/^(\s*)(\d+)\.\s+(.*)$/)
      if (bullet && bullet[3].trim()) {
        event.preventDefault()
        const insert = `\n${bullet[1]}${bullet[2]} `
        const next = `${value.slice(0, start)}${insert}${value.slice(start)}`
        applyEdit(next, start + insert.length, start + insert.length)
        return
      }
      if (ordered && ordered[3].trim()) {
        event.preventDefault()
        const insert = `\n${ordered[1]}${Number(ordered[2]) + 1}. `
        const next = `${value.slice(0, start)}${insert}${value.slice(start)}`
        applyEdit(next, start + insert.length, start + insert.length)
      }
    }
  }

  // ===== 拖入 .md 文件直接导入 =====
  const handleDragOver = (event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return
    // 必须拦下来，否则会被全局的「拖入图片」处理和浏览器的默认打开文件接管
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    if (!fileOver) setFileOver(true)
  }

  const handleDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.stopPropagation()
    const next = event.relatedTarget as Node | null
    if (!next || !event.currentTarget.contains(next)) setFileOver(false)
  }

  const handleDrop = async (event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setFileOver(false)
    const file = firstTextFile(event.dataTransfer.files)
    if (!file) {
      useStore.getState().showToast('只支持 .md / .markdown / .txt 文件', 'error')
      return
    }
    try {
      const text = await file.text()
      if (!text.trim()) {
        useStore.getState().showToast(`${file.name} 是空文件`, 'error')
        return
      }
      if (onImportFile) onImportFile(text, file.name)
      else {
        onChange(text)
        useStore.getState().showToast(`已导入 ${file.name}`, 'success')
      }
    } catch {
      useStore.getState().showToast(`读取 ${file.name} 失败`, 'error')
    }
  }

  // 预览/分栏模式下外部内容变化（AI 改写、切条目）时，保持编辑区滚动位置不跳
  useEffect(() => {
    if (mode === 'preview') return
    const el = textareaRef.current
    if (el && !focused) el.scrollTop = 0
  }, [value, mode, focused])

  const lines = value ? value.split('\n').length : 0

  return (
    <div
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex min-h-0 flex-col overflow-hidden rounded-lg border bg-white transition-colors focus-within:border-blue-400 dark:bg-gray-900/40 ${
        fileOver
          ? 'border-blue-400 ring-2 ring-blue-300/50 dark:border-blue-400 dark:ring-blue-500/30'
          : 'border-gray-200 dark:border-white/10'
      } ${className}`}
    >
      {/* 工具栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-gray-100 px-1.5 py-1 dark:border-white/[0.06]">
        {WRAP_ACTIONS.map((action) => (
          <button
            key={action.key}
            type="button"
            title={action.title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runAction(action)}
            className="flex h-6 min-w-6 items-center justify-center rounded px-1 text-[11px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-gray-100"
          >
            {action.label}
          </button>
        ))}
        <div className="mx-1 h-4 w-px bg-gray-200 dark:bg-white/10" />
        {(['edit', 'split', 'preview'] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setMode(item)}
            className={`h-6 rounded px-1.5 text-[11px] transition-colors ${
              mode === item
                ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/20 dark:text-blue-300'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-gray-100'
            }`}
          >
            {item === 'edit' ? '编辑' : item === 'split' ? '分栏' : '预览'}
          </button>
        ))}
        <div className="flex-1" />
        {headerExtra}
        <span className="shrink-0 px-1 text-[10px] tabular-nums text-gray-400">{value.length} 字 · {lines} 行</span>
      </div>

      {/* 正文 */}
      <div className="flex min-h-0 flex-1">
        {mode !== 'preview' && (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={placeholder}
            spellCheck={false}
            autoFocus={autoFocus}
            className={`min-h-0 flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-gray-700 outline-none placeholder:font-sans placeholder:text-gray-300 dark:text-gray-200 dark:placeholder:text-gray-600 ${
              mode === 'split' ? 'border-r border-gray-100 dark:border-white/[0.06]' : ''
            }`}
          />
        )}
        {mode !== 'edit' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5 text-xs leading-relaxed text-gray-700 dark:text-gray-200 custom-scrollbar">
            {value.trim() ? (
              <MarkdownRenderer content={value} />
            ) : (
              <p className="text-gray-300 dark:text-gray-600">预览区：左边写 Markdown，这里看渲染结果</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
