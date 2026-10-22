/**
 * 普通模式（不使用 SOP / 变量）的请求分组。
 *
 * 这里把「数量」当作请求次数，而不是单次请求里要几张图：
 * - 批量：每个请求 1 张变量图，数量不够时循环取图；固定图不参与
 * - 融图：数量 1 时所有图放同一个请求；数量 N 时把变量图切成 N 组，
 *   每组再带上全部固定图（固定图每个请求都出现）
 *
 * 无论哪种模式，每个请求都只生成 1 张图。
 */

import type { InputImage } from '../types'

export type PlainImageMode = 'merge' | 'batch'

export interface PlainRequestPlan {
  /** 这个请求要带的参考图，顺序就是变量图在前、固定图在后 */
  images: InputImage[]
}

export interface PlainPlanOptions {
  mode: PlainImageMode
  /** 生成数量，也就是请求次数 */
  count: number
  variableImages: InputImage[]
  fixedImages: InputImage[]
}

/**
 * 返回 null 表示没有可用的参考图，调用方应退回原来的单请求（或纯文生图）逻辑。
 */
export function planPlainRequests({
  mode,
  count,
  variableImages,
  fixedImages,
}: PlainPlanOptions): PlainRequestPlan[] | null {
  const requests = Math.max(1, Math.floor(count) || 1)

  if (mode === 'batch') {
    // 批量模式下每张图都算变量图；只剩固定图时也当变量图用，避免放了图却不发
    const pool = variableImages.length ? variableImages : fixedImages
    if (!pool.length) return null
    return Array.from({ length: requests }, (_, index) => ({
      images: [pool[index % pool.length]],
    }))
  }

  if (!variableImages.length && !fixedImages.length) return null
  // 数量 1：所有图放进同一个请求，就是原来「融图」的行为
  if (requests === 1) return [{ images: [...variableImages, ...fixedImages] }]

  if (!variableImages.length) {
    // 只有固定图时，每个请求带同一组
    return Array.from({ length: requests }, () => ({ images: [...fixedImages] }))
  }

  // 变量图平均分给每个请求；除不尽时按循环补，保证每组张数一致
  const perRequest = Math.ceil(variableImages.length / requests)
  return Array.from({ length: requests }, (_, index) => {
    const images: InputImage[] = []
    for (let offset = 0; offset < perRequest; offset += 1) {
      images.push(variableImages[(index * perRequest + offset) % variableImages.length])
    }
    return { images: [...images, ...fixedImages] }
  })
}
