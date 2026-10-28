import { describe, expect, it } from 'vitest'

import {
  POST_LINE_HEIGHT,
  POST_RATIO_TOLERANCE,
  commitNumberInput,
  createPostTemplate,
  defaultPostTemplate,
  elementBox,
  elementLineHeight,
  newPostElement,
  pickTemplateForImage,
  postTemplateRatioKey,
} from './postTemplate'

const make = (width: number, height: number, patch: Partial<ReturnType<typeof createPostTemplate>> = {}) => ({
  ...createPostTemplate(width, height, `${width}x${height}`),
  enabled: true,
  ...patch,
})

describe('pickTemplateForImage', () => {
  it('只套用比例一致的模板', () => {
    const templates = [make(1440, 2560), make(2048, 2048)]
    expect(pickTemplateForImage(templates, 2160, 3840)?.width).toBe(1440)
    expect(pickTemplateForImage(templates, 2048, 2048)?.width).toBe(2048)
  })

  it('比例对不上时返回 null，原图保持不动', () => {
    const templates = [make(1440, 2560)]
    expect(pickTemplateForImage(templates, 2560, 1440)).toBeNull()
    expect(pickTemplateForImage(templates, 1638, 2048)).toBeNull()
  })

  it('未启用的模板不参与', () => {
    const templates = [make(1440, 2560, { enabled: false })]
    expect(pickTemplateForImage(templates, 1440, 2560)).toBeNull()
  })

  it('同比例有默认时用默认，否则随机取一套', () => {
    const preferred = make(1440, 2560, { isDefault: true, label: '默认' })
    const others = [make(900, 1600, { label: 'B' }), make(1080, 1920, { label: 'C' })]
    expect(pickTemplateForImage([others[0], preferred, others[1]], 1440, 2560)?.label).toBe('默认')

    const noDefault = [make(900, 1600), make(1080, 1920)]
    const picked = pickTemplateForImage(noDefault, 1440, 2560)
    expect(noDefault.map((item) => item.id)).toContain(picked?.id)
  })

  it('容差内算同一比例，超出就不算', () => {
    const templates = [make(1000, 1000)]
    // 1:0.98 在 2% 以内
    expect(pickTemplateForImage(templates, 1000, 980)).not.toBeNull()
    // 1:1.05 超出容差
    expect(pickTemplateForImage(templates, 1000, 1050)).toBeNull()
    expect(POST_RATIO_TOLERANCE).toBe(0.02)
  })

  it('默认模板带一套可编辑的文字元素', () => {
    const template = defaultPostTemplate()
    expect(template.elements.length).toBeGreaterThan(0)
    expect(template.elements.every((item) => item.x >= 0 && item.x <= 1)).toBe(true)
  })
})

describe('按渠道挑模板', () => {
  it('同渠道优先，哪怕通用模板设了默认', () => {
    const universal = make(1440, 2560, { label: '通用', isDefault: true })
    const gdt = make(1440, 2560, { label: '广点通', channel: 'gdt' })
    expect(pickTemplateForImage([universal, gdt], 1440, 2560, 'gdt')?.label).toBe('广点通')
  })

  it('该渠道没配模板时回落到通用模板', () => {
    const universal = make(1440, 2560, { label: '通用' })
    const toutiao = make(1440, 2560, { channel: 'toutiao', label: '头条' })
    expect(pickTemplateForImage([universal, toutiao], 1440, 2560, 'gdt')?.label).toBe('通用')
  })

  it('只有别的渠道的模板时不跨渠道硬套', () => {
    const toutiao = make(1440, 2560, { channel: 'toutiao' })
    expect(pickTemplateForImage([toutiao], 1440, 2560, 'gdt')).toBeNull()
  })

  it('任务没渠道时保持原行为，任意比例匹配的模板都能用', () => {
    const gdt = make(1440, 2560, { channel: 'gdt', isDefault: true })
    expect(pickTemplateForImage([gdt], 1440, 2560)?.id).toBe(gdt.id)
  })
})

describe('比例筛选归组', () => {
  it('预设比例归到对应档位', () => {
    expect(postTemplateRatioKey({ width: 1440, height: 2560 })).toBe('9:16')
    expect(postTemplateRatioKey({ width: 2560, height: 1440 })).toBe('16:9')
    expect(postTemplateRatioKey({ width: 2048, height: 2048 })).toBe('1:1')
  })

  it('非预设比例单独归到 other，尺寸非法也不报错', () => {
    expect(postTemplateRatioKey({ width: 1200, height: 500 })).toBe('other')
    expect(postTemplateRatioKey({ width: 0, height: 0 })).toBe('other')
  })
})

describe('commitNumberInput（尺寸输入框的提交值）', () => {
  it('合法的四位尺寸原样提交，不被下限影响', () => {
    expect(commitNumberInput('2560', 840, { min: 64 })).toBe(2560)
    expect(commitNumberInput('1460', 840, { min: 64 })).toBe(1460)
  })

  it('空草稿或非数字保留原值，不会把 0 写进去', () => {
    // 删空时回到上一次的值，而不是变成下限 —— 否则接着输入就会拼成 64xx
    expect(commitNumberInput('', 840, { min: 64 })).toBe(840)
    expect(commitNumberInput('.', 840, { min: 64 })).toBe(840)
    expect(commitNumberInput('abc', 840, { min: 64 })).toBe(840)
  })

  it('低于下限的提交值夹到下限', () => {
    expect(commitNumberInput('10', 840, { min: 64 })).toBe(64)
    expect(commitNumberInput('64', 840, { min: 64 })).toBe(64)
  })

  it('超过上限的夹到上限', () => {
    expect(commitNumberInput('9999', 840, { min: 8, max: 300 })).toBe(300)
  })

  it('默认取整', () => {
    expect(commitNumberInput('840.6', 1, { min: 1 })).toBe(841)
  })

  it('允许小数时保留小数，并按 step 对齐', () => {
    expect(commitNumberInput('2.7', 1, { min: 0, step: 0.5, integer: false })).toBe(2.5)
    expect(commitNumberInput('3.1', 1, { min: 0, step: 0.5, integer: false })).toBe(3)
  })

  it('字号这类下限为 1 的输入框不会被写成 1 之外的值', () => {
    expect(commitNumberInput('32', 24, { min: 1 })).toBe(32)
    expect(commitNumberInput('0', 24, { min: 1 })).toBe(1)
  })
})

describe('文字对齐、行距与字间距', () => {
  const base = () => newPostElement('text', 1)

  it('行距没设过用默认值，设了会被夹到可用区间', () => {
    expect(elementLineHeight(base())).toBe(POST_LINE_HEIGHT)
    expect(elementLineHeight({ lineHeight: 2 })).toBe(2)
    expect(elementLineHeight({ lineHeight: 0.1 })).toBe(0.9)
    expect(elementLineHeight({ lineHeight: 99 })).toBe(2.5)
  })

  it('行距变大，占位框跟着变高', () => {
    const el = { ...base(), text: '第一行\n第二行', fontSize: 100 }
    const normal = elementBox({ ...el, lineHeight: 1 }, 1000, 1000)
    const loose = elementBox({ ...el, lineHeight: 2 }, 1000, 1000)
    expect(loose.y1 - loose.y0).toBeGreaterThan(normal.y1 - normal.y0)
    // 高度 = 行数 × 字号 × 行距
    expect(loose.y1 - loose.y0).toBeCloseTo(0.4, 5)
  })

  it('字间距变大，占位框跟着变宽（最后一个字后面不留间距）', () => {
    const el = { ...base(), text: '四个字符', fontSize: 100 }
    const tight = elementBox({ ...el, letterSpacing: 0 }, 1000, 1000)
    const loose = elementBox({ ...el, letterSpacing: 20 }, 1000, 1000)
    const delta = (loose.x1 - loose.x0) - (tight.x1 - tight.x0)
    expect(delta).toBeCloseTo((3 * 20) / 1000, 5)
  })

  it('居中对齐以 x 为中心往两边展开，右对齐以 x 为右边界', () => {
    const el = { ...base(), text: '四个字', fontSize: 100, x: 0.5, letterSpacing: 0 }
    const center = elementBox({ ...el, align: 'center' }, 1000, 1000)
    expect((center.x0 + center.x1) / 2).toBeCloseTo(0.5, 5)
    const right = elementBox({ ...el, align: 'right' }, 1000, 1000)
    expect(right.x1).toBeCloseTo(0.5, 5)
    const left = elementBox({ ...el, align: 'left' }, 1000, 1000)
    expect(left.x0).toBeCloseTo(0.5, 5)
  })
})
