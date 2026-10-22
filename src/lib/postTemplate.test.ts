import { describe, expect, it } from 'vitest'

import {
  POST_RATIO_TOLERANCE,
  createPostTemplate,
  defaultPostTemplate,
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
