import type { SopDirectionNode } from '../types'
import { POST_FONT_STACK, coverRect, type PostElement, type PostTemplate } from './postTemplate'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

/** 方向节点 → 所属产品 id（模板挂在产品上） */
export function productIdForDirection(
  directions: SopDirectionNode[],
  directionId: string | undefined,
): string {
  if (!directionId) return ''
  const node = directions.find((item) => item.id === directionId)
  if (!node) return ''
  return node.kind === 'direction' ? node.parentId ?? '' : node.id
}

function drawElement(ctx: CanvasRenderingContext2D, el: PostElement, width: number, height: number, logo: HTMLImageElement | null) {
  ctx.save()
  ctx.globalAlpha = el.opacity
  const x = el.x * width
  const y = el.y * height

  if (el.kind === 'text') {
    const size = Math.max(8, Math.round(el.fontSize))
    ctx.font = `${el.fontWeight} ${size}px ${POST_FONT_STACK}`
    ctx.fillStyle = el.color
    ctx.textBaseline = 'top'
    ctx.textAlign = el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left'
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    const lines = el.text.split('\n')
    lines.forEach((line, index) => {
      const lineY = y + index * size * 1.35
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
