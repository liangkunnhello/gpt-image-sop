import { describe, expect, it } from 'vitest'

import { splitReferenceGroups } from './sopPipeline'

const seq = (count: number) => Array.from({ length: count }, (_, index) => index + 1)

describe('splitReferenceGroups', () => {
  it('按选择的卡数均分，先分的组多分余数', () => {
    expect(splitReferenceGroups(seq(10), 1).map((group) => group.length)).toEqual([10])
    expect(splitReferenceGroups(seq(10), 2).map((group) => group.length)).toEqual([5, 5])
    expect(splitReferenceGroups(seq(10), 3).map((group) => group.length)).toEqual([4, 3, 3])
  })

  /**
   * 参考图只用于反推、不进生图接口，所以不存在 16 张的硬限制。
   * 选了 1 张卡就是 40 张一起送去反推，不再被悄悄切成 3 张卡。
   */
  it('单卡内超过 16 张也不再自动多分卡', () => {
    expect(splitReferenceGroups(seq(40), 1).map((group) => group.length)).toEqual([40])
  })

  it('选几张卡就分几张卡，与图片总数无关', () => {
    expect(splitReferenceGroups(seq(40), 2).map((group) => group.length)).toEqual([20, 20])
    expect(splitReferenceGroups(seq(60), 3).map((group) => group.length)).toEqual([20, 20, 20])
  })

  it('图片一张不丢，顺序保持', () => {
    expect(splitReferenceGroups(seq(100), 4).flat()).toEqual(seq(100))
  })

  it('没有参考图时保留一个空组（表示无图 1 卡）', () => {
    expect(splitReferenceGroups([], 1)).toEqual([[]])
  })
})
