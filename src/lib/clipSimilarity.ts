import { create } from 'zustand'

import type { TaskRecord } from '../types'
import { ensureImageCached } from './imageCache'

import { SIDECAR } from './sidecar'
/** 一次最多送多少张去算，太多会很慢 */
const MAX_IMAGES = 36
/** 送给 CLIP 前先缩到这个边长，既快又不影响判断 */
const THUMB_SIZE = 384

export type QcVerdict = 'pass' | 'fail' | 'unsure'

export interface QcResult {
  verdict: QcVerdict
  reason: string
  confidence?: number
}

export interface ClipScore {
  /** 与同批其他图的平均相似度 */
  mean: number
  /** 与最像的那张的相似度，作为「重复度」展示 */
  max: number
  nearest?: string
}

interface ClipState {
  scores: Record<string, ClipScore>
  /** 质检结果，按图片 id 存 */
  qc: Record<string, QcResult>
  running: boolean
  error: string
  limit: number
  ensure: (tasks: TaskRecord[]) => void
  scoreOfTask: (task: TaskRecord) => number | null
  /** 任务出完图后调用：后台串行跑质检 + 重复度；peers 是同方向的历史任务 */
  enqueueTask: (task: TaskRecord, peers: TaskRecord[]) => void
  qcOfTask: (task: TaskRecord) => QcResult | null
  queued: number
}

/** 后台任务串行执行，避免同时开一堆模型请求 */
let chain: Promise<void> = Promise.resolve()
function enqueue(fn: () => Promise<void>) {
  chain = chain.then(fn).catch((err) => {
    console.warn('后台质检/重复度失败', err)
  })
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
  qc: {},
  running: false,
  error: '',
  limit: 0.92,
  queued: 0,

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

  /** 任务出完图就排进后台队列，一张一张串行处理 */
  enqueueTask: (task: TaskRecord, peers: TaskRecord[]) => {
    const imageIds = task.outputImages.filter(Boolean)
    if (!imageIds.length) return
    set((s) => ({ queued: s.queued + imageIds.length }))
    enqueue(async () => {
      for (const imageId of imageIds) {
        try {
          const state = useClipStore.getState()
          if (!state.qc[imageId] || !state.scores[imageId]) await inspectOne(imageId, peers)
        } finally {
          set((s) => ({ queued: Math.max(0, s.queued - 1) }))
        }
      }
    })
  },

  /** 任务整体质检结论：取最差的一张（fail > unsure > pass） */
  qcOfTask: (task: TaskRecord) => {
    const { qc } = get()
    const list = task.outputImages.map((id) => qc[id]).filter(Boolean)
    if (!list.length) return null
    const worst = list.find((item) => item.verdict === 'fail')
      ?? list.find((item) => item.verdict === 'unsure')
      ?? list[0]
    return worst
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


/**
 * 一次调用同时做质检和重复度（后端 /api/inspect），结果按图片 id 写回 store。
 * 传进来的第一张是主角，其余作为「同方向历史图」一起参与两两比对，
 * 所以返回的重复度就是主角与它们之中最像那张的相似度。
 */
export async function inspectImages(
  entries: Array<{ imageId: string; dataUrl: string }>,
  options: { limit?: number } = {},
): Promise<void> {
  const payload: Array<{ id: string; dataUrl: string }> = []
  const imageIdByIndex: string[] = []
  for (const entry of entries) {
    const thumb = await toThumb(entry.dataUrl)
    if (!thumb) continue
    payload.push({ id: String(payload.length), dataUrl: thumb })
    imageIdByIndex.push(entry.imageId)
  }
  if (!payload.length) return

  const res = await fetch(`${SIDECAR}/api/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: payload, limit: options.limit ?? useClipStore.getState().limit }),
    signal: AbortSignal.timeout(180000),
  })
  const json = await res.json() as {
    ok?: boolean
    error?: string
    limit?: number
    qc?: Record<string, { ok?: boolean; verdict?: string; reason?: string; confidence?: number | null }>
    similarity?: { perImage?: Record<string, { mean: number; max: number; nearest?: string | null }> }
  }
  if (!res.ok) throw new Error(json?.error || '检查失败')

  const imageIdAt = (key: string) => imageIdByIndex[Number(key)]

  const nextQc: Record<string, QcResult> = { ...useClipStore.getState().qc }
  for (const [key, item] of Object.entries(json?.qc || {})) {
    const imageId = imageIdAt(key)
    if (!imageId || !item) continue
    const verdict: QcVerdict = item.verdict === 'pass' || item.verdict === 'fail' || item.verdict === 'unsure'
      ? item.verdict
      : 'unsure'
    nextQc[imageId] = {
      verdict,
      reason: String(item.reason || ''),
      confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
    }
  }

  const nextScores: Record<string, ClipScore> = { ...useClipStore.getState().scores }
  for (const [key, score] of Object.entries(json?.similarity?.perImage || {})) {
    const imageId = imageIdAt(key)
    if (!imageId) continue
    const nearestKey = score.nearest ? String(score.nearest).replace(/\.[a-z]+$/i, '') : ''
    const nearest = nearestKey && Number(nearestKey) !== Number(key) ? imageIdAt(nearestKey) : undefined
    nextScores[imageId] = { mean: score.mean, max: score.max, nearest }
  }

  useClipStore.setState((state) => ({
    qc: nextQc,
    scores: nextScores,
    limit: json?.limit ?? state.limit,
  }))
}

/**
 * 一张图连同同方向的历史图一起送检：一次调用同时拿到质检结论和重复度。
 * 没有历史图时也要走，因为质检本身不依赖比对，只是算不出重复度。
 */
async function inspectOne(imageId: string, peers: TaskRecord[]) {
  try {
    const selfDataUrl = await ensureImageCached(imageId)
    if (!selfDataUrl) return

    const peerIds: string[] = []
    for (const peer of peers) {
      for (const id of peer.outputImages) {
        if (id !== imageId && !peerIds.includes(id)) peerIds.push(id)
        if (peerIds.length >= 10) break
      }
      if (peerIds.length >= 10) break
    }

    const entries: Array<{ imageId: string; dataUrl: string }> = [{ imageId, dataUrl: selfDataUrl }]
    for (const id of peerIds) {
      const dataUrl = await ensureImageCached(id)
      if (dataUrl) entries.push({ imageId: id, dataUrl })
    }
    await inspectImages(entries)
  } catch {
    // 静默失败，下次进详情还会补算
  }
}
