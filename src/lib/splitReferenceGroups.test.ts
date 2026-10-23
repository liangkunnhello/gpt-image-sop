import { describe, expect, it } from 'vitest'

import { splitReferenceGroups } from './sopPipeline'
import { MAX_INPUT_IMAGES } from '../types'

const seq = (count: number) => Array.from({ length: count }, (_, index) => index + 1)

describe('splitReferenceGroups', () => {
  it('不超过上限时按选择的卡数均分', () => {
    expect(splitReferenceGroups(seq(10), 1).map((group) => group.length)).toEqual([10])
    expect(splitReferenceGroups(seq(10), 2).map((group) => group.length)).toEqual([5, 5])
  })

  it('单卡内超过 16 张时自动多分卡', () => {
    expect(splitReferenceGroups(seq(40), 1).map((group) => group.length)).toEqual([16, 16, 8])
  })

  it('用户选了多张卡、均分后仍超限时，每张卡继续切', () => {
    // 40 张分 2 卡 = 每卡 20 张，还要再各切成 16 + 4
    const groups = splitReferenceGroups(seq(40), 2)
    expect(groups.map((group) => group.length)).toEqual([16, 4, 16, 4])
  })

  it('正好卡在上限时不再多切', () => {
    const groups = splitReferenceGroups(seq(MAX_INPUT_IMAGES * 2), 2)
    expect(groups.map((group) => group.length)).toEqual([MAX_INPUT_IMAGES, MAX_INPUT_IMAGES])
  })

  it('每张卡都不超过上限，且图片一张不丢', () => {
    const groups = splitReferenceGroups(seq(60), 3)
    expect(groups.every((group) => group.length <= MAX_INPUT_IMAGES)).toBe(true)
    expect(groups.flat()).toEqual(seq(60))
  })

  it('没有参考图时保留一个空组（表示无图 1 卡）', () => {
    expect(splitReferenceGroups([], 1)).toEqual([[]])
  })
})
