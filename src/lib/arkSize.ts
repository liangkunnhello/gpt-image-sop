/**
 * 火山方舟 Seedream 4.5 的尺寸规则。
 *
 * 和 OpenAI 那套不一样，4.5 有**硬性像素下限**：
 * - 总像素必须 ≥ 3,686,400（约 2K）
 * - 总像素 ≤ 16,777,216（4096×4096）
 * - 宽高比在 1/16 ~ 16 之间
 *
 * 所以项目里 2K 档的 1536×2048（3:4，314 万像素）这类尺寸**会被接口直接拒绝**，
 * 不能原样发过去。这里按原比例把它放大到合法范围，比例不变 ——
 * 套后处理模板时靠的就是比例，比例不能动。
 */

/** 4.5 的最小总像素 */
export const ARK_MIN_PIXELS = 3_686_400
/** 4.5 的最大总像素 */
export const ARK_MAX_PIXELS = 16_777_216
/** 宽高比上下限 */
export const ARK_MIN_RATIO = 1 / 16
export const ARK_MAX_RATIO = 16
/**
 * auto 时用的档位。
 *
 * 档位只决定分辨率，长宽比由模型按提示词自己挑 ——
 * 项目里选 auto 本来就是「让渠道定」，这样处理最接近原意。
 */
export const ARK_AUTO_SIZE = '2K'

/**
 * 官方推荐的常用尺寸（都满足 4.5 的像素下限）。
 *
 * 优先用这些而不是硬算：等比缩放会得到 1664×2218 这种「合法但不标准」的尺寸，
 * 既不是官方示例，比例也会有零点几的偏差。能对上比例就直接用标准尺寸。
 */
const ARK_STANDARD_SIZES: Array<{ ratio: number; width: number; height: number }> = [
  { ratio: 1, width: 2048, height: 2048 },
  { ratio: 16 / 9, width: 2560, height: 1440 },
  { ratio: 9 / 16, width: 1440, height: 2560 },
  { ratio: 4 / 3, width: 2304, height: 1728 },
  { ratio: 3 / 4, width: 1728, height: 2304 },
  { ratio: 3 / 2, width: 2496, height: 1664 },
  { ratio: 2 / 3, width: 1664, height: 2496 },
  { ratio: 21 / 9, width: 3024, height: 1296 },
] as const
/** 比例容差：3:4 与 0.75 完全相等，但 21:9 之类带小数的比例需要一点余地 */
const ARK_STANDARD_RATIO_TOLERANCE = 0.02

/** 比例能对上标准尺寸时返回标准尺寸，否则 null */
function matchStandardSize(width: number, height: number): { width: number; height: number } | null {
  const ratio = width / height
  const hit = ARK_STANDARD_SIZES.find((item) => Math.abs(item.ratio - ratio) / item.ratio <= ARK_STANDARD_RATIO_TOLERANCE)
  return hit ? { width: hit.width, height: hit.height } : null
}

/** 解析 "2048x1536"（容忍大写 X 与空格） */
export function parseArkSize(size: string): { width: number; height: number } | null {
  const match = String(size ?? '').trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

/** 宽高比是否在允许范围（含端点） */
export function isArkRatioAllowed(width: number, height: number): boolean {
  const ratio = width / height
  return ratio >= ARK_MIN_RATIO && ratio <= ARK_MAX_RATIO
}

/** 这个尺寸能不能原样发给 4.5 */
export function isArkSizeValid(width: number, height: number): boolean {
  const pixels = width * height
  return pixels >= ARK_MIN_PIXELS
    && pixels <= ARK_MAX_PIXELS
    && isArkRatioAllowed(width, height)
}

/** 取偶数：编码器对奇数宽高更挑剔，差 1 像素没有意义 */
function toEven(value: number): number {
  const rounded = Math.round(value)
  return rounded % 2 === 0 ? rounded : rounded + 1
}

/**
 * 宽高比超出 1/16~16 时先收进边界，再等比缩放。
 * 极端长条（比如 20:1 的横幅）本来就该被截到 16:1，否则接口直接拒。
 */
function clampRatio(width: number, height: number): { width: number; height: number } {
  const ratio = width / height
  if (ratio > ARK_MAX_RATIO) return { width: height * ARK_MAX_RATIO, height }
  if (ratio < ARK_MIN_RATIO) return { width: height * ARK_MIN_RATIO, height }
  return { width, height }
}

/**
 * 把项目里的尺寸换算成 4.5 能接的尺寸。
 *
 * - 本来就合法 → 原样返回（只统一成小写 x）
 * - 小于下限 → 等比放大到刚好达标（比例不变）
 * - 大于上限 → 等比缩小
 * - auto / 解析不了 → 用 2K 档位，让模型自己定比例
 */
export function toArkSize(size: string): string {
  const parsed = parseArkSize(size)
  if (!parsed) return ARK_AUTO_SIZE

  const base = clampRatio(parsed.width, parsed.height)
  if (isArkSizeValid(base.width, base.height)) {
    return `${toEven(base.width)}x${toEven(base.height)}`
  }

  // 比例能对上官方标准尺寸就直接用：比硬算出来的像素更规整
  const standard = matchStandardSize(base.width, base.height)
  if (standard) return `${standard.width}x${standard.height}`

  const pixels = base.width * base.height
  const targetPixels = Math.min(ARK_MAX_PIXELS, Math.max(ARK_MIN_PIXELS, pixels))
  // 先按目标像素给出理论缩放比，再逐步微调：取整和偶数化会让实际像素偏离目标，
  // 死循环风险用固定次数上限兜住
  let scale = Math.sqrt(targetPixels / pixels)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const width = Math.max(2, toEven(base.width * scale))
    const height = Math.max(2, toEven(base.height * scale))
    if (isArkSizeValid(width, height)) return `${width}x${height}`
    // 差一点点就能进区间，按方向微调 0.5%；比例几乎不变
    scale *= width * height < ARK_MIN_PIXELS ? 1.005 : 0.995
  }

  // 极端比例怎么调都不合适时退回档位：至少能出图，不至于整批失败
  return ARK_AUTO_SIZE
}

/**
 * 换算后和原始尺寸是否有差异 —— 给界面提示用
 * （用户选了 1536×2048，实际出图是 1728×2304，得让人知道）。
 */
export function arkSizeWasAdjusted(size: string): boolean {
  const parsed = parseArkSize(size)
  if (!parsed) return false
  return toArkSize(size) !== `${parsed.width}x${parsed.height}`
}

/**
 * 输入区那句尺寸提示。
 *
 * 用户选 1536×2048 却拿到 1728×2304 时必须能看到原因，
 * 否则会以为是 bug（或者以为比例错了，不敢套后处理模板）。
 */
export function arkSizeHint(size: string): string {
  const parsed = parseArkSize(size)
  if (!parsed) {
    return '火山方舟（Seedream）按 2K 档位出图，长宽比由模型按提示词决定'
  }
  if (!arkSizeWasAdjusted(size)) return ''
  const converted = toArkSize(size)
  return `火山方舟最小要 ${Math.round(ARK_MIN_PIXELS / 10000)} 万像素，实际按 ${converted.replace('x', '×')} 生成（比例不变）`
}
