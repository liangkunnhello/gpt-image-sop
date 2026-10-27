/**
 * 任务卡导出时的文件夹命名。
 *
 * 默认规则：日期-产品-方向-尺寸-SOP名-卖点-自定义-序号
 * 日期取创建时间，尺寸见 sizeLabel，自定义来自设置，序号由客户端在重名时补（`-02`、`-03`）。
 * SOP 名最多保留 6 个字（SOP 全名往往是一整句话，直接拼进去会撑爆名字），卖点名最多 12 个字。
 */

import { sanitizeFileNamePart } from './exportFileName'

/** SOP 名在文件夹 / 文件名里最多保留几个字 */
export const MAX_SOP_NAME_CHARS = 6
/** 卖点名一般比 SOP 名短，但也不能让它把整个名字撑开 */
export const MAX_POINT_NAME_CHARS = 12

/**
 * 按「字」截断。
 *
 * 不用 slice：名字里有 emoji 等代理对时，slice 会把一个字符劈成半个，写进文件名就是乱码。
 */
function truncateChars(text: string | undefined, max: number): string {
  const chars = Array.from((text ?? '').trim())
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

/** 截断 SOP 名 */
export function truncateSopName(name?: string): string {
  return truncateChars(name, MAX_SOP_NAME_CHARS)
}

/** 截断卖点名 */
export function truncatePointName(name?: string): string {
  return truncateChars(name, MAX_POINT_NAME_CHARS)
}

export const DEFAULT_TASK_FOLDER_TEMPLATE = '{date}-{product}-{direction}-{size}-{sop}-{point}-{custom}'

export const TASK_FOLDER_TOKENS = ['date', 'product', 'direction', 'size', 'sop', 'point', 'custom'] as const

export type TaskFolderToken = typeof TASK_FOLDER_TOKENS[number]

export interface TaskFolderContext {
  date?: Date
  product?: string
  direction?: string
  /** 形如 1024x1024 */
  size?: string
  sopName?: string
  /** 提交这张卡时选中的卖点名 */
  pointName?: string
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
    sop: truncateSopName(context.sopName),
    point: truncatePointName(context.pointName),
    custom: context.custom ?? '',
  }
  const source = template.trim() || DEFAULT_TASK_FOLDER_TEMPLATE
  const replaced = source.replace(/\{(date|product|direction|size|sop|point|custom)\}/g, (_, key: TaskFolderToken) => values[key])
  const segments = replaced
    .split(/[-_/\\]+/)
    .map((part) => sanitizeFileNamePart(part.replace(/[{}]/g, '')))
    .filter(Boolean)
  return segments.join('-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
}
