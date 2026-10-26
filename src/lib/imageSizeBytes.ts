/**
 * 从图片字节里读真实像素宽高。
 *
 * 为什么不用 `task.params.size`：那是**请求生图时的尺寸**。后处理模板会把成品
 * 重画成模板尺寸（applyPostTemplate 里 canvas.width = template.width），
 * 成品和请求尺寸常常不是一个数。交付命名要的是「这个文件到底是多大」，
 * 只有读文件本身才不会错。
 *
 * 覆盖交付会遇到的全部格式：png / jpeg / webp / gif。
 * 认不出来时返回 null，由调用方退回请求尺寸。
 */

export interface PixelSize {
  width: number
  height: number
}

function be16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function be32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function le16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function le24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i] ?? 0)
  return text
}

function pngSize(bytes: Uint8Array): PixelSize | null {
  // 8 字节签名 + 4 字节长度 + "IHDR" 之后就是宽高，各 4 字节大端
  if (bytes.length < 24) return null
  const width = be32(bytes, 16)
  const height = be32(bytes, 20)
  return width > 0 && height > 0 ? { width, height } : null
}

function jpegSize(bytes: Uint8Array): PixelSize | null {
  // 逐段扫描到 SOFn，段结构：FF marker len(2) payload
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // 独立标记，没有长度字段
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = be16(bytes, offset + 2)
    if (length < 2) return null
    // SOF0~SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = be16(bytes, offset + 5)
      const width = be16(bytes, offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    if (marker === 0xda) return null // 进到扫描数据还没遇到 SOF，说明文件不完整
    offset += 2 + length
  }
  return null
}

function webpSize(bytes: Uint8Array): PixelSize | null {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    // 24 位小端存的是「宽-1」「高-1」
    return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 }
  }
  if (chunk === 'VP8 ') {
    // 有损：帧头里 16 位，低 14 位是宽高
    return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    // 无损：14 位宽 + 14 位高，紧跟在签名 0x2f 之后
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function gifSize(bytes: Uint8Array): PixelSize | null {
  const width = le16(bytes, 6)
  const height = le16(bytes, 8)
  return width > 0 && height > 0 ? { width, height } : null
}

/** 读图片字节的真实像素宽高；格式不支持或文件不完整时返回 null */
export function imageSizeFromBytes(bytes: Uint8Array): PixelSize | null {
  if (!bytes || bytes.length < 16) return null
  const sig = ascii(bytes, 0, 4)
  if (sig === '\x89PNG') return pngSize(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes)
  if (sig === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webpSize(bytes)
  if (sig === 'GIF8') return gifSize(bytes)
  return null
}

/** 拼成命名模板与 sizeLabel 都认的 `1024x1024` */
export function pixelSizeLabel(size: PixelSize | null): string {
  return size ? `${size.width}x${size.height}` : ''
}
