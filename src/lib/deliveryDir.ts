/**
 * 交付地址的作用域解析。
 *
 * 三级都可配置：业务线 → 产品 → 方向。规则和用户的说法逐字对齐：
 * 每个层级自己配了就只用自己这条，没配才向上复用上一层的；
 * 三层都没配则返回 null，由调用方决定回退到默认保存地址。
 *
 * 为什么不复用 applyPostTemplate 的 resolvePostTemplates：那里是「方向 / 产品」两层
 * 且方向配了就完全屏蔽产品；交付地址是任意层级沿祖先链找第一个配过的，
 * 业务线这一层也要参与，所以按 scopeChain 走整条链更直接。
 */

import type { SopDirectionNode } from '../types'
import { scopeChain } from './sopScope'

export interface ResolvedDeliveryDir {
  /** 实际生效的节点 id，用于界面显示「继承自 xxx」 */
  ownerId: string
  /** 绝对路径 */
  path: string
}

/**
 * 取某个节点真正生效的交付地址。
 *
 * 传进来的 directionId 可以是任意层级（业务线 / 产品 / 方向）：
 * 任务卡挂在哪一层，就从那一层开始往上找。
 */
export function resolveDeliveryDir(
  deliveryDirs: Record<string, string>,
  directions: SopDirectionNode[],
  nodeId: string | undefined,
): ResolvedDeliveryDir | null {
  if (!nodeId) return null
  for (const id of scopeChain(directions, nodeId)) {
    const path = deliveryDirs[id]?.trim()
    if (path) return { ownerId: id, path }
  }
  return null
}

/** 这个节点自己有没有配交付地址（用于右键菜单显示「已配置 / 继承中」） */
export function hasOwnDeliveryDir(deliveryDirs: Record<string, string>, nodeId: string): boolean {
  return Boolean(deliveryDirs[nodeId]?.trim())
}
