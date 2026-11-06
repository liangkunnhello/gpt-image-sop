import { describe, expect, it } from 'vitest'
import { lineageParentsOf } from './assetLineage'

const img = (id: string) => ({ id, dataUrl: '' })

/**
 * 「台账 → 作为参考图去画廊」的血缘传递。
 *
 * 用户在台账里挑一张图去画廊改，新任务卡应该记成那张图所属卡的衍生；
 * 用普通上传的参考图（映射里没有）则什么都不挂。
 */
describe('lineageParentsOf', () => {
  it('带出来的参考图能查到父卡', () => {
    expect(lineageParentsOf([img('a')], { a: 'card-1' })).toEqual(['card-1'])
  })

  it('多张同源只记一条边', () => {
    expect(lineageParentsOf([img('a'), img('b')], { a: 'card-1', b: 'card-1' })).toEqual(['card-1'])
  })

  it('普通上传的参考图不挂血缘', () => {
    expect(lineageParentsOf([img('x')], { a: 'card-1' })).toEqual([])
    expect(lineageParentsOf([], { a: 'card-1' })).toEqual([])
  })

  it('两张图来自不同的卡时都要挂', () => {
    expect(lineageParentsOf([img('a'), img('b')], { a: 'card-1', b: 'card-2' }).sort())
      .toEqual(['card-1', 'card-2'])
  })
})
