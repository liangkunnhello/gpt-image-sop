import { describe, expect, it } from 'vitest'
import { buildCopyPrefix, customCopyLines, customCopySummary, mergeTaskCopy } from './customCopy'

describe('本次文案：自定义（前）+ 卖点（后）', () => {
  it('两边都有时自定义排在前面，中间空行分段', () => {
    expect(mergeTaskCopy('赔付总限额600万', '带病投保也能赔\n免赔额一万'))
      .toBe('赔付总限额600万\n\n带病投保也能赔\n免赔额一万')
  })

  it('只填自定义文案时就是它本身', () => {
    expect(mergeTaskCopy('手写的一句', undefined)).toBe('手写的一句')
    expect(mergeTaskCopy('手写的一句', '')).toBe('手写的一句')
    expect(mergeTaskCopy('手写的一句', '   ')).toBe('手写的一句')
  })

  it('没填自定义文案时等于卖点原文（与改造前完全一致）', () => {
    expect(mergeTaskCopy('', '卖点原文')).toBe('卖点原文')
    expect(mergeTaskCopy(undefined, '卖点原文')).toBe('卖点原文')
  })

  it('两边都没有时给空串，不塞占位文本', () => {
    expect(mergeTaskCopy('', '')).toBe('')
    expect(mergeTaskCopy(undefined, undefined)).toBe('')
    expect(mergeTaskCopy('  \n  ', '  ')).toBe('')
  })

  it('自定义文案已被卖点包含时不重复（手写的常常就是卖点里的一句）', () => {
    expect(mergeTaskCopy('带病投保也能赔', '赔付总限额600万\n带病投保也能赔'))
      .toBe('赔付总限额600万\n带病投保也能赔')
  })

  it('首尾空白会被去掉，不会在提示词里留空行', () => {
    expect(mergeTaskCopy('  第一句  \n', ' 第二句 ')).toBe('第一句\n\n第二句')
  })
})

describe('本次文案的显示与拆句', () => {
  it('按钮上压成一行，太长就截断', () => {
    expect(customCopySummary('第一句\n第二句')).toBe('第一句 第二句')
    expect(customCopySummary('一二三四五六七八九十一二三四五', 8)).toBe('一二三四五六七八…')
  })

  it('空文案摘要为空（按钮显示「未填」由组件决定）', () => {
    expect(customCopySummary('   ')).toBe('')
  })

  it('拆句只按行与分号，不猜别的分隔', () => {
    expect(customCopyLines('赔付总限额600万\n带病投保也能赔；免赔额一万')).toEqual([
      '赔付总限额600万',
      '带病投保也能赔',
      '免赔额一万',
    ])
    expect(customCopyLines('')).toEqual([])
  })
})

describe('普通模式的提示词前缀', () => {
  /** 普通模式没有「文案区块」，只能把文案平铺进提示词前缀 */
  function presetPrefix(customCopy: string, point: string, style: string): string {
    return buildCopyPrefix({ customCopy, point, style })
  }

  it('自定义文案与卖点各带标签、各自成行（分得清哪句是手写的）', () => {
    expect(presetPrefix('赔付总限额600万', '带病投保也能赔', '')).toBe(
      '文案：赔付总限额600万\n卖点：带病投保也能赔',
    )
  })

  it('只有卖点时与改造前完全一致', () => {
    expect(presetPrefix('', '带病投保也能赔', '高级灰')).toBe('卖点：带病投保也能赔\n风格：高级灰')
  })

  it('只有自定义文案时不会有空的「卖点：」行', () => {
    expect(presetPrefix('手写文案', '', '')).toBe('文案：手写文案')
  })

  it('三种都没有时前缀为空（不往提示词里加空行）', () => {
    expect(presetPrefix('', '', '')).toBe('')
    expect(presetPrefix('  ', '   ', ' ')).toBe('')
  })
})
