import { describe, expect, it } from 'vitest'

import { imageSizeFromBytes, pixelSizeLabel } from './imageSizeBytes'

/** 造一个只有文件头的 PNG：签名 + IHDR 里就是宽高 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** SOI + APP0(16 字节段) + SOF0，SOF0 里带真实宽高 */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40)
  bytes.set([0xff, 0xd8], 0)
  bytes.set([0xff, 0xe0, 0x00, 0x10], 2)
  // 6..19 是 APP0 载荷，内容无关紧要
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20)
  bytes[25] = (height >> 8) & 0xff
  bytes[26] = height & 0xff
  bytes[27] = (width >> 8) & 0xff
  bytes[28] = width & 0xff
  return bytes
}

/** VP8X 扩展格式：24 位小端存「宽-1」「高-1」 */
function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  const w = width - 1
  const h = height - 1
  bytes[24] = w & 0xff
  bytes[25] = (w >> 8) & 0xff
  bytes[26] = (w >> 16) & 0xff
  bytes[27] = h & 0xff
  bytes[28] = (h >> 8) & 0xff
  bytes[29] = (h >> 16) & 0xff
  return bytes
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // GIF89a
  bytes[6] = width & 0xff
  bytes[7] = (width >> 8) & 0xff
  bytes[8] = height & 0xff
  bytes[9] = (height >> 8) & 0xff
  return bytes
}

const CASES: Array<[string, (width: number, height: number) => Uint8Array, number, number]> = [
  ['png', pngBytes, 1080, 1920],
  ['jpeg', jpegBytes, 1024, 1024],
  ['webp', webpBytes, 1280, 720],
  ['gif', gifBytes, 640, 480],
]

describe('imageSizeFromBytes', () => {
  it.each(CASES)('读得出 %s 的真实宽高', (_label, build, width, height) => {
    expect(imageSizeFromBytes(build(width, height))).toEqual({ width, height })
  })

  it('认不出来的格式返回 null，由调用方退回请求尺寸', () => {
    expect(imageSizeFromBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))).toBeNull()
    expect(imageSizeFromBytes(new Uint8Array(0))).toBeNull()
  })

  it('PNG 文件头被截断时不瞎猜', () => {
    expect(imageSizeFromBytes(pngBytes(100, 100).slice(0, 12))).toBeNull()
  })

  it('拼成命名用的 宽x高', () => {
    expect(pixelSizeLabel({ width: 1080, height: 1920 })).toBe('1080x1920')
    expect(pixelSizeLabel(null)).toBe('')
  })
})
