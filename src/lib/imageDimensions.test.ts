import { describe, expect, it } from 'vitest'

import { imageSizeFromDataUrl } from './imageDimensions'

function toDataUrl(bytes: Uint8Array, mime = 'image/png') {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:${mime};base64,${btoa(bin)}`
}

function pngDataUrl(width: number, height: number) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return toDataUrl(bytes)
}

function gifDataUrl(width: number, height: number) {
  const bytes = new Uint8Array(13)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0)
  bytes[6] = width & 0xff
  bytes[7] = (width >> 8) & 0xff
  bytes[8] = height & 0xff
  bytes[9] = (height >> 8) & 0xff
  return toDataUrl(bytes, 'image/gif')
}

describe('imageSizeFromDataUrl', () => {
  it('reads PNG dimensions', () => {
    expect(imageSizeFromDataUrl(pngDataUrl(2160, 3840))).toEqual({ width: 2160, height: 3840 })
  })

  it('reads GIF dimensions', () => {
    expect(imageSizeFromDataUrl(gifDataUrl(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('returns null for unknown or invalid input', () => {
    expect(imageSizeFromDataUrl('')).toBeNull()
    expect(imageSizeFromDataUrl('https://example.com/a.png')).toBeNull()
    expect(imageSizeFromDataUrl('data:image/png;base64,AAAA')).toBeNull()
  })
})
