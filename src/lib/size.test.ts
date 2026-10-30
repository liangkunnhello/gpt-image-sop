import { describe, expect, it } from 'vitest'
import { calculateImageSize, nearestPresetRatio, normalizeCodexCliImageSize, prependCodexCliSizePrompt, stripInjectedCodexCliSizePrompt, withAspectRatioHint } from './size'

describe('calculateImageSize', () => {
  it('uses common 16:9 display resolutions for the built-in tiers', () => {
    expect(calculateImageSize('1K', '16:9')).toBe('1280x720')
    expect(calculateImageSize('2K', '16:9')).toBe('2560x1440')
    expect(calculateImageSize('4K', '16:9')).toBe('3840x2160')
  })

  it('uses matching portrait presets for common ratios', () => {
    expect(calculateImageSize('2K', '9:16')).toBe('1440x2560')
    expect(calculateImageSize('2K', '2:3')).toBe('1440x2160')
    expect(calculateImageSize('2K', '3:4')).toBe('1536x2048')
  })

  it('falls back to budget-based sizing for custom ratios', () => {
    expect(calculateImageSize('2K', '5:4')).toBe('2288x1824')
  })
})

describe('Codex CLI size compatibility', () => {
  it('normalizes custom sizes to the 1K pixel budget', () => {
    expect(normalizeCodexCliImageSize('2048x2048')).toBe('1024x1024')
    expect(normalizeCodexCliImageSize('2048x1536')).toBe('1024x768')
    expect(normalizeCodexCliImageSize('1536x1024')).toBe('1536x1024')
  })

  it('preserves non-preset ratios approximately and clamps excessive ratios', () => {
    expect(normalizeCodexCliImageSize('2500x2000')).toBe(calculateImageSize('1K', '5:4'))
    const [width, height] = normalizeCodexCliImageSize('4000x1000').split('x').map(Number)
    expect(width / height).toBeCloseTo(3, 2)
    expect(width * height).toBeLessThanOrEqual(1_572_864)
  })

  it('prepends a concise resolution hint only for explicit sizes', () => {
    expect(prependCodexCliSizePrompt('Draw a cat.\n', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.\n')
    expect(prependCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(prependCodexCliSizePrompt('Draw a cat.', 'auto')).toBe('Draw a cat.')
  })

  it('strips only the matching injected resolution hint', () => {
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 2048x2048 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Generate at 2048x2048 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', 'auto')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
  })
})

describe('withAspectRatioHint', () => {
  it('appends the ratio of the requested size', () => {
    expect(withAspectRatioHint('Draw a cat.', '2048x1152')).toBe('Draw a cat.\n\n画面比例严格为 16:9（2048×1152，横版构图），不要改成其他比例。')
    expect(withAspectRatioHint('Draw a cat.', '1024x1536')).toContain('2:3')
    expect(withAspectRatioHint('Draw a cat.', '1024x1536')).toContain('竖版构图')
  })

  it('is a no-op for auto or unparsable sizes', () => {
    expect(withAspectRatioHint('Draw a cat.', 'auto')).toBe('Draw a cat.')
    expect(withAspectRatioHint('Draw a cat.', '')).toBe('Draw a cat.')
    expect(withAspectRatioHint('Draw a cat.', undefined)).toBe('Draw a cat.')
    expect(withAspectRatioHint('Draw a cat.', '1K')).toBe('Draw a cat.')
  })

  it('does not append twice', () => {
    const once = withAspectRatioHint('Draw a cat.', '1024x1024')
    expect(withAspectRatioHint(once, '1024x1024')).toBe(once)
  })

  it('falls back to the first reference image when size is auto', () => {
    const bytes = new Uint8Array(33)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    bytes.set([0, 0, 0, 13], 8)
    bytes.set([0x49, 0x48, 0x44, 0x52], 12)
    new DataView(bytes.buffer).setUint32(16, 2160)
    new DataView(bytes.buffer).setUint32(20, 3840)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    const ref = `data:image/png;base64,${btoa(bin)}`

    const hinted = withAspectRatioHint('Draw a cat.', 'auto', [ref])
    expect(hinted).toContain('9:16')
    expect(hinted).toContain('竖版构图')
    expect(hinted).toContain('与参考图保持一致')

    // 没有参考图时保持原样
    expect(withAspectRatioHint('Draw a cat.', 'auto', [])).toBe('Draw a cat.')
  })
})

/**
 * 截图这类非标准比例会被换算成任意 16 倍数尺寸（3552×2304），
 * 中转站直接拒「不允许的图片尺寸」。所以自动尺寸必须先吸附到常用比例。
 */
describe('nearestPresetRatio（比例吸附）', () => {
  it('常用比例原样返回', () => {
    expect(nearestPresetRatio('16:9')).toBe('16:9')
    expect(nearestPresetRatio('1024:1536')).toBe('2:3')
  })

  it('截图常见的 1.54 / 1.6 吸附到 3:2', () => {
    expect(nearestPresetRatio('3024:1964')).toBe('3:2')
    expect(nearestPresetRatio('16:10')).toBe('3:2')
  })

  it('长截图这类极端比例吸附不上，返回 null（保持 auto，不写错尺寸）', () => {
    expect(nearestPresetRatio('1080:4000')).toBeNull()
    expect(nearestPresetRatio('1:5')).toBeNull()
  })

  it('比例写法非法时返回 null', () => {
    expect(nearestPresetRatio('')).toBeNull()
    expect(nearestPresetRatio('abc')).toBeNull()
  })
})
