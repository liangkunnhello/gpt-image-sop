import { describe, expect, it } from 'vitest'

import {
  POST_RATIO_TOLERANCE,
  createPostTemplate,
  defaultPostTemplate,
  pickTemplateForImage,
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
