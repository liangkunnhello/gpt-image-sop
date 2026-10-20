/** 后处理模板：出图回来后按模板尺寸裁切并叠加文字 / logo */

export type PostElementKind = 'text' | 'logo'

export interface PostElement {
  id: string
  kind: PostElementKind
  /** 相对画布的位置，0~1 */
  x: number
  y: number
  /** 文字：相对画布宽度的字号 */
  fontSize: number
  color: string
  fontWeight: number
  align: 'left' | 'center' | 'right'
  /** 文字内容 */
  text: string
  /** logo：相对画布宽度的宽度；文字不用 */
  width: number
  /** 0~1 */
  opacity: number
}

export interface PostTemplate {
  /** 目标画布尺寸 */
  width: number
  height: number
  /** 是否启用：启用后出图会自动套这个模板 */
  enabled: boolean
  elements: PostElement[]
}

export const POST_FONT_STACK = '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif'

export const POST_SIZE_PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: '16:9  2560×1440', width: 2560, height: 1440 },
  { label: '9:16  1440×2560', width: 1440, height: 2560 },
  { label: '1:1  2048×2048', width: 2048, height: 2048 },
  { label: '4:5  1638×2048', width: 1638, height: 2048 },
  { label: '3:4  1536×2048', width: 1536, height: 2048 },
]

export function newPostElement(kind: PostElementKind, index: number): PostElement {
  return kind === 'text'
    ? {
        id: `post-${Date.now().toString(36)}-${index}`,
        kind: 'text',
        x: 0.06,
        y: 0.06,
        fontSize: 0.03,
        color: '#111827',
        fontWeight: 600,
        align: 'left',
        text: '双击编辑文字',
        width: 0.3,
        opacity: 1,
      }
    : {
        id: `post-${Date.now().toString(36)}-${index}`,
        kind: 'logo',
        x: 0.06,
        y: 0.06,
        fontSize: 0.03,
        color: '#111827',
        fontWeight: 400,
        align: 'left',
        text: '',
        width: 0.12,
        opacity: 1,
      }
}

export function defaultPostTemplate(): PostTemplate {
  return {
    width: 2048,
    height: 2048,
    enabled: false,
    elements: [
      {
        ...newPostElement('text', 1),
        text: '主标题留白，可在模板里改',
        fontSize: 0.045,
        fontWeight: 700,
        x: 0.06,
        y: 0.08,
      },
      {
        ...newPostElement('text', 2),
        text: '免赔额、赔付比例、费率等请见保险条款及投保须知',
        fontSize: 0.014,
        color: '#9ca3af',
        fontWeight: 400,
        x: 0.06,
        y: 0.93,
      },
    ],
  }
}

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** 按「短边铺满、居中裁切」把原图放进目标画布（相当于 PS 的填充裁切） */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number) {
  const scale = Math.max(dstW / srcW, dstH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, width: w, height: h }
}
