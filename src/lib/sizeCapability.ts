import { calculateImageSize, type SizeTier } from './size'

/** 渠道对尺寸的硬约束 */
export interface SizeCapability {
  /** 短边下限，小于它的尺寸接口会直接拒绝 */
  minEdge: number
  /** 长边上限 */
  maxEdge: number
  /** 说明文案，展示在弹窗里 */
  note: string
}

/**
 * 当前中转站实测结论：
 * 100x100、512x512、3072x3072 返回 400「不允许的图片尺寸」，4096x4096 正常出图。
 * 因此按短边不低于 1024、长边不超过 4096 判定。
 */
export const DEFAULT_CAPABILITY: SizeCapability = {
  minEdge: 1024,
  maxEdge: 4096,
  note: '短边不小于 1024，长边不超过 4096',
}

export function parseSize(size: string): { width: number; height: number } | null {
  const match = size.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/)
  if (!match) return null
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function isSizeSupported(size: string, capability: SizeCapability = DEFAULT_CAPABILITY) {
  const parsed = parseSize(size)
  if (!parsed) return false
  const shortEdge = Math.min(parsed.width, parsed.height)
  const longEdge = Math.max(parsed.width, parsed.height)
  return shortEdge >= capability.minEdge && longEdge <= capability.maxEdge
}

const TIER_ORDER: SizeTier[] = ['4K', '2K', '1K']

/** 某个比例在渠道允许范围内能达到的最大尺寸；全都不支持时返回 null */
export function maxSizeForRatio(ratio: string, capability: SizeCapability = DEFAULT_CAPABILITY) {
  for (const tier of TIER_ORDER) {
    const size = calculateImageSize(tier, ratio)
    if (size && isSizeSupported(size, capability)) return { size, tier }
  }
  return null
}
