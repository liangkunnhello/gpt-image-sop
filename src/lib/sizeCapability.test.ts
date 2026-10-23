import { describe, expect, it } from 'vitest'

import { isSizeSupported, planGenerationSize, upscaleSizeForSize } from './sizeCapability'

/**
 * 渠道只接受短边 ≥ 1024、长边 ≤ 4096 的尺寸（720×1280 之类会被 400 拒掉）。
 * 现在这类尺寸不再灰掉，而是先按同比例更大的尺寸出图、拿到图再缩回目标尺寸。
 * 但套后处理模板时不能这么做：模板的字号是按成品像素写死的，先缩会错位。
 */
describe('upscaleSizeForSize（找同比例更大的可用尺寸）', () => {
  it('9:16 的 720×1280 提到 2K 的 1440×2560', () => {
    expect(upscaleSizeForSize('720x1280')).toBe('1440x2560')
  })

  it('16:9 的 1280×720 提到 2560×1440', () => {
    expect(upscaleSizeForSize('1280x720')).toBe('2560x1440')
  })

  it('短边不够的非标准尺寸也能找到同比例大图', () => {
    expect(upscaleSizeForSize('1000x1000')).toBe('1024x1024')
  })

  it('比例太极端（超过 3:1）时找不到可用尺寸', () => {
    expect(upscaleSizeForSize('4000x500')).toBeNull()
  })

  it('目标本身就超过长边上限时放弃：只能靠缩小，会糊，不做', () => {
    expect(upscaleSizeForSize('5000x5000')).toBeNull()
  })

  it('尺寸写错时返回 null', () => {
    expect(upscaleSizeForSize('auto')).toBeNull()
    expect(upscaleSizeForSize('')).toBeNull()
  })
})

describe('planGenerationSize（出图尺寸计划）', () => {
  it('渠道本来就支持的尺寸原样发出去', () => {
    expect(planGenerationSize('1024x1024')).toEqual({
      requestSize: '1024x1024',
      targetSize: '1024x1024',
      scaled: false,
    })
  })

  it('不支持的尺寸改发大图，成品仍缩回用户设的尺寸', () => {
    expect(planGenerationSize('720x1280')).toEqual({
      requestSize: '1440x2560',
      targetSize: '720x1280',
      scaled: true,
    })
  })

  it('有后处理模板时不做放大：模板字号按成品像素写死，先缩会错位', () => {
    expect(planGenerationSize('720x1280', { postProcess: true })).toEqual({
      requestSize: '720x1280',
      targetSize: '720x1280',
      scaled: false,
    })
  })

  it('auto 不参与，交给模型自己决定', () => {
    expect(planGenerationSize('auto').scaled).toBe(false)
    expect(planGenerationSize(undefined).scaled).toBe(false)
    expect(planGenerationSize('auto').requestSize).toBe('auto')
  })

  it('放大后仍然超限的尺寸保持原样（界面据此提示不支持）', () => {
    expect(planGenerationSize('5000x5000').scaled).toBe(false)
  })

  it('计划里的生成尺寸一定是渠道支持的，目标尺寸一定是用户设的', () => {
    const plan = planGenerationSize('720x1280')
    expect(isSizeSupported(plan.requestSize)).toBe(true)
    expect(plan.targetSize).toBe('720x1280')
  })
})
