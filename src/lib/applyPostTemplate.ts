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

function drawElement(ctx: CanvasRenderingContext2D, el: PostElement, width: number, height: number, logo: HTMLImageElement | null) {
  ctx.save()
  ctx.globalAlpha = el.opacity
  const { x, y } = elementDrawOrigin(el, width, height)

  if (el.kind === 'text') {
    const size = Math.max(8, Math.round(el.fontSize))
    ctx.font = `${el.fontWeight} ${size}px ${POST_FONT_STACK}`
    ctx.fillStyle = el.color
    ctx.textBaseline = 'top'
    ctx.textAlign = el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left'
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    // 字间距：Chromium 支持，老内核没这个属性就跳过，不影响其它绘制
    const spacing = Math.max(0, el.letterSpacing ?? 0)
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
        ctx.lineWidth = el.strokeWidth * 2
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
 * 把原图按模板尺寸裁切铺满，再叠加模板里的文字与 logo。
 * 失败时抛错，调用方负责回退原图。
 */
export async function applyPostTemplate(dataUrl: string, template: PostTemplate): Promise<string> {
  const source = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = template.width
  canvas.height = template.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, template.width, template.height)

  const rect = coverRect(source.naturalWidth, source.naturalHeight, template.width, template.height)
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
    drawElement(ctx, element, template.width, template.height, logo)
  }

  return canvas.toDataURL('image/png')
}
