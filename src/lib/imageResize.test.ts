import { describe, expect, it } from 'vitest'

import { planDownscale } from './imageResize'

/**
 * 「放大生成 → 缩回目标」这一步的判定。
 * 拿到的图可能和要求的比例差一点点，硬拉会变形，这种情况宁可原样保留。
 */
describe('planDownscale（成品要不要缩、缩到多少）', () => {
  it('尺寸一致时不缩', () => {
    expect(planDownscale({ width: 1440, height: 2560 }, { width: 1440, height: 2560 })).toBeNull()
  })

  it('同比例的大图缩到目标尺寸', () => {
    expect(planDownscale({ width: 1440, height: 2560 }, { width: 720, height: 1280 })).toEqual({ width: 720, height: 1280 })
  })

  it('比例在容差内（1% 偏差）就缩，保证一定能得到用户设的尺寸', () => {
    expect(planDownscale({ width: 1450, height: 2560 }, { width: 720, height: 1280 })).toEqual({ width: 720, height: 1280 })
  })

  it('接口没按要求出图、比例差太多时不缩，避免拉变形', () => {
    expect(planDownscale({ width: 1024, height: 1024 }, { width: 720, height: 1280 })).toBeNull()
  })

  it('尺寸脏数据时不动', () => {
    expect(planDownscale({ width: 0, height: 0 }, { width: 720, height: 1280 })).toBeNull()
    expect(planDownscale({ width: 1440, height: 2560 }, { width: 0, height: 0 })).toBeNull()
  })

  it('目标尺寸带小数时取整，避免画布报错', () => {
    expect(planDownscale({ width: 1441, height: 2560 }, { width: 719.6, height: 1279.6 })).toEqual({ width: 720, height: 1280 })
  })
})
