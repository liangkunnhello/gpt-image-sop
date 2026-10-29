import { describe, expect, it } from 'vitest'
import {
  ARK_AUTO_SIZE,
  arkSizeHint,
  ARK_MAX_PIXELS,
  ARK_MIN_PIXELS,
  arkSizeWasAdjusted,
  isArkSizeValid,
  parseArkSize,
  toArkSize,
} from './arkSize'

describe('解析尺寸', () => {
  it('标准写法', () => {
    expect(parseArkSize('2048x1536')).toEqual({ width: 2048, height: 1536 })
  })

  it('大写 X 与空格也认', () => {
    expect(parseArkSize('2048 X 1536')).toEqual({ width: 2048, height: 1536 })
    expect(parseArkSize('2048×1536')).toEqual({ width: 2048, height: 1536 })
  })

  it('auto / 非法值给 null', () => {
    expect(parseArkSize('auto')).toBeNull()
    expect(parseArkSize('')).toBeNull()
    expect(parseArkSize('1024')).toBeNull()
    expect(parseArkSize('0x0')).toBeNull()
  })
})

describe('合法性判定（4.5 的硬性要求）', () => {
  it('2048×2048 合法（419 万像素）', () => {
    expect(isArkSizeValid(2048, 2048)).toBe(true)
  })

  it('1024×1024 不合法：只有 104 万像素，远低于 368 万下限', () => {
    expect(isArkSizeValid(1024, 1024)).toBe(false)
  })

  it('2K 档的 3:4（1536×2048）不合法：314 万像素，这就是本项目最容易踩的坑', () => {
    expect(isArkSizeValid(1536, 2048)).toBe(false)
  })

  it('2K 档的 4:3（2048×1536）同样不合法', () => {
    expect(isArkSizeValid(2048, 1536)).toBe(false)
  })

  it('超出上限不合法（>4096×4096）', () => {
    expect(isArkSizeValid(5000, 5000)).toBe(false)
  })

  it('比例超过 16:1 不合法', () => {
    expect(isArkSizeValid(16384, 512)).toBe(false)
  })
})

describe('换算到合法尺寸', () => {
  it('auto 用 2K 档位（让模型按提示词定比例）', () => {
    expect(toArkSize('auto')).toBe(ARK_AUTO_SIZE)
  })

  it('本来就合法的原样返回', () => {
    expect(toArkSize('2560x1440')).toBe('2560x1440')
    expect(toArkSize('2048x2048')).toBe('2048x2048')
  })

  it('低于下限的按原比例放大（1536×2048 → 比例不变）', () => {
    const result = toArkSize('1536x2048')
    const parsed = parseArkSize(result)!
    expect(isArkSizeValid(parsed.width, parsed.height)).toBe(true)
    // 3:4 的比例必须保住，否则套后处理模板会错位
    expect(parsed.width / parsed.height).toBeCloseTo(1536 / 2048, 2)
    expect(parsed.width * parsed.height).toBeGreaterThanOrEqual(ARK_MIN_PIXELS)
  })

  it('2048×1536（4:3）也能放大到达标且保住比例', () => {
    const parsed = parseArkSize(toArkSize('2048x1536'))!
    expect(isArkSizeValid(parsed.width, parsed.height)).toBe(true)
    expect(parsed.width / parsed.height).toBeCloseTo(4 / 3, 2)
  })

  it('1024×1024 会放大到 2048 级别', () => {
    const parsed = parseArkSize(toArkSize('1024x1024'))!
    expect(isArkSizeValid(parsed.width, parsed.height)).toBe(true)
    expect(parsed.width).toBe(parsed.height)
    expect(parsed.width).toBeGreaterThanOrEqual(1920)
  })

  it('超过上限的会缩小', () => {
    const parsed = parseArkSize(toArkSize('9000x9000'))!
    expect(isArkSizeValid(parsed.width, parsed.height)).toBe(true)
    expect(parsed.width * parsed.height).toBeLessThanOrEqual(ARK_MAX_PIXELS)
  })

  it('极端长条先收进 16:1 再换算', () => {
    const parsed = parseArkSize(toArkSize('8000x200'))!
    expect(isArkSizeValid(parsed.width, parsed.height)).toBe(true)
    expect(parsed.width / parsed.height).toBeLessThanOrEqual(16.1)
  })

  it('结果是偶数宽高（编码器对奇数更挑剔）', () => {
    for (const size of ['1536x2048', '2048x1536', '1000x1000', '1365x1365']) {
      const parsed = parseArkSize(toArkSize(size))!
      expect(parsed.width % 2).toBe(0)
      expect(parsed.height % 2).toBe(0)
    }
  })

  it('1K 档的横向尺寸（1280×720）会被放大到达标', () => {
    const parsed = parseArkSize(toArkSize('1280x720'))!
    expect(isArkSizeValid(parsed.width, parsed.height)).toBe(true)
    expect(parsed.width / parsed.height).toBeCloseTo(16 / 9, 2)
  })
})

describe('是否被调整过（给界面提示）', () => {
  it('合法尺寸不算调整', () => {
    expect(arkSizeWasAdjusted('2560x1440')).toBe(false)
  })

  it('放大过的要能识别出来（用户得知道实际出图尺寸变了）', () => {
    expect(arkSizeWasAdjusted('1536x2048')).toBe(true)
  })

  it('auto 不算调整（本来就没指定像素）', () => {
    expect(arkSizeWasAdjusted('auto')).toBe(false)
  })
})


describe('输入区的尺寸提示', () => {
  it('尺寸被放大时明确说明实际尺寸，并强调比例不变', () => {
    const hint = arkSizeHint('1536x2048')
    expect(hint).toContain('1728')
    expect(hint).toContain('比例不变')
  })

  it('合法尺寸不打扰用户', () => {
    expect(arkSizeHint('2560x1440')).toBe('')
  })

  it('auto 时说明按 2K 档位、比例由模型决定', () => {
    expect(arkSizeHint('auto')).toContain('2K')
  })
})
