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
  /** 这块内容叫什么，例如「Logo」「警示语」；写提示词时会带进去说明要避开什么 */
  label?: string
  /** 是否参与「提示词避让」：关掉表示这块是设计的一部分，生图时不用特意留白 */
  avoid?: boolean
  /** logo 的高宽比（高 ÷ 宽），上传时记录；没有时按方形估算预留区 */
  aspect?: number
}

export interface PostTemplate {
  id: string
  /** 模板名，例如「9:16 竖版 A」 */
  label: string
  /** 目标画布尺寸；出图比例要能对上才会套用 */
  width: number
  height: number
  /**
   * 投放渠道（取值见 lib/channel 的 CHANNELS）。
   * 空表示通用：任何渠道都能套用，同渠道的模板优先。
   */
  channel?: string
  /** 是否启用 */
  enabled: boolean
  /** 同比例有多套时，默认这套优先；都没设默认则随机取 */
  isDefault: boolean
  /** 生成提示词时自动写入「预留区避让」说明，默认开启 */
  avoidOverlay?: boolean
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
    avoidOverlay: true,
  }
}

/**
 * 按原图比例挑选模板：
 * 只认比例对得上的（2% 容差）；有默认用默认，没有就随机。
 * 没有匹配项时返回 null —— 调用方保持原图不动。
 *
 * 指定渠道时只在该渠道的模板与通用模板里挑：同渠道优先，其次通用；
 * 两样都没有就不套（模板被标到别的渠道，说明尺寸口径本来就不一样，硬套会出错）。
 */
export function pickTemplateForImage(
  templates: PostTemplate[],
  srcWidth: number,
  srcHeight: number,
  channel?: string,
): PostTemplate | null {
  if (!(srcWidth > 0 && srcHeight > 0)) return null
  const ratio = srcWidth / srcHeight
  const ratioMatches = templates.filter((item) => (
    item.enabled
    && item.width > 0
    && item.height > 0
    && Math.abs(item.width / item.height - ratio) / ratio <= POST_RATIO_TOLERANCE + 1e-6
  ))
  if (!ratioMatches.length) return null

  let matches = ratioMatches
  if (channel) {
    const sameChannel = ratioMatches.filter((item) => item.channel === channel)
    matches = sameChannel.length ? sameChannel : ratioMatches.filter((item) => !item.channel)
  }
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

/** 模板按比例归组用的筛选项；和新建时的预设保持一致 */
export const POST_RATIO_FILTERS: Array<{ value: string; ratio: number }> = POST_SIZE_PRESETS.map((preset) => ({
  value: preset.label.split('  ')[0]!,
  ratio: preset.width / preset.height,
}))

/** 模板属于哪个比例档；不在预设里的归到 other，筛选时单独一档 */
export function postTemplateRatioKey(template: { width: number; height: number }): string {
  if (!(template.width > 0 && template.height > 0)) return 'other'
  const ratio = template.width / template.height
  return POST_RATIO_FILTERS.find(
    (item) => Math.abs(item.ratio - ratio) / item.ratio <= POST_RATIO_TOLERANCE + 1e-6,
  )?.value ?? 'other'
}

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
        avoid: true,
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
        label: 'Logo',
        avoid: true,
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
    avoidOverlay: true,
    elements: [
      {
        ...newPostElement('text', 1),
        text: '主标题留白，可在模板里改',
        fontSize: 92,
        fontWeight: 700,
        x: 0.06,
        y: 0.08,
        label: '主标题',
      },
      {
        ...newPostElement('text', 2),
        text: '免赔额、赔付比例、费率等请见保险条款及投保须知',
        fontSize: 28,
        color: '#9ca3af',
        fontWeight: 400,
        x: 0.06,
        y: 0.93,
        label: '警示语',
      },
    ],
  }
}

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** 文字行高，跟 applyPostTemplate 里的 1.35 保持一致 */
export const POST_LINE_HEIGHT = 1.35

/** 估算一段文字的宽度（单位 em）：中日韩字符按 1 个汉字算，其余按 0.55 */
export function estimateTextEm(text: string): number {
  let em = 0
  for (const char of text) {
    em += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.55
  }
  return em
}

/** 元素在成品画布上的占位框，全部是 0~1 的相对坐标 */
export interface PostElementBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 按绘制规则算出元素实际占的区域，用来告诉生图模型「这块要留白」 */
export function elementBox(el: PostElement, width: number, height: number): PostElementBox {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  if (!(width > 0 && height > 0)) return { x0: 0, y0: 0, x1: 0, y1: 0 }

  let boxWidth: number
  let boxHeight: number
  if (el.kind === 'logo') {
    boxWidth = Math.max(8, el.width * width)
    boxHeight = boxWidth * (el.aspect && el.aspect > 0 ? el.aspect : 1)
  } else {
    const lines = el.text.split('\n')
    const size = Math.max(8, el.fontSize)
    boxWidth = Math.max(...lines.map((line) => estimateTextEm(line)), 0) * size
    boxHeight = Math.max(lines.length, 1) * size * POST_LINE_HEIGHT
  }

  const left = el.x * width
  const top = el.y * height
  // 对齐方式决定从锚点往哪边展开
  const startX = el.kind === 'text' && el.align === 'center'
    ? left - boxWidth / 2
    : el.kind === 'text' && el.align === 'right'
      ? left - boxWidth
      : left

  return {
    x0: clamp(startX / width),
    y0: clamp(top / height),
    x1: clamp((startX + boxWidth) / width),
    y1: clamp((top + boxHeight) / height),
  }
}

/** 把占位框翻译成人话方位，例如「左上角」「底部通栏」；按中心点落在九宫格哪一格判断 */
export function regionName(box: PostElementBox): string {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  const vertical = cy < 0.33 ? 'top' : cy > 0.67 ? 'bottom' : 'middle'
  const horizontal = cx < 0.33 ? 'left' : cx > 0.67 ? 'right' : 'center'

  // 横向铺开或纵向铺开的，说「通栏」比说角落更准
  if (box.x1 - box.x0 >= 0.6) {
    return vertical === 'top' ? '顶部通栏' : vertical === 'bottom' ? '底部通栏' : '中部通栏'
  }
  if (box.y1 - box.y0 >= 0.6) {
    return horizontal === 'left' ? '左侧通栏' : horizontal === 'right' ? '右侧通栏' : '画面中心'
  }
  if (vertical === 'middle') {
    return horizontal === 'left' ? '左侧' : horizontal === 'right' ? '右侧' : '画面中心'
  }
  if (horizontal === 'center') return vertical === 'top' ? '正上方' : '正下方'
  const side = horizontal === 'left' ? '左' : '右'
  return vertical === 'top' ? `${side}上角` : `${side}下角`
}

/** 元素在避让说明里的称呼：优先用用户填的名称，其次按内容猜 */
export function elementLabel(el: PostElement, index: number): string {
  const custom = el.label?.trim()
  if (custom) return custom
  if (el.kind === 'logo') return 'Logo'
  if (/免责|条款|须知|风险|提示|声明|广告创意|合规/.test(el.text)) return '警示语 / 合规小字'
  return `后期文字 ${index + 1}`
}

/** 按「短边铺满、居中裁切」把原图放进目标画布（相当于 PS 的填充裁切） */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number) {
  const scale = Math.max(dstW / srcW, dstH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, width: w, height: h }
}
