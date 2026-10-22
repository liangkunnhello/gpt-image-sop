import { useStore } from '../store'
import { useSopStore } from '../lib/sopStore'
import type { PlainImageMode } from '../lib/plainImagePlan'
import { MAX_INPUT_IMAGES } from '../types'

export interface InputImageLimitOptions {
  sopMode: boolean
  variableMode: boolean
  plainImageMode: PlainImageMode
  /** 生成数量，也就是请求次数 */
  n: number
}

/**
 * 拖入参考图的上限。返回 Infinity 表示不限。
 *
 * 只有「普通模式 + 融图 + 数量 1」需要限制 —— 那种情况下所有图会塞进同一个请求，
 * 超过 16 张接口直接报错。批量模式每请求只带 1 张、融图数量大于 1 会把变量图分组，
 * 拖入阶段都不该被卡住。
 *
 * SOP / 变量模式按「一组图一张卡」切分，仍沿用 16 张。
 */
export function resolveInputImageLimit({ sopMode, variableMode, plainImageMode, n }: InputImageLimitOptions): number {
  if (sopMode || variableMode) return MAX_INPUT_IMAGES
  if (plainImageMode === 'batch') return Number.POSITIVE_INFINITY
  if ((n ?? 1) > 1) return Number.POSITIVE_INFINITY
  return MAX_INPUT_IMAGES
}

export function useInputImageLimit(): number {
  const plainImageMode = useStore((s) => s.plainImageMode)
  const n = useStore((s) => s.params.n)
  const sopMode = useSopStore((s) => s.sopMode)
  const variableMode = useSopStore((s) => s.variableMode)
  return resolveInputImageLimit({ sopMode, variableMode, plainImageMode, n })
}
