/**
 * 「派发」：拿同一批 AI 原图，分别套多个产品 / 方向的后处理模板（水印、Logo），
 * 一个目标出一份成品，落到该目标自己的交付地址，并在应用内生成一张卡。
 *
 * 与「再次后处理」的区别：
 * - 再次后处理：把原图重套「当前」模板，覆盖这张卡原来的成品；
 * - 派发：同一张原图复制多份，各套各的模板，原来的卡一动不动，新增几张卡。
 *
 * 这里只放纯函数（选目标、挑模板、数张数），真正读写图片与磁盘在 store 里，
 * 界面拿这里的函数算预览，和实际执行走同一套判断，不会出现「界面说 3 张、实际出 2 张」。
 */

import type { SopDirectionNode } from '../types'
import { resolvePostTemplates } from './applyPostTemplate'
import { directionPath } from './sopStore'
import { pickTemplateForImage, type PostTemplate } from './postTemplate'

/** 一个可派发的目标：产品或方向，带它真正生效的模板 */
export interface DispatchCandidate {
  id: string
  name: string
  /** 「保险 / 百万医疗险 / 月亮」，用来区分重名节点 */
  path: string
  scope: 'product' | 'direction'
  /**
   * 这个目标实际生效的模板（方向专属优先，没配才继承产品），只留启用的。
   * 空数组的目标不会出现在列表里 —— 没有水印 / Logo 就谈不上派发。
   */
  templates: PostTemplate[]
}

/** 原图尺寸，挑模板时只看比例 */
export interface DispatchImageSize {
  width: number
  height: number
}

/**
 * 列出可以派发的目标。
 *
 * 只认挂在父级下的节点（产品、方向）：顶层类目只是分组容器，任务卡挂不上去。
 * 没有启用模板的节点直接过滤掉，避免用户勾了一堆却什么也出不来。
 */
export function dispatchCandidates(
  nodes: SopDirectionNode[],
  templates: Record<string, PostTemplate[]>,
): DispatchCandidate[] {
  const active = nodes.filter((node) => !node.deletedAt)
  const candidates: DispatchCandidate[] = []
  for (const node of active) {
    if (!node.parentId) continue
    const resolved = resolvePostTemplates(templates, nodes, node.id)
    const enabled = resolved.templates.filter((item) => item.enabled)
    if (!enabled.length) continue
    candidates.push({
      id: node.id,
      name: node.name,
      path: directionPath(nodes, node.id),
      // 挂在产品上的模板对它的所有方向都生效，所以产品本身也是合法目标
      scope: node.kind === 'direction' ? 'direction' : 'product',
      templates: enabled,
    })
  }
  // 按路径排，同一产品的方向聚在一起，勾选时更好找
  return candidates.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
}

/**
 * 给一张原图挑模板：先按渠道挑（渠道专属优先、其次通用），
 * 这个渠道下一套都没有时退回「只看比例」。
 *
 * 为什么要有后半段：派发本来就是「同一张图给别的产品复用」，
 * 渠道是原卡的投放渠道，目标产品的模板往往标的是另一个渠道。
 * 卡死在渠道上会让用户勾了目标却一张都出不来，比「套了别的渠道的版式」更糟。
 */
export function pickDispatchTemplate(
  templates: PostTemplate[],
  width: number,
  height: number,
  channel?: string,
): PostTemplate | null {
  return pickTemplateForImage(templates, width, height, channel)
    ?? (channel ? pickTemplateForImage(templates, width, height) : null)
}

/** 这个目标能给这几张原图出几张：比例与模板对不上的跳过 */
export function countDispatchable(
  candidate: DispatchCandidate,
  sizes: DispatchImageSize[],
  channel?: string,
): number {
  let count = 0
  for (const size of sizes) {
    if (pickDispatchTemplate(candidate.templates, size.width, size.height, channel)) count += 1
  }
  return count
}

/**
 * 比例对不上时的说明。
 *
 * 模板是按比例挑的，竖图配一套方图模板会被硬裁掉大半画面，
 * 所以宁可跳过，也要让用户知道为什么少了张。
 */
export function dispatchSkipNote(skipped: number, total: number): string {
  if (skipped <= 0) return ''
  // 一张都没出时说法要更明确，否则用户只看到「0 张」不知道为什么
  if (skipped >= total) return '这套模板的比例和这批原图全对不上'
  return `有 ${skipped} 张原图的比例对不上，已跳过`
}
