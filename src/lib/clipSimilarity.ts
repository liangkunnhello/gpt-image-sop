import { create } from 'zustand'

import type { TaskRecord } from '../types'
import { ensureImageCached } from './imageCache'
import { computeImageHash, hashScores } from './imageHash'
import type { DuplicateScope } from './duplicateScope'
import { duplicateScopeKey, groupTasksByScope } from './duplicateScope'
import { flushClipVectors, hasClipVector, matchAgainstLibrary, putClipVector } from './clipVectors'
import { useInspectConfig } from './inspectConfig'
import { activeQcRules, qcInBrowser, type QcChecks } from './visionQc'
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
  /** 自定义检查项的结论（规则名 + 是否通过 + 说明），没配自定义规则时没有这个字段 */
  custom?: Array<{ name: string; pass: boolean; note: string }>
  /** 压叠/遮挡位置：哪个字被什么盖住，模型说得出时才有 */
  spots?: string[]
}

export interface ClipScore {
  /** 与同批其他图的平均相似度 */
  mean: number
  /** 与最像的那张的相似度，作为「重复度」展示 */
  max: number
  nearest?: string
  /** 这份分数是按哪种口径算的（卡内 / 同方向）；换了口径要重算 */
  scope?: DuplicateScope
  /** 比对组的 key：卡看 sopJobId，方向看 sopDirectionId；全库比对是 'library' */
  group?: string
  /** 全库比对时参与比对的张数（不含自己） */
  libraryCount?: number
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
  ensure: (tasks: TaskRecord[], scopeOverride?: DuplicateScope) => void
  scoreOfTask: (task: TaskRecord) => number | null
  /** 任务出完图后调用：后台串行跑质检 + 重复度；peers 是按当前口径挑出的历史任务 */
  enqueueTask: (task: TaskRecord, peers: TaskRecord[], scope?: DuplicateScope) => void
  qcOfTask: (task: TaskRecord) => QcResult | null
  queued: number
}

/**
 * 让本地服务把这几张图算成向量并写进库。
 *
 * 复用 /api/clip-similar 接口：它本来就会跑一次 CLIP，带上 --vectors 后顺便返回向量。
 * 图不够两张时（单张入库）本地服务会拒，直接忽略 —— 下次凑够两张再一起索引。
 */
async function indexVectors(entries: Array<{ imageId: string; dataUrl: string }>): Promise<void> {
  if (!entries.length) return
  try {
    const res = await fetch(`${SIDECAR}/api/clip-similar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 0.92, items: entries.map((item) => ({ dataUrl: item.dataUrl })) }),
      signal: AbortSignal.timeout(180000),
    })
    const json = await res.json() as { ok?: boolean; vectors?: Record<string, string> }
    if (!json?.ok || !json.vectors) return
    for (const [indexText, base64] of Object.entries(json.vectors)) {
      const entry = entries[Number(indexText)]
      if (entry && base64) putClipVector(entry.imageId, base64)
    }
  } catch (err) {
    console.warn('图像向量入库失败（下次会再试）：', err)
  }
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

  /**
   * 对还没按当前口径算过的任务图做一次相似度，结果按图片 id 缓存。
   *
   * 每次只算「一组」（一张卡或一个方向）—— 一组里至少两张没算过才动手。
   * 缓存的分数带口径与分组标记：换了口径（卡内 ↔ 同方向）旧数字不再算数，会重算。
   */
  ensure: (tasks: TaskRecord[], scopeOverride?: DuplicateScope) => {
    if (get().running) return
    const config = useInspectConfig.getState().config
    if (!config.autoDuplicate) return
    const scope = scopeOverride ?? config.duplicateScope
    const { scores } = get()

    // 全库比对：不挑 peers 任务，直接和本地向量库比。库里还没索引过这批图时
    // 至少要先把它们索引进去（拿 CLIP 算一次），再算分数。
    if (scope === 'library') {
      const needs = tasks
        .filter((task) => task.status === 'done' && !task.deletedAt)
        .flatMap((task) => task.outputImages ?? [])
        .filter((imageId) => imageId && !hasClipVector(imageId))
      const unevaluated = tasks
        .filter((task) => task.status === 'done' && !task.deletedAt)
        .flatMap((task) => task.outputImages ?? [])
        .filter((imageId) => {
          if (!imageId) return false
          const cached = scores[imageId]
          return !(cached && cached.scope === 'library')
        })
      if (!unevaluated.length) return

      set({ running: true, error: '' })
      void (async () => {
        try {
          // 先把没索引的图算进库：一批最多 maxImages 张，积压时分多次进来补齐
          if (needs.length) {
            const batch = needs.slice(0, config.maxImages)
            const payload: Array<{ index: number; dataUrl: string }> = []
            for (let i = 0; i < batch.length; i += 1) {
              const dataUrl = await ensureImageCached(batch[i])
              if (!dataUrl) continue
              const thumb = await toThumb(dataUrl)
              if (thumb) payload.push({ index: i, dataUrl: thumb })
            }
            if (payload.length) {
              await indexVectors(payload.map((item) => ({ imageId: batch[item.index], dataUrl: item.dataUrl })))
            }
            flushClipVectors()
          }
          // 再逐张和全库比
          const next: Record<string, ClipScore> = { ...get().scores }
          for (const imageId of unevaluated.slice(0, config.maxImages)) {
            const match = matchAgainstLibrary(imageId)
            if (!match) continue
            next[imageId] = {
              mean: match.mean,
              max: match.max,
              nearest: match.nearest,
              scope: 'library',
              group: 'library',
              libraryCount: match.count,
            }
          }
          set({ scores: next, running: false, engine: 'clip', error: '' })
        } catch (err) {
          set({ running: false, error: err instanceof Error ? err.message : '全库比对失败' })
        }
      })()
      return
    }

    let picked: { group: string; ids: string[] } | null = null
    for (const group of groupTasksByScope(tasks, scope)) {
      const ids: string[] = []
      for (const task of group.tasks) {
        for (const imageId of task.outputImages) {
          if (!imageId || ids.includes(imageId)) continue
          const cached = scores[imageId]
          // 同口径同组算过就跳过；换了口径或范围，旧分数不成立，要重算
          if (cached && cached.scope === scope && cached.group === group.key) continue
          ids.push(imageId)
          if (ids.length >= config.maxImages) break
        }
        if (ids.length >= config.maxImages) break
      }
      if (ids.length >= 2) {
        picked = { group: group.key, ids }
        break
      }
    }
    if (!picked) return

    const candidates: Array<{ imageId: string }> = picked.ids.map((imageId) => ({ imageId }))
    const groupKey = picked.group

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
          vectors?: Record<string, string>
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
          next[imageId] = { mean: score.mean, max: score.max, nearest, scope, group: groupKey }
        }
        // 顺手把向量收进本地库：下次切「全部历史图」就不用重算了
        if (json.vectors) {
          for (const [indexText, base64] of Object.entries(json.vectors)) {
            const entry = payload[Number(indexText)]
            const imageId = entry ? candidates[entry.index].imageId : ''
            if (imageId && base64) putClipVector(imageId, base64)
          }
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
          const tagged: Record<string, ClipScore> = { ...get().scores }
          for (const [imageId, score] of Object.entries(local)) {
            tagged[imageId] = { ...score, scope, group: groupKey }
          }
          set({ scores: tagged, running: false, engine: 'phash', error: '' })
          return
        }
        set({ running: false, error: err instanceof Error ? err.message : 'CLIP 计算失败' })
      }
    })()
  },

  /** 任务出完图就排进后台队列，一张一张串行处理 */
  enqueueTask: (task: TaskRecord, peers: TaskRecord[], scopeOverride?: DuplicateScope) => {
    const config = useInspectConfig.getState().config
    if (!config.autoQc && !config.autoDuplicate) return
    const imageIds = task.outputImages.filter(Boolean)
    if (!imageIds.length) return
    const scope = scopeOverride ?? config.duplicateScope
    const group = duplicateScopeKey(task, scope)
    // 质检要拿提示词里的「」文案当对照，降级到浏览器直连时同样适用
    const expect = expectFromPrompt(task.prompt || '')
    set((s) => ({ queued: s.queued + imageIds.length }))
    enqueue(async () => {
      for (const imageId of imageIds) {
        try {
          const state = useClipStore.getState()
          // 分数要「同口径同组」才算数，换了口径就重新比
          const cached = state.scores[imageId]
          const scoreFresh = cached && cached.scope === scope && cached.group === group
          if (!state.qc[imageId] || !scoreFresh) await inspectOne(imageId, peers, expect, scope, group)
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
  options: {
    limit?: number
    expect?: ExpectText
    manual?: boolean
    /** 这批判定用的重复度口径，写进分数里，换口径后不会拿旧数字冒充 */
    scope?: DuplicateScope
    /** 比对组 key（卡 id / 方向 id） */
    group?: string
  } = {},
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
      nextScores[imageId] = { mean: score.mean, max: score.max, nearest, scope: options.scope, group: options.group }
    }

    useClipStore.setState((state) => ({
      qc: nextQc,
      scores: nextScores,
      limit: json?.limit ?? state.limit,
      engine: 'clip',
    }))
    // 交付在生图完成时就跑了，质检这时才出结论：判不合格的那几张要从交付文件夹里撤掉
    await pruneFailedDelivered(Object.keys(nextQc))
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
    rules: config.customRules,
  }

  const nextQc: Record<string, QcResult> = { ...useClipStore.getState().qc }
  // 手动检查不看自动开关，自动跑时才按配置跳过不做的项
  const runQc = manual || (config.autoQc && (checks.violation || checks.text || checks.overlap || activeQcRules(checks.rules).length > 0))
  if (profile && runQc) {
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= entries.length) return
        const entry = entries[index]
        const outcome = await qcInBrowser(profile, entry.dataUrl, expect, { model: config.qcModel, checks })
        // 自定义规则的结论带上规则名，详情页直接显示「哪条没过」
        const ruleName = new Map(config.customRules.map((rule) => [rule.id, rule.name.trim()]))
        nextQc[entry.imageId] = {
          // error 不是合法结论，统一记成待定，原因留在 reason 里
          verdict: outcome.verdict === 'pass' || outcome.verdict === 'fail' ? outcome.verdict : 'unsure',
          reason: outcome.reason,
          confidence: outcome.confidence ?? undefined,
          custom: outcome.custom.length
            ? outcome.custom.map((item) => ({
              name: ruleName.get(item.id) || item.id,
              pass: item.pass,
              note: item.note,
            }))
            : undefined,
          spots: outcome.spots.length ? outcome.spots : undefined,
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
  // 交付在生图完成时就跑了，质检这时才出结论：判不合格的那几张要从交付文件夹里撤掉
  await pruneFailedDelivered(Object.keys(nextQc))
}

/**
 * 质检出结论后追溯交付目录。
 *
 * 动态导入 store：store 反过来依赖本模块，静态引会成环。
 * 失败不影响质检本身，最多是文件没删掉，用户还能在回收站/交付文件夹里处理。
 */
async function pruneFailedDelivered(imageIds: string[]) {
  try {
    const { pruneFailedDeliveredImages } = await import('../store')
    await pruneFailedDeliveredImages(imageIds)
  } catch (err) {
    console.warn('追溯清理交付文件失败：', err)
  }
}

/**
 * 一张图连同同方向的历史图一起送检：一次调用同时拿到质检结论和重复度。
 * 没有历史图时也要走，因为质检本身不依赖比对，只是算不出重复度。
 */
async function inspectOne(
  imageId: string,
  peers: TaskRecord[],
  expect: ExpectText,
  scope?: DuplicateScope,
  group?: string,
) {
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
    await inspectImages(entries, { expect, scope, group })
  } catch {
    // 静默失败，下次进详情还会补算
  }
}
