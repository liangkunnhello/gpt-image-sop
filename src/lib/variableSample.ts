/**
 * 变量模式：从「骨架 + 多组变量选项」里挑出 N 组填词方案。
 *
 * 为什么用最远点采样：组合池是笛卡尔积，随手取前 N 个会让某一维一直取第一个选项，
 * 画面高度雷同。最远点采样每轮都挑「离已选集合最远」的组合，等价于在这个离散网格里
 * 尽量铺开，用最少的张数覆盖最多的取值差异。
 *
 * 距离用汉明距离：两个组合在几个维度上取值不同，距离就是几。整数距离，结果可复现。
 */

import type { VariableDimension, VariableFill, VariableStrategy } from '../types'

/** 组合池上限：超过这个数就改用低差异序列抽样，避免笛卡尔积把内存撑爆 */
export const COMBO_POOL_LIMIT = 4096

/** 一维一个选项下标，合起来就是一个具体组合 */
type Combo = number[]

/** 骨架里的占位符，允许 {{ 变量 }} 这种带空格的写法 */
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Halton 序列：确定性、分布均匀，用来在大组合空间里抽有代表性的点 */
function halton(index: number, base: number) {
  let fraction = 1
  let result = 0
  let cursor = index
  while (cursor > 0) {
    fraction /= base
    result += fraction * (cursor % base)
    cursor = Math.floor(cursor / base)
  }
  return result
}

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]

/** 参与采样的维度：只有 1 个选项的维度没有差异可铺，不参与距离计算 */
export function effectiveDimensions(dimensions: VariableDimension[]): VariableDimension[] {
  return dimensions.filter((item) => item.name.trim() && item.options.length > 1)
}

/** 生成组合池：空间不大就全枚举，太大就用 Halton 序列抽一批均匀样本 */
export function buildComboPool(dimensions: VariableDimension[], limit = COMBO_POOL_LIMIT): Combo[] {
  const radix = dimensions.map((item) => item.options.length)
  if (!radix.length) return [[]]
  const total = radix.reduce((acc, item) => acc * item, 1)

  if (total <= limit) {
    const out: Combo[] = []
    for (let n = 0; n < total; n += 1) {
      const combo: Combo = []
      let rest = n
      for (const base of radix) {
        combo.push(rest % base)
        rest = Math.floor(rest / base)
      }
      out.push(combo)
    }
    return out
  }

  const seen = new Set<string>()
  const out: Combo[] = []
  for (let i = 1; out.length < limit && i < limit * 8; i += 1) {
    const combo = radix.map((base, dim) => Math.min(base - 1, Math.floor(halton(i, PRIMES[dim] ?? 41) * base)))
    const key = combo.join(',')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(combo)
  }
  return out
}

/** 汉明距离：两个组合在几个维度上取值不同 */
function hamming(a: Combo, b: Combo) {
  let diff = 0
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1
  return diff
}

/**
 * 最远点采样，返回被选中点的下标序列。
 * 起点取每个维度上最常见取值的组合（最「典型」的点），避免一开始就偏在某个角上；
 * 之后每轮挑离已选集合最远的点。同分时取下标小的，保证同样的输入永远得到同样的结果。
 */
export function farthestPointSample(points: Combo[], count: number): number[] {
  if (!points.length || count <= 0) return []
  const dims = points[0].length
  if (dims === 0) return [0]

  let start = 0
  if (points.length > 1) {
    const freq = Array.from({ length: dims }, () => new Map<number, number>())
    for (const point of points) {
      for (let d = 0; d < dims; d += 1) freq[d].set(point[d], (freq[d].get(point[d]) ?? 0) + 1)
    }
    let bestScore = -1
    for (let i = 0; i < points.length; i += 1) {
      let score = 0
      for (let d = 0; d < dims; d += 1) score += (freq[d].get(points[i][d]) ?? 0) / points.length
      if (score > bestScore) {
        bestScore = score
        start = i
      }
    }
  }

  const max = Math.min(count, points.length)
  const chosen = [start]
  // -1 表示已选中，顺便避免重复选到同一个点
  const minDist = points.map((point) => hamming(point, points[start]))
  minDist[start] = -1

  while (chosen.length < max) {
    let next = -1
    let farthest = 0
    for (let i = 0; i < points.length; i += 1) {
      if (minDist[i] > farthest) {
        farthest = minDist[i]
        next = i
      }
    }
    // 池子里已经不存在更远的点，说明铺满了，不再凑数
    if (next < 0) break
    chosen.push(next)
    minDist[next] = -1
    for (let i = 0; i < points.length; i += 1) {
      if (minDist[i] < 0) continue
      minDist[i] = Math.min(minDist[i], hamming(points[i], points[next]))
    }
  }
  return chosen
}

/** 骨架里出现的变量名，按首次出现顺序去重 */
export function skeletonVariables(skeleton: string): string[] {
  const names: string[] = []
  for (const match of skeleton.matchAll(PLACEHOLDER)) {
    const name = match[1].trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** 把 {{变量}} 换成具体取值；没有取值的占位符原样保留，方便一眼看出漏填 */
export function fillSkeleton(skeleton: string, assignments: Record<string, string>): string {
  return skeleton.replace(PLACEHOLDER, (whole, raw: string) => assignments[raw.trim()] ?? whole)
}

export interface FillPlan {
  fills: VariableFill[]
  /** 组合池不够、实际张数少于要求时的说明 */
  note: string
}

/** 单条策略按最远点采样摊出 count 组填词，结果按提示词去重 */
export function planFills(strategy: VariableStrategy, count: number): FillPlan {
  const dims = strategy.dimensions.filter((item) => item.name.trim() && item.options.length > 0)
  const variableDims = effectiveDimensions(dims)
  // 只有 1 个选项的变量不参与采样，但填词时仍然要用它唯一的值
  const fixed: Record<string, string> = {}
  for (const item of dims) {
    if (item.options.length === 1) fixed[item.name] = item.options[0]
  }

  const pool = buildComboPool(variableDims)
  const picks = farthestPointSample(pool, count)

  const fills: VariableFill[] = []
  const seen = new Set<string>()
  for (const index of picks) {
    const combo = pool[index]
    const assignments: Record<string, string> = { ...fixed }
    variableDims.forEach((item, dim) => {
      assignments[item.name] = item.options[combo[dim]] ?? item.options[0]
    })
    const prompt = fillSkeleton(strategy.skeleton, assignments).trim()
    if (!prompt || seen.has(prompt)) continue
    seen.add(prompt)
    fills.push({ strategyName: strategy.name, assignments, prompt })
  }

  const note = count > fills.length
    ? `「${strategy.name}」的组合只有 ${fills.length} 种不同结果，按 ${fills.length} 张出`
    : ''
  return { fills, note }
}

/** 多条策略按张数平摊，余数给前面的策略；跨策略再去一次重 */
export function planStrategyFills(strategies: VariableStrategy[], total: number): { fills: VariableFill[]; notes: string[] } {
  if (!strategies.length || total <= 0) return { fills: [], notes: [] }

  const size = Math.min(total, strategies.length)
  const base = Math.floor(total / size)
  const extra = total % size
  const notes: string[] = []
  const fills: VariableFill[] = []
  const seen = new Set<string>()

  strategies.slice(0, size).forEach((strategy, index) => {
    const want = base + (index < extra ? 1 : 0)
    const plan = planFills(strategy, want)
    if (plan.note) notes.push(plan.note)
    for (const fill of plan.fills) {
      // 不同策略偶尔会填出同一句话，这里按最终提示词去重，保证一张卡里不重复
      if (seen.has(fill.prompt)) continue
      seen.add(fill.prompt)
      fills.push(fill)
    }
  })

  return { fills, notes }
}
