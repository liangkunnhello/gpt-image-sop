import type { TaskRecord } from '../types'
import { computeImageHash, hashScores, similarityFromHashes } from './imageHash'

/** 本地验收服务（批次生图 sidecar）地址 */
import { SIDECAR } from './sidecar'

export interface ExpectText {
  mainTitle: string
  tags: string[]
  brand: string[]
  disclaimer: string[]
}

/** 从提示词里抽取「」包裹的文案，作为图上应有文字的候选标准答案 */
/**
 * 从提示词里抽出「应出现的文案」。
 *
 * 只有「」包住的才算 —— 这是提示词里唯一能确定「必须逐字出现在图上」的写法。
 * 抽不到就返回空，此时质检只做违规与压叠，**不判文案**（判了也只是同一句笼统结论）。
 */
export function expectFromPrompt(prompt: string): ExpectText {
  const quoted = [...prompt.matchAll(/「([^」]+)」/g)].map((m) => m[1].trim()).filter(Boolean)
  if (!quoted.length) return { mainTitle: '', tags: [], brand: [], disclaimer: [] }
  // 约定：最长的一条当主标题，其余按出现顺序当标签
  const mainTitle = [...quoted].sort((a, b) => b.length - a.length)[0]
  const tags = quoted.filter((item) => item !== mainTitle)
  return { mainTitle, tags, brand: [], disclaimer: [] }
}

/**
 * 把任务里能确定的文案补进 expect：卖点原文比提示词里的「」更权威。
 *
 * SOP / 变量模式下提示词是模型写的，经常不带「」，于是文案核对整段落空 ——
 * 模型只能说「无法核对」，几十张图的理由自然一模一样。任务上记着当初选的卖点
 * （sopPointName 只是名字）与实际喂进去的 copyText，用它们兜底才判得出来。
 */
export function expectForTask(task: {
  prompt?: string
  copyText?: string
  sopPointName?: string
}): ExpectText {
  const base = expectFromPrompt(task.prompt || '')
  if (base.mainTitle || base.tags.length) return base
  // copyText 是多条卖点用换行/分号分开的原文，拆成标题 + 标签
  const copy = String(task.copyText || '').trim()
  if (!copy) return base
  const lines = copy
    .split(/\n|；|;/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return base
  const mainTitle = [...lines].sort((a, b) => b.length - a.length)[0]
  const tags = lines.filter((item) => item !== mainTitle)
  return { mainTitle, tags, brand: [], disclaimer: [] }
}

/** 一条自定义质检项的结论（对应设置里用户自己加的检查项） */
export interface QcCustomResult {
  id: string
  pass: boolean
  note: string
}

export interface QcOutcome {
  verdict: 'pass' | 'fail' | 'unsure' | 'error'
  violationPass: boolean
  textPass: boolean
  overlapPass: boolean
  /** 压叠/遮挡位置，形如「顶部大标题第 2、3 字被左上角 Logo 盖住下半部」 */
  spots: string[]
  missing: string[]
  wrong: string[]
  extra: string[]
  /** 自定义检查项的结论，没配自定义规则时为空数组 */
  custom: QcCustomResult[]
  reason: string
  confidence: number | null
}

export interface QcResponse {
  ok: boolean
  result: {
    violation: { pass: boolean; items: string[] }
    text: { pass: boolean; missing: string[]; wrong: string[]; extra: string[] }
    overlap: { pass: boolean; spots: string[] }
    verdict: 'pass' | 'fail' | 'unsure'
    confidence: number | null
    reason: string
  } | null
  error: string | null
}

export async function sidecarAlive() {
  try {
    const res = await fetch(`${SIDECAR}/api/state`, { signal: AbortSignal.timeout(2500) })
    return res.ok
  } catch {
    return false
  }
}

export async function qcOne(dataUrl: string, expect: ExpectText): Promise<QcOutcome> {
  try {
    const res = await fetch(`${SIDECAR}/api/qc-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, expect }),
    })
    const json = (await res.json()) as QcResponse & { error?: string }
    if (!json.ok || !json.result) {
      return {
        verdict: 'error', violationPass: false, textPass: false, overlapPass: false,
        spots: [], missing: [], wrong: [], extra: [], custom: [], reason: json.error || '质检失败', confidence: null,
      }
    }
    const r = json.result
    return {
      verdict: r.verdict,
      violationPass: r.violation.pass,
      textPass: r.text.pass,
      overlapPass: r.overlap.pass,
      spots: r.overlap?.spots ?? [],
      missing: r.text.missing,
      wrong: r.text.wrong,
      extra: r.text.extra,
      // 本地验收服务不跑自定义规则，结论留给浏览器端质检
      custom: [],
      reason: r.reason,
      confidence: r.confidence,
    }
  } catch (err) {
    return {
      verdict: 'error', violationPass: false, textPass: false, overlapPass: false,
      spots: [], missing: [], wrong: [], extra: [], custom: [],
      reason: err instanceof Error ? err.message : '连不上本地验收服务', confidence: null,
    }
  }
}

export interface SimRow {
  key: string
  mean: number
  max: number
  nearestKey: string
}

export interface SimResponse {
  count: number
  pairs_total: number
  over_pairs: number
  pass_pairs: number
  limit: number
  stats: { min: number; max: number; mean: number; p10: number; p90: number }
  over_list: Array<{ aKey: string; bKey: string; sim: number }>
  regen: Array<{ regenKey: string; keepKey: string; sim: number }>
  per_image: SimRow[]
}

/** 把一批图交给本地服务算 CLIP 相似度，返回每张图的最近邻 */
export async function simBatch(items: Array<{ key: string; dataUrl: string }>, limit = 0.92): Promise<SimResponse> {
  const res = await fetch(`${SIDECAR}/api/sim-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, limit }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || '相似度计算失败')
  return json as SimResponse
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

/**
 * 没有本地服务时用感知哈希算一遍，返回结构与 simBatch 一致。
 * 比的是画面结构而不是语义，界面上会标注「画面近似度」。
 */
export async function simBatchLocal(
  items: Array<{ key: string; dataUrl: string }>,
  limit = 0.92,
): Promise<SimResponse> {
  const hashed: Array<{ key: string; hash: string }> = []
  for (const item of items) {
    const hash = await computeImageHash(item.dataUrl)
    if (hash) hashed.push({ key: item.key, hash })
  }
  const scores = hashScores(hashed)

  const rows: SimRow[] = hashed.map((item) => {
    const score = scores[item.key]
    return {
      key: item.key,
      mean: score?.mean ?? 0,
      max: score?.max ?? 0,
      nearestKey: score?.nearest ?? '',
    }
  })

  const pairs: SimResponse['over_list'] = []
  for (let i = 0; i < hashed.length; i += 1) {
    for (let j = i + 1; j < hashed.length; j += 1) {
      pairs.push({
        aKey: hashed[i].key,
        bKey: hashed[j].key,
        sim: similarityFromHashes(hashed[i].hash, hashed[j].hash),
      })
    }
  }

  const all = pairs.map((pair) => pair.sim).sort((a, b) => a - b)
  const overList = pairs.filter((pair) => pair.sim > limit).sort((a, b) => b.sim - a.sim)
  const regen = rows
    .filter((row) => row.max > limit && row.nearestKey)
    .map((row) => ({ regenKey: row.key, keepKey: row.nearestKey, sim: row.max }))

  return {
    count: hashed.length,
    pairs_total: pairs.length,
    over_pairs: overList.length,
    pass_pairs: pairs.length - overList.length,
    limit,
    stats: {
      min: all.length ? all[0] : 0,
      max: all.length ? all[all.length - 1] : 0,
      mean: all.length ? all.reduce((sum, value) => sum + value, 0) / all.length : 0,
      p10: percentile(all, 0.1),
      p90: percentile(all, 0.9),
    },
    over_list: overList,
    regen,
    per_image: rows,
  }
}

/** 从任务里取第一张输出图的 data URL */
export async function firstImageDataUrl(task: TaskRecord, getImage: (id: string) => Promise<{ dataUrl: string } | undefined>) {
  const imageId = task.outputImages[0]
  if (!imageId) return null
  const image = await getImage(imageId)
  return image?.dataUrl || null
}
