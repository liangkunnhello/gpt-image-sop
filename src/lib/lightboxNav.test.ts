import { describe, expect, it } from 'vitest'
import { nextIndexAfterDelete, pinnedNavList } from './lightboxNav'

describe('灯箱：删除后不要退出查看', () => {
  const list = ['a', 'b', 'c']

  it('打开期间用钉住的列表，上层列表变了也不影响', () => {
    // 模拟：b 被移入回收站，上层列表只剩 a / c
    expect(pinnedNavList(list, 'b', ['a', 'c'], true)).toEqual(['a', 'b', 'c'])
    // 当前这张还在钉住的列表里 → 灯箱能继续显示它，不会因为消失而退出
    expect(pinnedNavList(list, 'b', ['a', 'c'], true)).toContain('b')
  })

  it('当前这张不在钉住列表里时改用最新列表（换过入口/列表被替换）', () => {
    expect(pinnedNavList(list, 'z', ['x', 'y'], true)).toEqual(['x', 'y'])
  })

  it('灯箱关掉后回到最新列表', () => {
    expect(pinnedNavList(list, null, ['a'], false)).toEqual(['a'])
  })

  it('删完往下一张走', () => {
    expect(nextIndexAfterDelete(list, 'b')).toBe(2)
  })

  it('删的是最后一张就回上一张', () => {
    expect(nextIndexAfterDelete(list, 'c')).toBe(1)
  })

  it('只剩一张时停在原地（继续显示，等用户自己关）', () => {
    expect(nextIndexAfterDelete(['a'], 'a')).toBe(0)
  })

  it('不在列表里返回 -1，调用方据此不动', () => {
    expect(nextIndexAfterDelete(list, 'z')).toBe(-1)
  })
})
