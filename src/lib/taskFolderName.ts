/**
 * 任务卡导出时的文件夹命名。
 *
 * 默认规则：日期-产品-方向-尺寸-SOP名-自定义-序号
 * 日期取创建时间，尺寸见 sizeLabel，自定义来自设置，序号由客户端在重名时补（`-02`、`-03`）。
 */

import { sanitizeFileNamePart } from './exportFileName'

export const DEFAULT_TASK_FOLDER_TEMPLATE = '{date}-{product}-{direction}-{size}-{sop}-{custom}'

export const TASK_FOLDER_TOKENS = ['date', 'product', 'direction', 'size', 'sop', 'custom'] as const

export type TaskFolderToken = typeof TASK_FOLDER_TOKENS[number]

export interface TaskFolderContext {
  date?: Date
  product?: string
  direction?: string
  /** 形如 1024x1024 */
  size?: string
  sopName?: string
  /** 设置里的自定义文案 */
  custom?: string
}

/** 1280×720 叫大图、1080×1920 叫闪屏，其余直接写分辨率 */
export function sizeLabel(size?: string): string {
  const raw = (size ?? '').trim().toLowerCase().replace(/[×*]/g, 'x')
  if (!raw) return ''
  const match = raw.match(/^(\d+)\s*x\s*(\d+)$/)
  if (!match) return raw
  const width = Number(match[1])
  const height = Number(match[2])
  if (width === 1280 && height === 720) return '大图'
  if (width === 1080 && height === 1920) return '闪屏'
  return `${width}x${height}`
}

export function formatFolderDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/**
 * 按模板拼文件夹名：把占位符换成实际值，去掉空段和多余分隔符。
 * 模板里没写 {custom} 也不会自动追加，交给用户自己决定。
 */
export function buildTaskFolderName(template: string, context: TaskFolderContext): string {
  const values: Record<TaskFolderToken, string> = {
    date: context.date ? formatFolderDate(context.date) : '',
    product: context.product ?? '',
    direction: context.direction ?? '',
    size: sizeLabel(context.size),
    sop: context.sopName ?? '',
    custom: context.custom ?? '',
  }
  const source = template.trim() || DEFAULT_TASK_FOLDER_TEMPLATE
  const replaced = source.replace(/\{(date|product|direction|size|sop|custom)\}/g, (_, key: TaskFolderToken) => values[key])
  const segments = replaced
    .split(/[-_/\\]+/)
    .map((part) => sanitizeFileNamePart(part.replace(/[{}]/g, '')))
    .filter(Boolean)
  return segments.join('-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
}
