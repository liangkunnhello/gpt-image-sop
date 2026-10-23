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
/** 从小到大：找「够用的最小尺寸」时按这个顺序试 */
const TIER_ORDER_ASC: SizeTier[] = ['1K', '2K', '4K']

/** 某个比例在渠道允许范围内能达到的最大尺寸；全都不支持时返回 null */
export function maxSizeForRatio(ratio: string, capability: SizeCapability = DEFAULT_CAPABILITY) {
  for (const tier of TIER_ORDER) {
    const size = calculateImageSize(tier, ratio)
    if (size && isSizeSupported(size, capability)) return { size, tier }
  }
  return null
}

/**
 * 找一个「同比例、不比目标小、渠道又支持」的尺寸。
 * 按 1K → 2K → 4K 升序取第一个够用的，尽量少花分辨率预算。
 * 找不到（比例太极端、或目标本身就超过长边上限）时返回 null。
 */
export function upscaleSizeForSize(size: string, capability: SizeCapability = DEFAULT_CAPABILITY) {
  const parsed = parseSize(size)
  if (!parsed || parsed.width <= 0 || parsed.height <= 0) return null
  for (const tier of TIER_ORDER_ASC) {
    const candidate = calculateImageSize(tier, `${parsed.width}:${parsed.height}`)
    if (!candidate) continue
    const target = parseSize(candidate)
    if (!target) continue
    if (!isSizeSupported(candidate, capability)) continue
    // 两个方向都不能比用户设的小，否则就是「缩小生成再放大」，画质只会更差
    if (target.width < parsed.width || target.height < parsed.height) continue
    return candidate
  }
  return null
}

/** 一次出图的尺寸计划 */
export interface GenerationSizePlan {
  /** 真正发给接口的尺寸 */
  requestSize: string
  /** 成品要落成的尺寸，也就是用户在输入框里设的那个 */
  targetSize: string
  /** true 表示走了「按更大尺寸生成 → 再缩回目标尺寸」 */
  scaled: boolean
}

/**
 * 规划出图尺寸：渠道不支持用户设的尺寸时，先按同比例更大的尺寸生成，拿到图再缩回目标尺寸，
 * 这样界面上任何尺寸都能用，不用再把不支持的比例灰掉。
 *
 * 有后处理模板时不做这件事：模板里的字号、Logo 宽度都是按成品像素写死的，
 * 先生成大图再缩小会让模板错位，所以那种情况仍然只认渠道支持的尺寸。
 */
export function planGenerationSize(
  size: string | undefined,
  options: { postProcess?: boolean; capability?: SizeCapability; allowResize?: boolean } = {},
): GenerationSizePlan {
  const target = String(size ?? '').trim()
  const keep = (value: string): GenerationSizePlan => ({ requestSize: value, targetSize: value, scaled: false })
  if (!target || target === 'auto') return keep(target)

  const capability = options.capability ?? DEFAULT_CAPABILITY
  if (isSizeSupported(target, capability)) return keep(target)
  if (options.postProcess) return keep(target)
  // Codex CLI 只认 1K，放大反而会让提示词里的尺寸和实际出图对不上
  if (options.allowResize === false) return keep(target)

  const upscaled = upscaleSizeForSize(target, capability)
  if (!upscaled) return keep(target)
  return { requestSize: upscaled, targetSize: target, scaled: true }
}
