import { create } from 'zustand'

import type { TaskRecord } from '../types'
import { ensureImageCached } from './imageCache'

const SIDECAR = 'http://127.0.0.1:7799'
/** 一次最多送多少张去算，太多会很慢 */
const MAX_IMAGES = 36
/** 送给 CLIP 前先缩到这个边长，既快又不影响判断 */
const THUMB_SIZE = 384

export interface ClipScore {
  /** 与同批其他图的平均相似度 */
  mean: number
  /** 与最像的那张的相似度，作为「重复度」展示 */
  max: number
  nearest?: string
}

interface ClipState {
  scores: Record<string, ClipScore>
  running: boolean
  error: string
  limit: number
  ensure: (tasks: TaskRecord[]) => void
  scoreOfTask: (task: TaskRecord) => number | null
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = src
  })
}

async function toThumb(dataUrl: string): Promise<string | null> {
  try {
    const image = await loadImage(dataUrl)
    const longest = Math.max(image.naturalWidth, image.naturalHeight)
    const scale = longest > THUMB_SIZE ? THUMB_SIZE / longest : 1
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    return null
  }
}

export const useClipStore = create<ClipState>()((set, get) => ({
  scores: {},
  running: false,
  error: '',
  limit: 0.92,

  /** 对还没算过的任务图做一次 CLIP 相似度，结果按图片 id 缓存 */
  ensure: (tasks: TaskRecord[]) => {
    if (get().running) return
    const { scores } = get()
    const candidates: Array<{ imageId: string }> = []
    for (const task of tasks) {
      if (task.status !== 'done') continue
      for (const imageId of task.outputImages) {
        if (scores[imageId]) continue
        if (candidates.some((item) => item.imageId === imageId)) continue
        candidates.push({ imageId })
        if (candidates.length >= MAX_IMAGES) break
      }
      if (candidates.length >= MAX_IMAGES) break
    }
    if (candidates.length < 2) return

    set({ running: true, error: '' })
    void (async () => {
      try {
        const payload: Array<{ index: number; dataUrl: string }> = []
        for (let i = 0; i < candidates.length; i += 1) {
          const dataUrl = await ensureImageCached(candidates[i].imageId)
          if (!dataUrl) continue
          const thumb = await toThumb(dataUrl)
          if (thumb) payload.push({ index: i, dataUrl: thumb })
        }
        if (payload.length < 2) throw new Error('可用的图片不足两张')

        const res = await fetch(`${SIDECAR}/api/clip-similar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            limit: get().limit,
            items: payload.map((item) => ({ dataUrl: item.dataUrl })),
          }),
          signal: AbortSignal.timeout(180000),
        })
        const json = await res.json() as {
          ok?: boolean
          error?: string
          limit?: number
          perImage?: Record<string, { mean: number; max: number; nearest?: string }>
        }
        if (!json?.ok || !json.perImage) throw new Error(json?.error || 'CLIP 没有返回结果')

        const next: Record<string, ClipScore> = { ...get().scores }
        for (const [indexText, score] of Object.entries(json.perImage)) {
          const index = Number(indexText)
          const imageId = payload[index] ? candidates[payload[index].index].imageId : ''
          if (!imageId) continue
          // 服务端返回的 nearest 是临时文件名（0.png），换回图片 id
          const nearestIndex = score.nearest ? Number(String(score.nearest).replace(/\.[a-z]+$/i, '')) : NaN
          const nearest = payload[nearestIndex] ? candidates[payload[nearestIndex].index].imageId : undefined
          next[imageId] = { mean: score.mean, max: score.max, nearest }
        }
        set({ scores: next, running: false, limit: json.limit ?? get().limit })
      } catch (err) {
        set({ running: false, error: err instanceof Error ? err.message : 'CLIP 计算失败' })
      }
    })()
  },

  /** 任务的平均重复度：它自己几张图的重复度取平均；一张都没算出来返回 null */
  scoreOfTask: (task: TaskRecord) => {
    const { scores } = get()
    const values = task.outputImages.map((id) => scores[id]?.max).filter((v): v is number => typeof v === 'number')
    if (!values.length) return null
    return values.reduce((sum, v) => sum + v, 0) / values.length
  },
}))

export function formatClipPercent(value: number | null) {
  if (value == null) return ''
  return `${Math.round(value * 100)}%`
}
