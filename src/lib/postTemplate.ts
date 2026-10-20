/** 后处理模板：出图回来后按模板尺寸裁切并叠加文字 / logo */

export type PostElementKind = 'text' | 'logo'

export interface PostElement {
  id: string
  kind: PostElementKind
  /** 相对画布的位置，0~1 */
  x: number
  y: number
  /** 文字字号，单位 px，指成品图上的实际像素 */
  fontSize: number
  color: string
  /** 描边颜色，配合 strokeWidth 使用 */
  strokeColor: string
  /** 描边粗细（px），0 表示不描边 */
  strokeWidth: number
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
  id: string
  /** 模板名，例如「9:16 竖版 A」 */
  label: string
  /** 目标画布尺寸；出图比例要能对上才会套用 */
  width: number
  height: number
  /** 是否启用 */
  enabled: boolean
  /** 同比例有多套时，默认这套优先；都没设默认则随机取 */
  isDefault: boolean
  elements: PostElement[]
}

/** 比例匹配容差：相对误差 2% 以内算同一比例 */
export const POST_RATIO_TOLERANCE = 0.02

export function createPostTemplate(width: number, height: number, label: string): PostTemplate {
  return {
    id: `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    width,
    height,
    enabled: false,
    isDefault: false,
    elements: defaultPostTemplate().elements.map((item, index) => ({
      ...item,
      id: `post-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 5)}`,
    })),
  }
}

/**
 * 按原图比例挑选模板：
 * 只认比例对得上的（2% 容差）；有默认用默认，没有就随机。
 * 没有匹配项时返回 null —— 调用方保持原图不动。
 */
export function pickTemplateForImage(
  templates: PostTemplate[],
  srcWidth: number,
  srcHeight: number,
): PostTemplate | null {
  if (!(srcWidth > 0 && srcHeight > 0)) return null
  const ratio = srcWidth / srcHeight
  const matches = templates.filter((item) => (
    item.enabled
    && item.width > 0
    && item.height > 0
    && Math.abs(item.width / item.height - ratio) / ratio <= POST_RATIO_TOLERANCE + 1e-6
  ))
  if (!matches.length) return null
  const preferred = matches.find((item) => item.isDefault)
  if (preferred) return preferred
  return matches[Math.floor(Math.random() * matches.length)]
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
        fontSize: 48,
        color: '#111827',
        strokeColor: '#ffffff',
        strokeWidth: 0,
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
        fontSize: 48,
        color: '#111827',
        strokeColor: '#ffffff',
        strokeWidth: 0,
        fontWeight: 400,
        align: 'left',
        text: '',
        width: 0.12,
        opacity: 1,
      }
}

export function defaultPostTemplate(): PostTemplate {
  return {
    id: `tpl-${Date.now().toString(36)}`,
    label: '1:1 方图',
    width: 2048,
    height: 2048,
    enabled: false,
    isDefault: true,
    elements: [
      {
        ...newPostElement('text', 1),
        text: '主标题留白，可在模板里改',
        fontSize: 92,
        fontWeight: 700,
        x: 0.06,
        y: 0.08,
      },
      {
        ...newPostElement('text', 2),
        text: '免赔额、赔付比例、费率等请见保险条款及投保须知',
        fontSize: 28,
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
