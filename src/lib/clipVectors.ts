import { readLocal, writeLocal } from './localRecord'

/**
 * 图像向量指纹库：把每张成品图的 CLIP 向量攒在本机，新图直接和「全部历史图」比。
 *
 * 为什么需要它：按「同方向 / 同卡」比，只能发现这一批里的撞车；跨批次（上个月的同方向、
 * 去年同一产品的爆款）看不出重复。有了向量库，新图一出来就能跟全库比一次。
 *
 * 存储：int8 量化 + base64，512 维只占 512 字节（base64 后约 684 字符）。
 * 不塞进 zustand persist —— 那份 state 每次改动都要整份序列化，几千张会拖死界面；
 * 这里单独一个 key，交给 tauriStorage / localStorage，按批防抖落盘。
 */

const STORAGE_KEY = 'gpt-image-clip-vectors'
/** 向量来源版本：模型或预处理变了要整体作废重算 */
export const VECTOR_VERSION = 'clip-vit-b32-int8-v1'
/** 最多保留多少张：再多也只是占空间，老图很少拿来比 */
export const MAX_VECTORS = 20000
/** 落盘防抖：出图是批量来的，逐张写会把 storage 写爆 */
const FLUSH_DELAY = 1200

interface VectorRecord {
  /** int8 量化后的向量，base64 */
  v: string
  /** 量化前的范数，算余弦时要除回来 */
  n: number
  /** 写进来的时间，超出上限时按它淘汰最老的 */
  t: number
}

interface StoredShape {
  version: string
  items: Record<string, VectorRecord>
}

let cache: Map<string, { vec: Int8Array; norm: number }> | null = null
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function load(): Map<string, { vec: Int8Array; norm: number }> {
  if (cache) return cache
  cache = new Map()
  try {
    const raw = readLocal(STORAGE_KEY)
    if (!raw) return cache
    const parsed = JSON.parse(raw) as StoredShape
    if (parsed?.version !== VECTOR_VERSION || !parsed.items) return cache
    for (const [imageId, record] of Object.entries(parsed.items)) {
      const vec = decodeBase64ToInt8(record.v)
      if (vec) cache.set(imageId, { vec, norm: record.n || vectorNorm(vec) })
    }
  } catch (err) {
    console.warn('读取图像向量库失败，按空库处理：', err)
  }
  return cache
}

function scheduleFlush() {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushClipVectors()
  }, FLUSH_DELAY)
}

/** 立刻落盘；退出前也会调它 */
export function flushClipVectors() {
  if (!dirty || !cache) return
  dirty = false
  try {
    const items: Record<string, VectorRecord> = {}
    // 超出上限时淘汰最老的：Map 按插入顺序迭代，先进先出即可
    const entries = [...cache.entries()]
    const keep = entries.length > MAX_VECTORS ? entries.slice(entries.length - MAX_VECTORS) : entries
    for (const [imageId, item] of keep) {
      items[imageId] = { v: encodeInt8ToBase64(item.vec), n: item.norm, t: Date.now() }
    }
    writeLocal(STORAGE_KEY, JSON.stringify({ version: VECTOR_VERSION, items }))
  } catch (err) {
    console.warn('保存图像向量库失败：', err)
  }
}

/**
 * int8 → base64。
 * 注意要按无符号字节写：int8 有负数，直接 fromCharCode 会得到非法字符、btoa 直接抛
 * InvalidCharacterError（踩过一次）。这里统一 & 0xff 存，读的时候再还原符号。
 */
function encodeInt8ToBase64(vec: Int8Array): string {
  const bytes = new Uint8Array(vec.length)
  for (let i = 0; i < vec.length; i += 1) bytes[i] = vec[i] & 0xff
  let text = ''
  // 分块拼接，避免超长数组用 apply 爆栈
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(text)
}

function decodeBase64ToInt8(text: string): Int8Array | null {
  try {
    const binary = atob(text)
    const out = new Int8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      // 无符号字节还原回 int8：>=128 的是负数
      const bite = binary.charCodeAt(i)
      out[i] = bite >= 128 ? bite - 256 : bite
    }
    return out
  } catch {
    return null
  }
}

function vectorNorm(vec: Int8Array): number {
  let sum = 0
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i]
  return Math.sqrt(sum) || 1
}

/** 把浮点向量量化成 int8（×127），与 Python 侧同一口径 */
export function quantizeVector(values: number[]): { base64: string; norm: number } | null {
  if (!values.length) return null
  const vec = new Int8Array(values.length)
  for (let i = 0; i < values.length; i += 1) {
    const q = Math.round(values[i] * 127)
    vec[i] = q > 127 ? 127 : q < -127 ? -127 : q
  }
  return { base64: encodeInt8ToBase64(vec), norm: vectorNorm(vec) }
}

/** 写入/更新一张图的向量 */
export function putClipVector(imageId: string, base64: string, norm?: number) {
  if (!imageId || !base64) return
  const map = load()
  const vec = decodeBase64ToInt8(base64)
  if (!vec) return
  map.set(imageId, { vec, norm: norm || vectorNorm(vec) })
  scheduleFlush()
}

export function hasClipVector(imageId: string): boolean {
  return load().has(imageId)
}

/** 库里有多少张有向量；count 里可以排除某几张 */
export function clipVectorCount(exclude?: Iterable<string>): number {
  const map = load()
  if (!exclude) return map.size
  const skip = new Set(exclude)
  let total = 0
  for (const id of map.keys()) if (!skip.has(id)) total += 1
  return total
}

export function listClipVectorIds(): string[] {
  return [...load().keys()]
}

export function removeClipVector(imageId: string) {
  const map = load()
  if (!map.delete(imageId)) return
  scheduleFlush()
}

/** 批量清理：图被彻底删掉时顺手清掉它的向量，避免库越攒越虚 */
export function removeClipVectors(imageIds: Iterable<string>) {
  const map = load()
  let changed = false
  for (const id of imageIds) {
    if (map.delete(id)) changed = true
  }
  if (changed) scheduleFlush()
}

export interface VectorMatch {
  /** 与全库最像的那张的余弦相似度 */
  max: number
  /** 与全库所有图相似度的均值 */
  mean: number
  /** 最像的那张的图片 id */
  nearest?: string
  /** 参与比对的历史图数量（不含自己） */
  count: number
}

/**
 * 拿这张图的向量和全库比。
 *
 * 评分口径与「同方向」那套一致：max 就是展示的重复度，mean 是平均撞车程度。
 * 全库几万张也只是一次线性扫描（512 字节点积），比调模型快几个数量级。
 */
export function matchAgainstLibrary(imageId: string, skip?: Iterable<string>): VectorMatch | null {
  const map = load()
  const self = map.get(imageId)
  if (!self) return null
  const skipSet = new Set(skip ?? [])
  skipSet.add(imageId)

  // 初值给 -1 而不是 0：两张正交的图余弦正好是 0，从 0 起算会漏掉「最近的就是它」
  let max = -1
  let sum = 0
  let count = 0
  let nearest: string | undefined
  for (const [otherId, other] of map) {
    if (skipSet.has(otherId)) continue
    if (other.vec.length !== self.vec.length) continue
    const cos = cosine(self, other)
    sum += cos
    count += 1
    if (cos > max) {
      max = cos
      nearest = otherId
    }
  }
  if (!count) return null
  return { max, mean: sum / count, nearest, count }
}

function cosine(a: { vec: Int8Array; norm: number }, b: { vec: Int8Array; norm: number }): number {
  let dot = 0
  const av = a.vec
  const bv = b.vec
  for (let i = 0; i < av.length; i += 1) dot += av[i] * bv[i]
  const denom = a.norm * b.norm
  return denom ? dot / denom : 0
}

/** 单测用：清空内存与本地记录 */
export function __resetClipVectorsForTest() {
  // 必须是 null 而不是空 Map：空 Map 会让 load() 直接返回它，不从本地存储重读
  cache = null
  dirty = false
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
