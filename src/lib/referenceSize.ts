/**
 * 参考图比例 → 该档位基准尺寸。
 *
 * 批量模式一个请求只带一张参考图，尺寸填 auto 时渠道会自己猜画幅，
 * 横竖图混在一起就容易全出成同一个比例。这里直接把参考图的比例换算成
 * 2K 基准尺寸（例如 9:16 → 1440x2560）发给接口，出图比例就跟参考图一致。
 */

import { imageSizeFromDataUrl } from './imageDimensions'
import { calculateImageSize, type SizeTier } from './size'
import { DEFAULT_CAPABILITY, isSizeSupported, maxSizeForRatio, type SizeCapability } from './sizeCapability'

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * 按参考图比例取基准尺寸。
 * 读不出尺寸（非 data URL / 不支持的格式）、比例超出渠道约束、算不出合适尺寸时返回 null，
 * 调用方保持原来的 auto，不要写个错尺寸进去。
 */
export function sizeForReferenceImage(dataUrl: string, tier: SizeTier = '2K'): string | null {
  if (!dataUrl) return null
  const dims = imageSizeFromDataUrl(dataUrl)
  if (!dims) return null

  const width = Math.round(dims.width)
  const height = Math.round(dims.height)
  if (!(width > 0 && height > 0)) return null

  const divisor = gcd(width, height)
  if (!divisor) return null

  // 先约成最简比，calculateImageSize 才能命中常用比例预设（16:9 → 2560x1440）
  const size = calculateImageSize(tier, `${width / divisor}:${height / divisor}`)
  if (!size) return null
  return isSizeSupported(size) ? size : null
}

/**
 * 参考图比例 → 渠道支持得起的**最大**尺寸（4K 优先，不支持就退 2K / 1K）。
 *
 * SOP 模式下上传参考图，画幅基本上就是跟着这张图走的：与其让用户再手动挑一次，
 * 或者干脆留在 auto 让渠道自己猜，不如直接按它的比例取能出的最大尺寸 ——
 * 后续套后处理模板时像素够用，也不会出现「图是竖的、出来是方的」。
 *
 * 读不出尺寸、或比例极端到算不出合适尺寸时返回 null，调用方保持原来的设置。
 */
export function maxSizeForReferenceImage(
  dataUrl: string,
  capability: SizeCapability = DEFAULT_CAPABILITY,
): string | null {
  if (!dataUrl) return null
  const dims = imageSizeFromDataUrl(dataUrl)
  if (!dims) return null

  const width = Math.round(dims.width)
  const height = Math.round(dims.height)
  if (!(width > 0 && height > 0)) return null

  // 约成最简比，maxSizeForRatio 内部才能命中常用比例预设
  const divisor = gcd(width, height)
  if (!divisor) return null

  return maxSizeForRatio(`${width / divisor}:${height / divisor}`, capability)?.size ?? null
}

/**
 * 批量模式下，同批参考图比例不一致时，给每个请求算出自己的尺寸。
 *
 * - 比例都一样（或都读不出来）时返回 null，调用方保持 auto
 * - 有任一张读不出尺寸也返回 null，避免一部分请求被钉死尺寸、另一部分仍走 auto
 * - 注意判断依据是「换算出来的尺寸」而不是原图比例：1280×720 和 1920×1080 都是 16:9，
 *   都换算成 2560×1440，不算混排
 */
export function sizeOverridesForMixedRatios(dataUrls: string[], tier: SizeTier = '2K'): Array<string | undefined> | null {
  if (!dataUrls.length) return null
  const sizes = dataUrls.map((dataUrl) => sizeForReferenceImage(dataUrl, tier))
  if (sizes.some((size) => !size)) return null
  if (new Set(sizes).size <= 1) return null
  return sizes.map((size) => size ?? undefined)
}
