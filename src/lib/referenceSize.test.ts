import { describe, expect, it } from 'vitest'

import { sizeForReferenceImage, sizeOverridesForMixedRatios } from './referenceSize'

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
