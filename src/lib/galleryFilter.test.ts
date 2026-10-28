import { describe, expect, it } from 'vitest'
import { filterGalleryIndexes, galleryFilterCounts } from './galleryFilter'

/**
 * 详情页画廊按质检标签筛选。
 * 关键一点：筛选返回的是**原始下标**，编号/选中态/灯箱翻页才不会错位。
 */
const verdicts: Record<string, 'pass' | 'fail' | 'unsure'> = {
  a: 'pass',
  b: 'fail',
  c: 'unsure',
  d: 'pass',
}
const dups: Record<string, number> = { a: 0.95, b: 0.4, c: 0.93, d: 0.1 }
const ids = ['a', 'b', 'c', 'd']
const verdictOf = (id: string) => (verdicts[id] ? { verdict: verdicts[id] } : null)
const dupOf = (id: string) => dups[id] ?? 0

describe('画廊质检标签筛选', () => {
  it('统计每类张数与超过判定线的重复', () => {
    expect(galleryFilterCounts(ids, verdictOf, dupOf, 0.92)).toEqual({ pass: 2, unsure: 1, fail: 1, dup: 2 })
  })

  it('全部时原样返回所有下标', () => {
    expect(filterGalleryIndexes(ids, 'all', verdictOf, dupOf, 0.92)).toEqual([0, 1, 2, 3])
  })

  it('按结论筛出原始下标（不是筛后的新序号）', () => {
    expect(filterGalleryIndexes(ids, 'fail', verdictOf, dupOf, 0.92)).toEqual([1])
    expect(filterGalleryIndexes(ids, 'unsure', verdictOf, dupOf, 0.92)).toEqual([2])
    expect(filterGalleryIndexes(ids, 'pass', verdictOf, dupOf, 0.92)).toEqual([0, 3])
  })

  it('按重复度筛，超过判定线才算', () => {
    expect(filterGalleryIndexes(ids, 'dup', verdictOf, dupOf, 0.92)).toEqual([0, 2])
    // 判定线调高就筛不出东西
    expect(filterGalleryIndexes(ids, 'dup', verdictOf, dupOf, 0.99)).toEqual([])
  })

  it('还没质检 / 算不出重复度的图不混进任何一档', () => {
    const unknown = ['x', 'y']
    expect(filterGalleryIndexes(unknown, 'pass', verdictOf, dupOf, 0.92)).toEqual([])
    expect(galleryFilterCounts(unknown, verdictOf, dupOf, 0.92)).toEqual({ pass: 0, unsure: 0, fail: 0, dup: 0 })
  })

  it('空 id（失败槽位）不会混进来', () => {
    expect(filterGalleryIndexes(['', 'a'], 'all', verdictOf, dupOf, 0.92)).toEqual([0, 1])
    expect(filterGalleryIndexes(['', 'a'], 'pass', verdictOf, dupOf, 0.92)).toEqual([1])
  })
})
