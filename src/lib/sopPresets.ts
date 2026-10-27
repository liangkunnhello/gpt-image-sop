import type { SopDirectionNode } from '../types'
import { NO_PRESET, type SopPick, type SopPreset } from './sopStore'
import { scopeChain } from './sopScope'

/**
 * 卖点 / 风格的「当前生效项」解析。
 *
 * 原来写在 SopPresetPicker 组件里，但命名（{point}）、任务快照也要用同一套规则，
 * 所以挪进 lib，组件再 re-export 保持原来的引入路径不变。
 */

/**
 * 按「默认项 → 上次使用 → 就近第一条」决定当前选中的卖点/风格。
 * scopeIds 是自身 → 父 → 根的作用域链，方向没配就继承产品的。
 */
export function resolvePickedPreset(
  presets: SopPreset[],
  directionId: string,
  scopeIds: string[],
  kind: SopPreset['kind'],
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
) {
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  const id = kind === 'point' ? pick.pointId : pick.styleId
  if (id === NO_PRESET) return undefined
  if (id) {
    for (const scopeId of scopeIds) {
      const hit = presets.find((item) => item.productId === scopeId && item.kind === kind && item.id === id)
      if (hit) return hit
    }
    return undefined
  }
  for (const scopeId of scopeIds) {
    const first = presets.find((item) => item.productId === scopeId && item.kind === kind)
    if (first) return first
  }
  return undefined
}

/** 某个方向当前生效的卖点名；没方向 / 没配卖点 / 显式选了「不使用」都返回空串 */
export function pointNameForDirection(
  directions: SopDirectionNode[],
  presets: SopPreset[],
  directionId: string | undefined,
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
): string {
  if (!directionId) return ''
  const picked = resolvePickedPreset(
    presets,
    directionId,
    scopeChain(directions, directionId),
    'point',
    lastPick,
    defaultPick,
  )
  return picked?.name?.trim() ?? ''
}
