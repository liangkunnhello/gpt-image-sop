import { describe, expect, it } from 'vitest'
import {
  boxSelect,
  clickSelect,
  EMPTY_SELECTION,
  isSelected,
  primarySelectedId,
  pruneSelection,
  rectFromPoints,
  rectIntersects,
  selectAll,
} from './gallerySelection'

const ORDER = ['a', 'b', 'c', 'd', 'e']

describe('单击选择', () => {
  it('普通单击只留这一张', () => {
    const after = clickSelect({ ids: ['a', 'b'], anchorId: 'b' }, ORDER, 'd')
    expect(after.ids).toEqual(['d'])
    expect(after.anchorId).toBe('d')
  })

  it('Ctrl 单击加选，再点同一张就取消', () => {
    const added = clickSelect({ ids: ['a'], anchorId: 'a' }, ORDER, 'c', { toggle: true })
    expect(added.ids).toEqual(['a', 'c'])

    const removed = clickSelect(added, ORDER, 'a', { toggle: true })
    expect(removed.ids).toEqual(['c'])
    // 加选 c 时锚点已经移到 c；这里取消的是 a，锚点保持不动
    expect(removed.anchorId).toBe('c')
  })

  it('取消掉锚点本身时锚点清空，避免 Shift 从一张没选中的图开始连选', () => {
    const state = { ids: ['a', 'c'], anchorId: 'c' }
    const after = clickSelect(state, ORDER, 'c', { toggle: true })
    expect(after.ids).toEqual(['a'])
    expect(after.anchorId).toBeNull()
  })

  it('Ctrl 取消非锚点的项时，锚点保持不动', () => {
    const state = { ids: ['a', 'c'], anchorId: 'c' }
    const after = clickSelect(state, ORDER, 'a', { toggle: true })
    expect(after.ids).toEqual(['c'])
    expect(after.anchorId).toBe('c')
  })

  it('Shift 连选：往下选一段', () => {
    const after = clickSelect({ ids: ['a'], anchorId: 'a' }, ORDER, 'd', { range: true })
    expect(after.ids).toEqual(['a', 'b', 'c', 'd'])
    // 锚点不跟着终点走，否则再 Shift 点一次就变成从 d 开始
    expect(after.anchorId).toBe('a')
  })

  it('Shift 连选：往上选也算（方向无关）', () => {
    const after = clickSelect({ ids: ['d'], anchorId: 'd' }, ORDER, 'b', { range: true })
    expect(after.ids).toEqual(['b', 'c', 'd'])
    expect(after.anchorId).toBe('d')
  })

  it('没有锚点时的 Shift：退回最后一个已选项当起点', () => {
    const after = clickSelect({ ids: ['b'], anchorId: null }, ORDER, 'd', { range: true })
    expect(after.ids).toEqual(['b', 'c', 'd'])
  })

  it('完全没选过时的 Shift：只选点中的那张', () => {
    const after = clickSelect(EMPTY_SELECTION, ORDER, 'c', { range: true })
    expect(after.ids).toEqual(['c'])
    expect(after.anchorId).toBe('c')
  })

  it('锚点已不在列表里（换过筛选）时，Shift 不炸，退回只选这一张', () => {
    const after = clickSelect({ ids: ['x'], anchorId: 'x' }, ['a', 'b'], 'b', { range: true })
    // x 不在 order 里 → 连选无从算起；至少要把点中的那张选上
    expect(after.ids).toEqual(['b'])
  })

  it('点不在列表里的项不做任何改动', () => {
    const before = { ids: ['a'], anchorId: 'a' }
    expect(clickSelect(before, ORDER, 'zzz')).toBe(before)
  })

  it('Ctrl 与 Shift 同时按下时以 Ctrl（加选）为准，避免规则打架', () => {
    const after = clickSelect({ ids: ['a'], anchorId: 'a' }, ORDER, 'c', { toggle: true, range: true })
    expect(after.ids).toEqual(['a', 'c'])
  })
})

describe('框选', () => {
  it('不按 Ctrl：替换掉之前的选择', () => {
    const after = boxSelect([], ['b', 'c'])
    expect(after.ids).toEqual(['b', 'c'])
  })

  it('按住 Ctrl：把框到的并进已有的选择', () => {
    const after = boxSelect(['a', 'd'], ['b', 'c'])
    expect(after.ids).toEqual(['a', 'd', 'b', 'c'])
  })

  it('重复的 id 不会重复计入（框多次、框到已选的）', () => {
    const after = boxSelect(['b'], ['b', 'c', 'c'])
    expect(after.ids).toEqual(['b', 'c'])
  })

  it('什么都没框到时保持原选择', () => {
    expect(boxSelect(['a'], []).ids).toEqual(['a'])
  })
})

describe('列表变化后收敛选择', () => {
  it('被删掉的项从选择里摘掉（不留看不见的选中项）', () => {
    const after = pruneSelection({ ids: ['a', 'c'], anchorId: 'c' }, ['a', 'b'])
    expect(after.ids).toEqual(['a'])
    // 锚点也不在了，一并清掉
    expect(after.anchorId).toBeNull()
  })

  it('没变化时返回原对象（避免每帧都触发重渲染）', () => {
    const state = { ids: ['a'], anchorId: 'a' }
    expect(pruneSelection(state, ORDER)).toBe(state)
  })
})

describe('全选与主选中项', () => {
  it('全选按界面顺序排', () => {
    expect(selectAll(ORDER).ids).toEqual(ORDER)
    expect(selectAll(ORDER).anchorId).toBe('a')
  })

  it('列表为空时全选得到空选择', () => {
    expect(selectAll([])).toEqual(EMPTY_SELECTION)
  })

  it('多选时「当前这张」取最后选中的那张（后点的算主）', () => {
    expect(primarySelectedId({ ids: ['a', 'c'], anchorId: 'a' })).toBe('c')
    expect(primarySelectedId(EMPTY_SELECTION)).toBe('')
  })

  it('isSelected 判断', () => {
    expect(isSelected({ ids: ['a'], anchorId: 'a' }, 'a')).toBe(true)
    expect(isSelected({ ids: ['a'], anchorId: 'a' }, 'b')).toBe(false)
  })
})

describe('矩形碰撞（框选用）', () => {
  const tile = { left: 10, top: 20, width: 100, height: 100 }

  it('相交就选中', () => {
    expect(rectIntersects({ left: 50, top: 50, width: 20, height: 20 }, tile)).toBe(true)
  })

  it('只碰到边角也算（不必完全覆盖）', () => {
    expect(rectIntersects({ left: 105, top: 25, width: 10, height: 10 }, tile)).toBe(true)
  })

  it('完全在外不算', () => {
    expect(rectIntersects({ left: 200, top: 200, width: 10, height: 10 }, tile)).toBe(false)
  })

  it('零面积的框不碰任何东西（刚按下还没拖时不该乱选）', () => {
    expect(rectIntersects({ left: 50, top: 50, width: 0, height: 0 }, tile)).toBe(false)
    expect(rectIntersects({ left: 50, top: 50, width: 20, height: 20 }, { ...tile, height: 0 })).toBe(false)
  })

  it('往任意方向拖都得到规范化矩形', () => {
    expect(rectFromPoints(100, 100, 20, 40)).toEqual({ left: 20, top: 40, width: 80, height: 60 })
    expect(rectFromPoints(20, 40, 100, 100)).toEqual({ left: 20, top: 40, width: 80, height: 60 })
  })
})
