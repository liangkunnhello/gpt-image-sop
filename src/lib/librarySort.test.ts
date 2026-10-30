import { describe, expect, it } from 'vitest'

import { newestFirst } from './librarySort'

const item = (id: string, updatedAt?: number) => ({ id, updatedAt })

describe('提示词库排序', () => {
  it('最新的排最上面', () => {
    const list = [item('old', 100), item('newest', 300), item('mid', 200)]
    expect(newestFirst(list).map((entry) => entry.id)).toEqual(['newest', 'mid', 'old'])
  })

  it('时间相同时保持原有顺序（稳定排序，列表不会来回跳）', () => {
    const list = [item('a', 100), item('b', 100), item('c', 100)]
    expect(newestFirst(list).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('缺时间的排最后，不会因为 NaN 打乱整体顺序', () => {
    const list = [item('no-time'), item('ok', 50), item('also-none', undefined)]
    expect(newestFirst(list).map((entry) => entry.id)).toEqual(['ok', 'no-time', 'also-none'])
  })

  it('不改动入参', () => {
    const list = [item('old', 1), item('new', 2)]
    const sorted = newestFirst(list)
    expect(list.map((entry) => entry.id)).toEqual(['old', 'new'])
    expect(sorted).not.toBe(list)
  })

  it('空列表原样返回', () => {
    expect(newestFirst([])).toEqual([])
  })
})
