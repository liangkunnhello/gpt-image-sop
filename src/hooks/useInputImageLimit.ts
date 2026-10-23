import { useStore } from '../store'
import { useSopStore } from '../lib/sopStore'
import type { PlainImageMode } from '../lib/plainImagePlan'
import { MAX_INPUT_IMAGES, MAX_SOP_INPUT_IMAGES } from '../types'

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
 * SOP / 变量模式按「一组图一张卡」切分，输入阶段放宽到 MAX_SOP_INPUT_IMAGES，
 * 真正反推时每组仍不超过 MAX_INPUT_IMAGES（见 splitReferenceGroups）。
 */
export function resolveInputImageLimit({ sopMode, variableMode, plainImageMode, n }: InputImageLimitOptions): number {
  // SOP / 变量模式的图不进生图接口，只用于反推，放宽到 60；分组时每组再按 16 切
  if (sopMode || variableMode) return MAX_SOP_INPUT_IMAGES
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
