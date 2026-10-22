import { create } from 'zustand'

import type { TaskRecord } from '../types'
import { ensureImageCached } from './imageCache'
import { computeImageHash, hashScores } from './imageHash'
import { useInspectConfig } from './inspectConfig'
import { qcInBrowser, type QcChecks } from './visionQc'
import { expectFromPrompt, type ExpectText } from './batchCheck'

import { SIDECAR } from './sidecar'
/** 送给 CLIP 前先缩到这个边长，既快又不影响判断 */
const THUMB_SIZE = 384

/** 没有可对照的文案规范时，只做画面层面的合规检查 */
const EMPTY_EXPECT: ExpectText = { mainTitle: '', tags: [], brand: [], disclaimer: [] }

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
  /**
   * 重复度由谁算出来的：
   * clip = 本地服务的 CLIP 语义相似度；phash = 没有本地服务时的画面近似度。
   * 两种口径不能混着比，所以只记最近一次用的引擎。
   */
  engine: 'clip' | 'phash' | ''
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
  limit: useInspectConfig.getState().config.limit,
  engine: '',
  queued: 0,

  /** 对还没算过的任务图做一次 CLIP 相似度，结果按图片 id 缓存 */
  ensure: (tasks: TaskRecord[]) => {
    if (get().running) return
    const config = useInspectConfig.getState().config
    if (!config.autoDuplicate) return
    const maxImages = config.maxImages
    const { scores } = get()
    const candidates: Array<{ imageId: string }> = []
    for (const task of tasks) {
      if (task.status !== 'done') continue
      for (const imageId of task.outputImages) {
        if (scores[imageId]) continue
        if (candidates.some((item) => item.imageId === imageId)) continue
        candidates.push({ imageId })
        if (candidates.length >= maxImages) break
      }
      if (candidates.length >= maxImages) break
    }
    if (candidates.length < 2) return

    set({ running: true, error: '' })
    void (async () => {
      // payload 提到 try 外：降级算哈希时还要用它
      const payload: Array<{ index: number; dataUrl: string }> = []
      try {
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
        set({ scores: next, running: false, limit: json.limit ?? get().limit, engine: 'clip' })
      } catch (err) {
        // 桌面安装版没有挂在 dev server 上的本地服务，CLIP 不可用；
        // 退到浏览器内算画面近似度，至少能把「几乎一样」的图挑出来。
        const hashes: Array<{ key: string; hash: string }> = []
        for (const item of payload) {
          const imageId = candidates[item.index]?.imageId
          if (!imageId) continue
          const hash = await computeImageHash(item.dataUrl)
          if (hash) hashes.push({ key: imageId, hash })
        }
        const local = hashScores(hashes)
        if (Object.keys(local).length) {
          set({ scores: { ...get().scores, ...local }, running: false, engine: 'phash', error: '' })
          return
        }
        set({ running: false, error: err instanceof Error ? err.message : 'CLIP 计算失败' })
      }
    })()
  },

  /** 任务出完图就排进后台队列，一张一张串行处理 */
  enqueueTask: (task: TaskRecord, peers: TaskRecord[]) => {
    const config = useInspectConfig.getState().config
    if (!config.autoQc && !config.autoDuplicate) return
    const imageIds = task.outputImages.filter(Boolean)
    if (!imageIds.length) return
    // 质检要拿提示词里的「」文案当对照，降级到浏览器直连时同样适用
    const expect = expectFromPrompt(task.prompt || '')
    set((s) => ({ queued: s.queued + imageIds.length }))
    enqueue(async () => {
      for (const imageId of imageIds) {
        try {
          const state = useClipStore.getState()
          if (!state.qc[imageId] || !state.scores[imageId]) await inspectOne(imageId, peers, expect)
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

// 判定线以配置为准，改完配置后已算出的分数也会立刻按新线重新上色
useInspectConfig.subscribe((state) => {
  if (useClipStore.getState().limit !== state.config.limit) {
    useClipStore.setState({ limit: state.config.limit })
  }
})


/**
 * 一次调用同时做质检和重复度（后端 /api/inspect），结果按图片 id 写回 store。
 * 传进来的第一张是主角，其余作为「同方向历史图」一起参与两两比对，
 * 所以返回的重复度就是主角与它们之中最像那张的相似度。
 *
 * 拿不到本地服务（桌面安装版）时自动降级：质检直接用当前接口配置调视觉模型，
 * 重复度改用浏览器内的感知哈希，界面会标注「画面近似度」。
 */
export async function inspectImages(
  entries: Array<{ imageId: string; dataUrl: string }>,
  options: { limit?: number; expect?: ExpectText; manual?: boolean } = {},
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

  try {
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
      engine: 'clip',
    }))
  } catch {
    await inspectLocally(entries, options.expect ?? EMPTY_EXPECT, Boolean(options.manual))
  }
}

/**
 * 没有本地服务时的替代实现：
 * 质检逐张调视觉模型（并发按配置），重复度用感知哈希两两比对。
 * 两者都不依赖 Python / CLIP，桌面安装包里也能跑。
 */
async function inspectLocally(
  entries: Array<{ imageId: string; dataUrl: string }>,
  expect: ExpectText,
  manual = false,
): Promise<void> {
  // 动态导入：store 反过来依赖本模块，静态引会成环
  const { useStore } = await import('../store')
  const { settings } = useStore.getState()
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  const config = useInspectConfig.getState().config
  const checks: QcChecks = {
    violation: config.checkViolation,
    text: config.checkText,
    overlap: config.checkOverlap,
  }

  const nextQc: Record<string, QcResult> = { ...useClipStore.getState().qc }
  // 手动检查不看自动开关，自动跑时才按配置跳过不做的项
  const runQc = manual || (config.autoQc && (checks.violation || checks.text || checks.overlap))
  if (profile && runQc) {
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= entries.length) return
        const entry = entries[index]
        const outcome = await qcInBrowser(profile, entry.dataUrl, expect, { model: config.qcModel, checks })
        nextQc[entry.imageId] = {
          // error 不是合法结论，统一记成待定，原因留在 reason 里
          verdict: outcome.verdict === 'pass' || outcome.verdict === 'fail' ? outcome.verdict : 'unsure',
          reason: outcome.reason,
          confidence: outcome.confidence ?? undefined,
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.qcConcurrency, entries.length) }, worker))
  }

  const hashes: Array<{ key: string; hash: string }> = []
  // 自动跑时「自动算重复度」关掉就只做质检，不白算哈希
  if (manual || config.autoDuplicate) {
    for (const entry of entries) {
      const hash = await computeImageHash(entry.dataUrl)
      if (hash) hashes.push({ key: entry.imageId, hash })
    }
  }
  const local = hashScores(hashes)

  const nextScores: Record<string, ClipScore> = { ...useClipStore.getState().scores }
  for (const [imageId, score] of Object.entries(local)) {
    nextScores[imageId] = score
  }

  useClipStore.setState((state) => ({
    qc: nextQc,
    scores: nextScores,
    engine: 'phash',
    limit: useInspectConfig.getState().config.limit,
  }))
}

/**
 * 一张图连同同方向的历史图一起送检：一次调用同时拿到质检结论和重复度。
 * 没有历史图时也要走，因为质检本身不依赖比对，只是算不出重复度。
 */
async function inspectOne(imageId: string, peers: TaskRecord[], expect: ExpectText) {
  try {
    const config = useInspectConfig.getState().config
    const selfDataUrl = await ensureImageCached(imageId)
    if (!selfDataUrl) return

    const peerIds: string[] = []
    for (const peer of peers) {
      for (const id of peer.outputImages) {
        if (id !== imageId && !peerIds.includes(id)) peerIds.push(id)
        if (peerIds.length >= config.peerLimit) break
      }
      if (peerIds.length >= config.peerLimit) break
    }

    const entries: Array<{ imageId: string; dataUrl: string }> = [{ imageId, dataUrl: selfDataUrl }]
    for (const id of peerIds) {
      const dataUrl = await ensureImageCached(id)
      if (dataUrl) entries.push({ imageId: id, dataUrl })
    }
    await inspectImages(entries, { expect })
  } catch {
    // 静默失败，下次进详情还会补算
  }
}
