import type { TaskParams } from '../types'
import { loadImage } from './canvasImage'

/**
 * 出图后的「限制文件大小」。
 *
 * 面板里原来填的是接口的 output_compression（0-100），那个值只是给模型的建议，
 * 拿不到确定体积；这里改成按 KB 目标在本地重压，压完能确知多少字节。
 *
 * 只对 JPEG / WebP 生效：PNG 是无损的，降画质没意义，唯一能压的手段是缩尺寸，
 * 那会破坏渠道的尺寸要求，所以宁可不动、由界面提示换格式。
 */

/** data URL 的原始字节数：base64 每 4 个字符 3 字节，末尾的 = 是补齐位 */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  if (!dataUrl.slice(0, comma).includes(';base64')) return Math.max(0, dataUrl.length - comma - 1)
  const body = dataUrl.slice(comma + 1)
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding)
}

/** 重压时的画质区间：再低就没法看了，宁可超一点 */
export const SIZE_LIMIT_MIN_QUALITY = 0.3
export const SIZE_LIMIT_MAX_QUALITY = 0.95

/** 这个任务要不要做体积限制：没填、PNG 都不做（PNG 无损，压不下去） */
export function shouldLimitOutputSize(params: TaskParams): boolean {
  if (params.output_format !== 'jpeg' && params.output_format !== 'webp') return false
  const kb = params.max_file_kb
  return typeof kb === 'number' && Number.isFinite(kb) && kb > 0
}

/** 输入框草稿 → KB 上限：空、0、非数字都算「不限」，其余取整并保证 ≥1 */
export function parseSizeLimitKb(draft: string): number | null {
  const trimmed = draft.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return null
  const rounded = Math.round(parsed)
  return rounded >= 1 ? rounded : null
}

export type OutputImageFormat = 'png' | 'jpeg' | 'webp'

/** data URL 实际编码格式；认不出来（blob:、远程 URL）返回 null */
export function dataUrlFormat(dataUrl: string): OutputImageFormat | null {
  const head = dataUrl.slice(0, 32).toLowerCase()
  if (head.startsWith('data:image/png')) return 'png'
  if (head.startsWith('data:image/jpeg') || head.startsWith('data:image/jpg')) return 'jpeg'
  if (head.startsWith('data:image/webp')) return 'webp'
  return null
}

export interface SizeLimitPlan {
  /** 目标字节数 */
  bytes: number
  /** 重编码用的格式 */
  format: 'jpeg' | 'webp'
  /** 上限来自后处理模板：此时 PNG 也要压，转成 WebP */
  fromTemplate: boolean
}

/**
 * 这张图要不要压、压到多少、用哪种编码。
 *
 * 优先级：后处理模板上的 maxFileKb > 输入区「更多 → 限制大小」。
 * 模板是按「渠道 + 尺寸」配的，比全局开关具体得多 —— 同一个全局 KB 值不可能同时满足
 * 竖版大图和方图小图。模板没配才回落到全局值。
 */
export function resolveSizeLimitPlan(
  params: TaskParams,
  templateMaxKb?: number | null,
): SizeLimitPlan | null {
  const templateKb = typeof templateMaxKb === 'number' && Number.isFinite(templateMaxKb) && templateMaxKb > 0
    ? Math.round(templateMaxKb)
    : 0
  if (templateKb > 0) {
    // 模板要求的是「一定不超这个体积」，PNG 无损压不下去，只能转有损编码：
    // 用户明确选了 JPEG 就继续 JPEG，其余（含 PNG、WebP）走 WebP 保住透明通道
    return {
      bytes: templateKb * 1024,
      format: params.output_format === 'jpeg' ? 'jpeg' : 'webp',
      fromTemplate: true,
    }
  }
  if (!shouldLimitOutputSize(params)) return null
  return {
    bytes: Math.round((params.max_file_kb ?? 0) * 1024),
    format: params.output_format === 'webp' ? 'webp' : 'jpeg',
    fromTemplate: false,
  }
}

/**
 * 二分画质找一个能落进 maxBytes 的最高画质。
 * encode 由调用方注入（真机是 canvas，测试是假的），返回 null 表示本来就没超、不用重压。
 */
export async function findQualityWithinBytes(options: {
  currentBytes: number
  maxBytes: number
  encode: (quality: number) => Promise<{ value: string; bytes: number }>
}): Promise<{ value: string; bytes: number; quality: number; fits: boolean } | null> {
  const { currentBytes, maxBytes, encode } = options
  if (currentBytes <= maxBytes) return null

  // 先用最高画质试一次：很多图降一点点就够了，也顺便拿到上界
  const top = await encode(SIZE_LIMIT_MAX_QUALITY)
  if (top.bytes <= maxBytes) return { ...top, quality: SIZE_LIMIT_MAX_QUALITY, fits: true }

  let low = SIZE_LIMIT_MIN_QUALITY
  let high = SIZE_LIMIT_MAX_QUALITY
  let best: { value: string; bytes: number; quality: number } | null = null
  for (let round = 0; round < 6; round += 1) {
    const quality = (low + high) / 2
    const attempt = await encode(quality)
    if (attempt.bytes <= maxBytes) {
      best = { ...attempt, quality }
      low = quality
    } else {
      high = quality
    }
  }
  if (best) return { ...best, fits: true }

  // 最低画质也压不下去：留最小的那一版，由调用方提示超限
  const floor = await encode(SIZE_LIMIT_MIN_QUALITY)
  return { ...floor, quality: SIZE_LIMIT_MIN_QUALITY, fits: false }
}

/** 用 canvas 按指定画质重编码 */
async function encodeWithCanvas(dataUrl: string, format: 'jpeg' | 'webp', quality: number): Promise<string> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  // JPEG 没有透明通道，透明像素会变黑，先铺白底
  if (format === 'jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(image, 0, 0)
  return canvas.toDataURL(`image/${format}`, quality)
}

/** 把单张图压到 maxBytes 内；fits 为 false 表示最低画质也压不进去 */
export async function limitDataUrlSize(
  dataUrl: string,
  format: 'jpeg' | 'webp',
  maxBytes: number,
): Promise<{ dataUrl: string; fits: boolean }> {
  const result = await findQualityWithinBytes({
    currentBytes: dataUrlByteSize(dataUrl),
    maxBytes,
    encode: async (quality) => {
      const value = await encodeWithCanvas(dataUrl, format, quality)
      return { value, bytes: dataUrlByteSize(value) }
    },
  })
  if (!result) return { dataUrl, fits: true }
  if (!result.fits) {
    console.warn(`限制大小：最低画质仍有 ${Math.round(result.bytes / 1024)}KB，超过 ${Math.round(maxBytes / 1024)}KB`)
  }
  return { dataUrl: result.value, fits: result.fits }
}
