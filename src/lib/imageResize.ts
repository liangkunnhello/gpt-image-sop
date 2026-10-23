import { loadImage } from './canvasImage'
import { imageSizeFromDataUrl } from './imageDimensions'

/**
 * 「按大尺寸生成、再缩回目标尺寸」用到的缩放工具。
 *
 * 渠道对尺寸有硬性下限（短边 ≥ 1024），像 720×1280 这种小图直接请求会被 400。
 * 现在的做法是先按同比例更大的尺寸出图（1440×2560），拿到图在本地缩到用户设的尺寸，
 * 于是界面上所有尺寸都能选。
 */

export interface PixelSize {
  width: number
  height: number
}

/** 允许的宽高比误差：超过这个值说明接口没按要求的比例出图，硬拉会变形，宁可不动 */
export const RESIZE_RATIO_TOLERANCE = 0.02

export function parsePixelSize(size: string): PixelSize | null {
  const match = String(size).match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!(width > 0 && height > 0)) return null
  return { width, height }
}

/**
 * 判断要不要缩、缩到多少。返回 null 表示原样保留。
 * 比例差太多就不动：宁可留着接口给的图，也不要拉变形的图交出去。
 */
export function planDownscale(actual: PixelSize, target: PixelSize): PixelSize | null {
  if (!(actual.width > 0 && actual.height > 0) || !(target.width > 0 && target.height > 0)) return null
  if (actual.width === target.width && actual.height === target.height) return null
  const actualRatio = actual.width / actual.height
  const targetRatio = target.width / target.height
  if (Math.abs(actualRatio - targetRatio) / targetRatio > RESIZE_RATIO_TOLERANCE) return null
  return { width: Math.round(target.width), height: Math.round(target.height) }
}

/** 按原图格式决定重编码格式：PNG 保持无损，JPEG / WebP 给个较高的画质 */
function targetMimeType(dataUrl: string) {
  const match = dataUrl.slice(0, 64).match(/^data:([^;,]+)/i)
  const type = match?.[1]?.toLowerCase() ?? ''
  if (type.includes('png')) return { type: 'image/png', quality: undefined }
  if (type.includes('webp')) return { type: 'image/webp', quality: 0.95 }
  return { type: 'image/jpeg', quality: 0.95 }
}

/**
 * 把 data URL 缩到目标像素。
 * 失败（拿不到画布、图片读不出来）时原样返回，让流程继续，不至于因为缩图把整批出图搞崩。
 */
export async function resizeDataUrlToSize(dataUrl: string, target: PixelSize): Promise<string> {
  const actual = imageSizeFromDataUrl(dataUrl)
  if (!actual) return dataUrl
  const plan = planDownscale(actual, target)
  if (!plan) return dataUrl

  try {
    const image = await loadImage(dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = plan.width
    canvas.height = plan.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, plan.width, plan.height)
    const { type, quality } = targetMimeType(dataUrl)
    return canvas.toDataURL(type, quality)
  } catch (err) {
    console.warn('缩小成品尺寸失败，已保留接口返回的原图', err)
    return dataUrl
  }
}
