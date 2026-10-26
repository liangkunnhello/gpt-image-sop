import type { SavedSop } from '../types'
import { NO_PRESET, type SopPick } from './sopStore'

/**
 * 按「默认项 → 上次使用 → 就近第一条」决定当前用的是哪份 SOP。
 *
 * 与 resolveSystemPrompt 同构：scopeIds 是从当前节点往上的作用域链
 * （自身 → 父产品 → 类目），方向自己没配就继承产品的。
 *
 * 与系统提示词的区别只有一个：SOP 是「拿来直接出图」的成品流程，
 * 所以取不到时必须明确返回 undefined（走反推），不能随手退回第一条
 * ——否则用户以为自己在按参考图反推，实际在用某份存下来的 SOP 出图。
 */
export function resolveSavedSop(
  sops: SavedSop[],
  scopeIds: string[],
  directionId: string,
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
): SavedSop | undefined {
  const pick = defaultPick[directionId] ?? lastPick[directionId] ?? {}
  if (pick.sopId === NO_PRESET) return undefined
  if (!pick.sopId) return undefined
  for (const scopeId of scopeIds) {
    const hit = sops.find((item) => item.productId === scopeId && item.id === pick.sopId)
    if (hit) return hit
  }
  return undefined
}

/** 该方向是否显式选了「不用 SOP」（与「还没选」区分，用于选择器文案） */
export function isSavedSopOff(
  directionId: string,
  lastPick: Record<string, SopPick>,
  defaultPick: Record<string, SopPick>,
): boolean {
  return (defaultPick[directionId] ?? lastPick[directionId] ?? {}).sopId === NO_PRESET
}
