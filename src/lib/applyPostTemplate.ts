import type { SopDirectionNode } from '../types'
import { POST_FONT_STACK, coverRect, elementLineHeight, type PostElement, type PostTemplate } from './postTemplate'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

/** 方向节点 → 所属产品 id（产品级模板挂在这一层） */
export function productIdForDirection(
  directions: SopDirectionNode[],
  directionId: string | undefined,
): string {
  if (!directionId) return ''
  const node = directions.find((item) => item.id === directionId)
  if (!node) return ''
  return node.kind === 'direction' ? node.parentId ?? '' : node.id
}

/** 一套模板配在哪一层：产品通用，还是某个方向专属 */
export type PostTemplateScope = 'product' | 'direction'

export interface ResolvedPostTemplates {
  /** 实际生效的节点 id（方向或产品），没有对应模板时为空串 */
  ownerId: string
  scope: PostTemplateScope | 'none'
  /** 生效的模板列表：方向专属与产品模板不混用 */
  templates: PostTemplate[]
}

/**
 * 取某个方向真正生效的后处理模板。
 *
 * 方向专属模板优先：方向下配了模板就只用它，不再叠产品模板——
 * 两层各配一半再合并会出现「方向模板 + 产品 Logo」这种谁都没设计过的排版。
 * 方向下没配（或配置被删空）才回落到产品模板。
 *
 * 参数名保留 productId 的语义：两者都按节点 id 存，产品与方向各存各的键。
 */
export function resolvePostTemplates(
  templates: Record<string, PostTemplate[]>,
  directions: SopDirectionNode[],
  directionId: string | undefined,
): ResolvedPostTemplates {
  const productId = productIdForDirection(directions, directionId)
  // 任务挂在产品上时不看「方向专属」这一层：那个键就是产品自己的模板
  const ownList = directionId && directionId !== productId ? templates[directionId] ?? [] : []
  if (ownList.length) {
    return { ownerId: directionId ?? '', scope: 'direction', templates: ownList }
  }
  if (!productId) return { ownerId: '', scope: 'none', templates: [] }
  return { ownerId: productId, scope: 'product', templates: templates[productId] ?? [] }
}

/**
 * 元素在成品图上的绘制起点（像素）。
 * 位置可以是负的（这块被推到画布外），画布会自动裁掉露不出来的部分。
 */
export function elementDrawOrigin(el: PostElement, width: number, height: number) {
  return { x: el.x * width, y: el.y * height }
}

function drawElement(
  ctx: CanvasRenderingContext2D,
  el: PostElement,
  width: number,
  height: number,
  logo: HTMLImageElement | null,
  /**
   * 画布相对模板画布的放大倍数。
   *
   * 模板来自灵境，画布基本是 1280×720；而生成图可能是 2560×1440。
   * 位置是 0~1 的比例、会自动跟着画布走，但字号 / 字间距 / 描边是**像素值**，
   * 不乘这个倍数的话，2K 画布上的字只有设计稿的四分之一大。
   */
  scale = 1,
) {
  ctx.save()
  ctx.globalAlpha = el.opacity
  const { x, y } = elementDrawOrigin(el, width, height)

  if (el.kind === 'text') {
    const size = Math.max(8, Math.round(el.fontSize * scale))
    ctx.font = `${el.fontWeight} ${size}px ${POST_FONT_STACK}`
    ctx.fillStyle = el.color
    ctx.textBaseline = 'top'
    ctx.textAlign = el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left'
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    // 字间距：Chromium 支持，老内核没这个属性就跳过，不影响其它绘制
    const spacing = Math.max(0, (el.letterSpacing ?? 0) * scale)
    if (spacing > 0) {
      const ctxWithSpacing = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
      if ('letterSpacing' in ctxWithSpacing) ctxWithSpacing.letterSpacing = `${spacing}px`
    }
    const lines = el.text.split('\n')
    const lineStep = size * elementLineHeight(el)
    lines.forEach((line, index) => {
      const lineY = y + index * lineStep
      if (el.strokeWidth > 0) {
        // canvas 的描边是居中的：线宽加倍后填充盖掉内侧一半，留在外面的正好是 strokeWidth
        ctx.lineWidth = el.strokeWidth * 2 * scale
        ctx.strokeStyle = el.strokeColor
        ctx.strokeText(line, x, lineY)
      }
      ctx.fillText(line, x, lineY)
    })
  } else if (logo) {
    const w = Math.max(8, el.width * width)
    const h = (logo.naturalHeight / logo.naturalWidth) * w || w
    ctx.drawImage(logo, x, y, w, h)
  }

  ctx.restore()
}

/**
 * 画布比模板画布高多少倍。
 *
 * 模板里的位置是 0~1 的比例，跟着画布走；但字号 / 字间距 / 描边是像素值，
 * 必须按这个倍数放大，否则 2560×1440 的画布上字只有设计稿的一半大。
 * 抽出来是为了能直接测（canvas 在测试环境里跑不起来）。
 */
export function postTemplateScale(templateHeight: number, canvasHeight: number): number {
  return templateHeight > 0 && canvasHeight > 0 ? canvasHeight / templateHeight : 1
}

/**
 * 套完模板后画布该多大。
 *
 * 默认 **就是模板画布尺寸**：模板上填的 `1280×720` 是投放平台收片的规格，
 * 交付出去的图必须是这个尺寸。原图可能是 2560×1440（渠道只认它那几个档位），
 * 但成品不能再往下传 2K —— 后台按 1280×720 收，交 2K 会被判「尺寸不符」，
 * 文件也会因为体积上限被二次压缩。
 *
 * 模板上勾了「跟随原图分辨率」（`outputSizeMode === 'source'`）才保留 AI 原图尺寸，
 * 这时字号按 `画布高 / 模板高` 放大，排版比例不变。
 */
export function postCanvasSize(
  template: Pick<PostTemplate, 'width' | 'height' | 'outputSizeMode'>,
  sourceWidth: number,
  sourceHeight: number,
  /**
   * 显式指定成品尺寸（导出的老流程会传）。
   * 传了就以它为准，三处调用口径统一在 `applyPostTemplate` 里。
   */
  override?: { width: number; height: number },
): { width: number; height: number; scale: number; mode: 'template' | 'source' | 'override' } {
  const templateWidth = Math.max(1, Math.round(template.width || 0))
  const templateHeight = Math.max(1, Math.round(template.height || 0))

  if (override && override.width > 0 && override.height > 0) {
    const width = Math.max(1, Math.round(override.width))
    const height = Math.max(1, Math.round(override.height))
    return { width, height, scale: postTemplateScale(templateHeight, height), mode: 'override' }
  }

  if (template.outputSizeMode === 'source' && sourceWidth > 0 && sourceHeight > 0) {
    const width = Math.max(1, Math.round(sourceWidth))
    const height = Math.max(1, Math.round(sourceHeight))
    return { width, height, scale: postTemplateScale(templateHeight, height), mode: 'source' }
  }

  // 模板尺寸本身就是交付规格：字号不用放大（scale = 1），和设计稿 1:1
  return { width: templateWidth, height: templateHeight, scale: 1, mode: 'template' }
}

/**
 * 把原图铺满画布，再叠加模板里的文字与 logo。失败时抛错，调用方负责回退原图。
 *
 * 画布尺寸见 `postCanvasSize`：默认按模板画布（交付规格），
 * 模板勾了「跟随原图」才用 AI 原图分辨率。原图超出画布时按「短边铺满、居中裁切」。
 */
export async function applyPostTemplate(
  dataUrl: string,
  template: PostTemplate,
  outputSize?: { width: number; height: number },
): Promise<string> {
  const source = await loadImage(dataUrl)
  const canvasSize = postCanvasSize(template, source.naturalWidth, source.naturalHeight, outputSize)
  const { width: canvasWidth, height: canvasHeight, scale } = canvasSize
  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)

  const rect = coverRect(source.naturalWidth, source.naturalHeight, canvasWidth, canvasHeight)
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height)

  for (const element of template.elements) {
    // 隐藏的图层不参与合成：参数都在，只是这一版不出它
    if (element.hidden) continue
    let logo: HTMLImageElement | null = null
    if (element.kind === 'logo') {
      if (!element.text) continue
      try {
        logo = await loadImage(element.text)
      } catch {
        continue
      }
    }
    drawElement(ctx, element, canvasWidth, canvasHeight, logo, scale)
  }

  return canvas.toDataURL('image/png')
}
