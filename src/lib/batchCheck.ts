import type { TaskRecord } from '../types'

/** 本地验收服务（批次生图 sidecar）地址 */
const SIDECAR = 'http://127.0.0.1:7799'

export interface ExpectText {
  mainTitle: string
  tags: string[]
  brand: string[]
  disclaimer: string[]
}

/** 从提示词里抽取「」包裹的文案，作为图上应有文字的候选标准答案 */
export function expectFromPrompt(prompt: string): ExpectText {
  const quoted = [...prompt.matchAll(/「([^」]+)」/g)].map((m) => m[1].trim()).filter(Boolean)
  if (!quoted.length) return { mainTitle: '', tags: [], brand: [], disclaimer: [] }
  // 约定：最长的一条当主标题，其余按出现顺序当标签
  const mainTitle = [...quoted].sort((a, b) => b.length - a.length)[0]
  const tags = quoted.filter((item) => item !== mainTitle)
  return { mainTitle, tags, brand: [], disclaimer: [] }
}

export interface QcOutcome {
  verdict: 'pass' | 'fail' | 'unsure' | 'error'
  violationPass: boolean
  textPass: boolean
  overlapPass: boolean
  missing: string[]
  wrong: string[]
  extra: string[]
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
        missing: [], wrong: [], extra: [], reason: json.error || '质检失败', confidence: null,
      }
    }
    const r = json.result
    return {
      verdict: r.verdict,
      violationPass: r.violation.pass,
      textPass: r.text.pass,
      overlapPass: r.overlap.pass,
      missing: r.text.missing,
      wrong: r.text.wrong,
      extra: r.text.extra,
      reason: r.reason,
      confidence: r.confidence,
    }
  } catch (err) {
    return {
      verdict: 'error', violationPass: false, textPass: false, overlapPass: false,
      missing: [], wrong: [], extra: [],
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
export async function simBatch(items: Array<{ key: string; dataUrl: string }>): Promise<SimResponse> {
  const res = await fetch(`${SIDECAR}/api/sim-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || '相似度计算失败')
  return json as SimResponse
}

/** 从任务里取第一张输出图的 data URL */
export async function firstImageDataUrl(task: TaskRecord, getImage: (id: string) => Promise<{ dataUrl: string } | undefined>) {
  const imageId = task.outputImages[0]
  if (!imageId) return null
  const image = await getImage(imageId)
  return image?.dataUrl || null
}
