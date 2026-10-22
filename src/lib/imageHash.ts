/**
 * 感知哈希（pHash）：给「重复度」在没有本地 CLIP 服务的环境（桌面安装版）兜底。
 *
 * 口径说明：CLIP 比的是语义，pHash 比的是画面结构。
 * 同一张图轻微改色、加字、压缩、裁边后仍然高度相似；
 * 但「换了构图、同一主题」的两张图 pHash 不会给高分。
 * 所以它只能当「画面近似度」看，数值不能和 CLIP 直接混用。
 */

/** 灰度高宽：先缩到 64×64 再做 DCT。尺寸大一点，取低频时占比更小、更抗噪 */
export const HASH_SAMPLE = 64
/**
 * 取左上角 8×8 个低频系数 → 64 位。
 * 不取 16×16 是因为更高频的系数大量接近 0，浮点误差会让 bit 随机翻转，
 * 同一张图缩放过就会算出明显不同的哈希。
 */
export const HASH_LOW = 8
/** 一位对应的 bit 数 */
const BITS_PER_HEX = 4

/** 预计算 DCT 余弦表：cos[x][u] = cos((2x+1)·u·π / 2N) */
const COS: number[][] = Array.from({ length: HASH_SAMPLE }, (_, x) =>
  Array.from({ length: HASH_LOW }, (_, u) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * HASH_SAMPLE))),
)

/**
 * 灰度像素 → 64 位哈希（hex 字符串，16 个字符）。
 *
 * 两个稳定化处理：
 * 1. 先减掉均值，整体加亮/压暗不会改变任何系数的符号；
 * 2. 用可分离 DCT 只取左上 8×8 低频，避开大量接近 0 的高频系数 ——
 *    这些系数一有浮点误差就会翻转 bit，是 pHash 不稳的主要来源。
 */
export function hashFromPixels(pixels: number[]): string {
  const n = HASH_SAMPLE
  if (pixels.length !== n * n) throw new Error(`需要 ${n}×${n} 的灰度像素`)

  const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length

  // 行变换：rowDct[y][u]
  const rowDct: number[][] = []
  for (let y = 0; y < n; y += 1) {
    const row: number[] = []
    for (let u = 0; u < HASH_LOW; u += 1) {
      let sum = 0
      for (let x = 0; x < n; x += 1) sum += (pixels[y * n + x] - mean) * COS[x][u]
      row.push(sum)
    }
    rowDct.push(row)
  }

  // 列变换：coef[v][u]
  const coef: number[] = []
  for (let v = 0; v < HASH_LOW; v += 1) {
    for (let u = 0; u < HASH_LOW; u += 1) {
      let sum = 0
      for (let y = 0; y < n; y += 1) sum += rowDct[y][u] * COS[y][v]
      coef.push(sum)
    }
  }

  // 以中位数做阈值，避免整体明暗影响判定
  const sorted = [...coef].sort((a, b) => a - b)
  const mid = (sorted[coef.length / 2 - 1] + sorted[coef.length / 2]) / 2
  const bits = coef.map((value) => (value > mid ? '1' : '0')).join('')

  let hex = ''
  for (let i = 0; i < bits.length; i += BITS_PER_HEX) {
    hex += parseInt(bits.slice(i, i + BITS_PER_HEX), 2).toString(16)
  }
  return hex
}

function popcount(value: number): number {
  let count = 0
  let v = value
  while (v) {
    v &= v - 1
    count += 1
  }
  return count
}

/** 两个 hex 哈希的汉明距离 */
export function hammingDistance(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  let distance = 0
  for (let i = 0; i < length; i += 1) {
    distance += popcount(parseInt(a[i], 16) ^ parseInt(b[i], 16))
  }
  // 长度不一致时（理论上不会发生）把缺的部分按全不同算
  return distance + Math.abs(a.length - b.length) * BITS_PER_HEX
}

/** 相似度 0~1：同图为 1，完全不相关接近 0 */
export function similarityFromHashes(a: string, b: string): number {
  const bits = Math.max(a.length, b.length) * BITS_PER_HEX
  if (!bits) return 0
  return Math.max(0, 1 - hammingDistance(a, b) / bits)
}

export interface HashScore {
  /** 与其余各张的平均相似度 */
  mean: number
  /** 与最像那张的相似度 */
  max: number
  nearest?: string
}

/**
 * 两两比对，返回每张图的平均 / 最高相似度。
 * 结构与后端 CLIP 的 perImage 一致，调用方不用区分来源。
 * 少于两张时返回空对象 —— 没有可比对象，硬给 100% 反而误导。
 */
export function hashScores(entries: Array<{ key: string; hash: string }>): Record<string, HashScore> {
  const out: Record<string, HashScore> = {}
  if (entries.length < 2) return out

  for (const item of entries) {
    let sum = 0
    let max = -1
    let nearest = ''
    let count = 0
    for (const other of entries) {
      if (other.key === item.key) continue
      const value = similarityFromHashes(item.hash, other.hash)
      sum += value
      count += 1
      if (value > max) {
        max = value
        nearest = other.key
      }
    }
    out[item.key] = { mean: count ? sum / count : 0, max: max < 0 ? 0 : max, nearest }
  }
  return out
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

/** 读图 → 缩到 32×32 → 灰度 → 哈希；任何环节失败返回 null，由调用方跳过 */
export async function computeImageHash(dataUrl: string): Promise<string | null> {
  try {
    const image = await loadImage(dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = HASH_SAMPLE
    canvas.height = HASH_SAMPLE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    // 先铺白底：透明 PNG 的 alpha 不参与计算，避免整张被判成纯黑
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, HASH_SAMPLE, HASH_SAMPLE)
    ctx.drawImage(image, 0, 0, HASH_SAMPLE, HASH_SAMPLE)
    const { data } = ctx.getImageData(0, 0, HASH_SAMPLE, HASH_SAMPLE)
    const gray: number[] = new Array(HASH_SAMPLE * HASH_SAMPLE)
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    }
    return hashFromPixels(gray)
  } catch {
    return null
  }
}
