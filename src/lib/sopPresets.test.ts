import { describe, expect, it } from 'vitest'

import type { SopDirectionNode } from '../types'
import { NO_PRESET, type SopPick, type SopPreset } from './sopStore'
import { pointNameForDirection } from './sopPresets'

/**
 * 命名模板 {point} 取的是「这个方向当前生效的卖点名」：
 * 方向没配就继承产品，显式选「不使用」就留空，未归属（没有方向）也留空。
 */

function node(id: string, parentId: string | null, kind: SopDirectionNode['kind'], name?: string): SopDirectionNode {
  return { id, parentId, name: name ?? id, kind }
}

const tree = [
  node('产品A', null, 'product'),
  node('方向甲', '产品A', 'direction'),
  node('方向乙', '产品A', 'direction'),
]

const preset = (id: string, productId: string, name: string, kind: SopPreset['kind'] = 'point'): SopPreset => ({
  id,
  productId,
  kind,
  name,
  content: `${name}的正文`,
  updatedAt: 0,
})

const noPick: Record<string, SopPick> = {}

describe('卖点名快照', () => {
  it('方向没配卖点时继承产品上的那一份', () => {
    const presets = [preset('k1', '产品A', '小病住院有保额')]
    expect(pointNameForDirection(tree, presets, '方向甲', noPick, noPick)).toBe('小病住院有保额')
  })

  it('方向自己选了就用方向那份', () => {
    const presets = [preset('k1', '产品A', '产品卖点'), preset('k2', '产品A', '方向专属卖点')]
    const lastPick: Record<string, SopPick> = { 方向甲: { pointId: 'k2' } }
    expect(pointNameForDirection(tree, presets, '方向甲', lastPick, noPick)).toBe('方向专属卖点')
    // 没选的方向仍然吃产品那份
    expect(pointNameForDirection(tree, presets, '方向乙', lastPick, noPick)).toBe('产品卖点')
  })

  it('显式选「不使用」时留空，不会退回继承', () => {
    const presets = [preset('k1', '产品A', '产品卖点')]
    const lastPick: Record<string, SopPick> = { 方向甲: { pointId: NO_PRESET } }
    expect(pointNameForDirection(tree, presets, '方向甲', lastPick, noPick)).toBe('')
  })

  it('未归属（没有方向）或整条链都没配时留空', () => {
    const presets = [preset('k1', '产品A', '产品卖点')]
    expect(pointNameForDirection(tree, presets, undefined, noPick, noPick)).toBe('')
    expect(pointNameForDirection(tree, presets, '', noPick, noPick)).toBe('')
    expect(pointNameForDirection(tree, [], '方向甲', noPick, noPick)).toBe('')
    // 别的产品的卖点不能串过来
    expect(pointNameForDirection(tree, [preset('k9', '产品B', '别家的')], '方向甲', noPick, noPick)).toBe('')
  })

  it('只认卖点，别把风格的名字当卖点', () => {
    const presets = [preset('s1', '产品A', '2D手绘风', 'style')]
    expect(pointNameForDirection(tree, presets, '方向甲', noPick, noPick)).toBe('')
  })
})
