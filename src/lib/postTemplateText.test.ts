import { describe, expect, it } from 'vitest'

import { POST_TEXT_BOX_MIN_WIDTH, resizeTextBoxWidth, textBoxBounds, wrapTextToWidth, type PostElement } from './postTemplate'

/**
 * 真实问题：后处理模板里的「警示语」是一大段中文（十几行），
 * 以前只按 `\n` 断行、没有宽度约束，长行就一路往右排，
 * 直接冲出 1080×1920 的画布边框（用户截图里整块文字溢出到框外）。
 *
 * 这里锁三件事：
 * 1. 文字框边界按对齐方式算，锚点仍是 x；
 * 2. 没有 boxWidth 时自动撑到画布边，且老模板（本来就短）的绘制起点不变；
 * 3. 折行函数不漏字、不死循环、保留手动换行。
 */
describe('textBoxBounds 文字框边界', () => {
  const W = 1000

  it('左对齐没有框宽：从锚点撑到画布右边', () => {
    const box = textBoxBounds({ x: 0.2, align: 'left' }, W)
    expect(box.left).toBe(200)
    expect(box.maxWidth).toBe(800)
  })

  it('右对齐没有框宽：从画布左边撑到锚点', () => {
    const box = textBoxBounds({ x: 0.8, align: 'right' }, W)
    expect(box.left).toBe(0)
    expect(box.maxWidth).toBe(800)
  })

  it('居中且没有框宽：以锚点为中心，两侧撑到较近的边', () => {
    const box = textBoxBounds({ x: 0.3, align: 'center' }, W)
    // 左边 300 更近，所以半宽 300，总宽 600
    expect(box.left).toBe(0)
    expect(box.maxWidth).toBe(600)
  })

  it('设置了框宽：三种对齐都以锚点为对应边界', () => {
    expect(textBoxBounds({ x: 0.5, align: 'left', boxWidth: 0.4 }, W)).toEqual({ left: 500, maxWidth: 400 })
    expect(textBoxBounds({ x: 0.5, align: 'center', boxWidth: 0.4 }, W)).toEqual({ left: 300, maxWidth: 400 })
    expect(textBoxBounds({ x: 0.5, align: 'right', boxWidth: 0.4 }, W)).toEqual({ left: 100, maxWidth: 400 })
  })

  /**
   * 向后兼容的关键：没有 boxWidth 时，按新旧两种口径算出的绘制起点必须相同，
   * 否则所有老模板的位置会整体偏移。
   */
  it('没有框宽时，框的锚点仍然等于原来的 x*w', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      for (const x of [0.1, 0.5, 0.9]) {
        const box = textBoxBounds({ x, align }, W)
        const drawX = align === 'center'
          ? box.left + box.maxWidth / 2
          : align === 'right'
            ? box.left + box.maxWidth
            : box.left
        expect(drawX).toBeCloseTo(x * W, 6)
      }
    }
  })

  it('x 超界时按画布内取值，不会算出负宽度', () => {
    const box = textBoxBounds({ x: 1.5, align: 'left' }, W)
    expect(box.maxWidth).toBeGreaterThanOrEqual(1)
    expect(box.left).toBe(1000)
  })
})

describe('wrapTextToWidth 折行', () => {
  /** 每个字符固定 10px 宽，方便断言 */
  const measure = (chunk: string) => chunk.length * 10

  it('宽度够时不折行', () => {
    expect(wrapTextToWidth('三高可投保', 200, measure)).toEqual(['三高可投保'])
  })

  it('超过宽度时按字折行，不漏字', () => {
    const lines = wrapTextToWidth('一二三四五六七八九十', 30, measure)
    expect(lines).toEqual(['一二三', '四五六', '七八九', '十'])
    expect(lines.join('')).toBe('一二三四五六七八九十')
  })

  it('保留用户手动换的行', () => {
    expect(wrapTextToWidth('第一行\n第二行', 200, measure)).toEqual(['第一行', '第二行'])
  })

  it('手动换行与自动折行可以同时存在', () => {
    expect(wrapTextToWidth('一二三四\n五', 30, measure)).toEqual(['一二三', '四', '五'])
  })

  it('单字就超宽时仍然输出，不会死循环', () => {
    expect(wrapTextToWidth('一二三', 5, measure)).toEqual(['一', '二', '三'])
  })

  it('空字符串返回空数组', () => {
    expect(wrapTextToWidth('', 100, measure)).toEqual([''])
  })
})

describe('PostElement 的 boxWidth 是可选字段', () => {
  it('老模板没有这个字段也能取到自动宽度', () => {
    const legacy = { id: 'x', kind: 'text', x: 0.5, y: 0.9, align: 'center' } as unknown as PostElement
    const box = textBoxBounds(legacy, 1080)
    expect(box.maxWidth).toBe(1080)
    expect(box.left).toBe(0)
  })
})

/**
 * 画布上拖框边改宽度：锚点 x 不动，只改 boxWidth。
 * 三种对齐的「非锚点侧」不同，算出来的宽度必须与拖拽方向一致，
 * 否则手感是反的（往右拖反而变窄）。
 */
describe('resizeTextBoxWidth 拖框边', () => {
  it('左对齐：框左边在锚点，往右拖变宽', () => {
    expect(resizeTextBoxWidth({ x: 0.2, align: 'left' }, 0.6)).toBeCloseTo(0.4, 6)
    expect(resizeTextBoxWidth({ x: 0.2, align: 'left' }, 0.3)).toBeCloseTo(0.1, 6)
  })

  it('右对齐：框右边在锚点，往左拖变宽', () => {
    expect(resizeTextBoxWidth({ x: 0.8, align: 'right' }, 0.4)).toBeCloseTo(0.4, 6)
    expect(resizeTextBoxWidth({ x: 0.8, align: 'right' }, 0.7)).toBeCloseTo(0.1, 6)
  })

  it('居中：锚点在框中心，拖任一边都对称展开', () => {
    expect(resizeTextBoxWidth({ x: 0.5, align: 'center' }, 0.7)).toBeCloseTo(0.4, 6)
    expect(resizeTextBoxWidth({ x: 0.5, align: 'center' }, 0.3)).toBeCloseTo(0.4, 6)
  })

  it('不超过画布另一边', () => {
    // 左对齐、锚点 0.2，最多到画布右边 = 0.8
    expect(resizeTextBoxWidth({ x: 0.2, align: 'left' }, 1)).toBeCloseTo(0.8, 6)
    // 右对齐、锚点 0.8，最多到画布左边 = 0.8
    expect(resizeTextBoxWidth({ x: 0.8, align: 'right' }, 0)).toBeCloseTo(0.8, 6)
    // 居中在 0.5，两侧各 0.5
    expect(resizeTextBoxWidth({ x: 0.5, align: 'center' }, 1)).toBeCloseTo(1, 6)
  })

  it('有最小宽度，拖过头不会变成 0', () => {
    expect(resizeTextBoxWidth({ x: 0.2, align: 'left' }, 0.05)).toBe(POST_TEXT_BOX_MIN_WIDTH)
    expect(resizeTextBoxWidth({ x: 0.8, align: 'right' }, 0.99)).toBe(POST_TEXT_BOX_MIN_WIDTH)
  })

  it('指针超出画布时按边界算', () => {
    expect(resizeTextBoxWidth({ x: 0.2, align: 'left' }, 2)).toBeCloseTo(0.8, 6)
    expect(resizeTextBoxWidth({ x: 0.8, align: 'right' }, -1)).toBeCloseTo(0.8, 6)
  })
})
