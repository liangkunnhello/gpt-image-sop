import { describe, expect, it } from 'vitest'
import { postTemplateScale } from './applyPostTemplate'

/**
 * 成品画布 vs 模板画布的倍数。
 *
 * 灵境导出的模板画布基本是 1280×720，而生成图可能是 2560×1440。
 * 位置是比例、会自己跟着画布走，但字号/字间距/描边是像素值 —— 这个倍数算错，
 * 2K 成品上的字要么小成蚂蚁，要么撑满整张图。
 */
describe('postTemplateScale', () => {
  it('2K 图配 720p 模板 → 放大 2 倍', () => {
    expect(postTemplateScale(720, 1440)).toBe(2)
    // 1080p 模板配 1440 高的成品 → 1.33 倍
    expect(postTemplateScale(1080, 1440)).toBeCloseTo(1.3333, 3)
  })

  it('尺寸一致时不缩放', () => {
    expect(postTemplateScale(720, 720)).toBe(1)
  })

  it('脏数据（0 或负数）退回 1，别把字画成 0 号', () => {
    expect(postTemplateScale(0, 1440)).toBe(1)
    expect(postTemplateScale(720, 0)).toBe(1)
    expect(postTemplateScale(-1, 1440)).toBe(1)
  })
})
