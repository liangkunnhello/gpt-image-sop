import { describe, expect, it } from 'vitest'
import { postCanvasSize, postTemplateScale } from './applyPostTemplate'

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

/**
 * 套完模板成品到底多大。
 *
 * 真实事故：模板上明明写着 1280×720，交付目录里却是 `…-2560x1440-梁坤` 的 18 张图。
 * 原因是画布按 AI 原图分辨率出了 —— 而 1280×720 才是投放平台收片的规格。
 */
describe('postCanvasSize', () => {
  const tpl = { width: 1280, height: 720 }

  it('默认按模板尺寸出图（原图 2K 也不放大）', () => {
    expect(postCanvasSize(tpl, 2560, 1440)).toEqual({ width: 1280, height: 720, scale: 1, mode: 'template' })
  })

  it('显式选了「跟随原图」才保持 2K，字号按倍数放大', () => {
    const result = postCanvasSize({ ...tpl, outputSizeMode: 'source' }, 2560, 1440)
    expect(result).toEqual({ width: 2560, height: 1440, scale: 2, mode: 'source' })
  })

  it('原图比模板小时不放大（避免糊），仍按模板尺寸出', () => {
    expect(postCanvasSize(tpl, 640, 360)).toMatchObject({ width: 1280, height: 720, scale: 1 })
  })

  it('显式 outputSize 优先，优先级高于模板口径', () => {
    expect(postCanvasSize({ ...tpl, outputSizeMode: 'source' }, 2560, 1440, { width: 1920, height: 1080 }))
      .toEqual({ width: 1920, height: 1080, scale: 1.5, mode: 'override' })
  })

  it('脏数据不产出 0 宽高', () => {
    expect(postCanvasSize({ width: 0, height: 0 }, 0, 0)).toMatchObject({ width: 1, height: 1 })
  })
})
