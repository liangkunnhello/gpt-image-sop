import { describe, expect, it } from 'vitest'

import { sizeForReferenceImage, sizeOverridesForMixedRatios, maxSizeForReferenceImage } from './referenceSize'

function toDataUrl(bytes: Uint8Array, mime = 'image/png') {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:${mime};base64,${btoa(bin)}`
}

/** 只造 PNG 文件头，imageSizeFromDataUrl 不需要真实像素数据 */
function pngDataUrl(width: number, height: number) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return toDataUrl(bytes)
}

describe('maxSizeForReferenceImage（SOP 上传图后自动定画幅）', () => {
  it('常用比例取该比例能出的最大尺寸（4K 档）', () => {
    expect(maxSizeForReferenceImage(pngDataUrl(1920, 1080))).toBe('3840x2160')
    expect(maxSizeForReferenceImage(pngDataUrl(1080, 1920))).toBe('2160x3840')
    expect(maxSizeForReferenceImage(pngDataUrl(1024, 1024))).toBe('2880x2880')
  })

  it('比 2K 基准更大 —— 这才是「最大尺寸」和「基准尺寸」的区别', () => {
    expect(sizeForReferenceImage(pngDataUrl(1536, 2048))).toBe('1536x2048')
    expect(maxSizeForReferenceImage(pngDataUrl(1536, 2048))).toBe('2400x3200')
  })

  it('读不出尺寸的图不写死尺寸，交给调用方保持原设置', () => {
    expect(maxSizeForReferenceImage('')).toBeNull()
    expect(maxSizeForReferenceImage('data:image/png;base64,AAAA')).toBeNull()
    expect(maxSizeForReferenceImage('not-a-data-url')).toBeNull()
  })

  it('非常用比例也算得出，且落在渠道允许范围内', () => {
    const size = maxSizeForReferenceImage(pngDataUrl(1000, 800))
    expect(size).toMatch(/^\d+x\d+$/)
    const [width, height] = size!.split('x').map(Number)
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(1024)
    expect(Math.max(width, height)).toBeLessThanOrEqual(4096)
    // 比例要和原图接近（5:4）
    expect(Math.abs(width / height - 1.25)).toBeLessThan(0.05)
  })
})

describe('sizeForReferenceImage', () => {
  it('横图取同比例的 2K 基准尺寸', () => {
    expect(sizeForReferenceImage(pngDataUrl(1920, 1080))).toBe('2560x1440')
    expect(sizeForReferenceImage(pngDataUrl(1280, 720))).toBe('2560x1440')
    expect(sizeForReferenceImage(pngDataUrl(1600, 1200))).toBe('2048x1536')
  })

  it('竖图取同比例的 2K 基准尺寸', () => {
    expect(sizeForReferenceImage(pngDataUrl(1080, 1920))).toBe('1440x2560')
    expect(sizeForReferenceImage(pngDataUrl(1536, 2048))).toBe('1536x2048')
  })

  it('方图取 2K 方形', () => {
    expect(sizeForReferenceImage(pngDataUrl(1024, 1024))).toBe('2048x2048')
  })

  it('非常用比例也按同比例算出尺寸，且落在渠道允许范围内', () => {
    // 1000×800 = 5:4，命中不了常用比例预设，走像素预算计算
    expect(sizeForReferenceImage(pngDataUrl(1000, 800))).toBe('2288x1824')
  })

  it('读不出尺寸时返回 null，保持 auto', () => {
    expect(sizeForReferenceImage('')).toBeNull()
    expect(sizeForReferenceImage('https://example.com/a.png')).toBeNull()
    expect(sizeForReferenceImage('data:image/png;base64,AAAA')).toBeNull()
  })

  it('可以换档位', () => {
    expect(sizeForReferenceImage(pngDataUrl(1920, 1080), '4K')).toBe('3840x2160')
  })
})

describe('sizeOverridesForMixedRatios', () => {
  it('横竖混排时每个请求按自己那张图的比例取 2K 尺寸', () => {
    const overrides = sizeOverridesForMixedRatios([
      pngDataUrl(1920, 1080), // 16:9 横
      pngDataUrl(1080, 1920), // 9:16 竖
      pngDataUrl(1024, 1024), // 1:1
    ])
    expect(overrides).toEqual(['2560x1440', '1440x2560', '2048x2048'])
  })

  it('比例都一样时返回 null，保持 auto', () => {
    // 1280×720 与 1920×1080 都是 16:9，换算结果相同，不算混排
    expect(sizeOverridesForMixedRatios([pngDataUrl(1920, 1080), pngDataUrl(1280, 720)])).toBeNull()
    expect(sizeOverridesForMixedRatios([pngDataUrl(1080, 1920), pngDataUrl(720, 1280)])).toBeNull()
  })

  it('只有一张图时返回 null', () => {
    expect(sizeOverridesForMixedRatios([pngDataUrl(1920, 1080)])).toBeNull()
  })

  it('有任一张读不出比例就整体不覆盖，避免一半钉死尺寸一半走 auto', () => {
    expect(sizeOverridesForMixedRatios([pngDataUrl(1920, 1080), 'https://example.com/a.png'])).toBeNull()
  })

  it('空列表返回 null', () => {
    expect(sizeOverridesForMixedRatios([])).toBeNull()
  })
})
