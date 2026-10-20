/**
 * 从 data URL 里直接读图片宽高。
 *
 * 只解析文件头，不解码像素，所以又快又能在任意环境（浏览器 / 客户端 / Node）跑。
 * 支持 PNG / JPEG / WebP / GIF，其余格式返回 null。
 */
export interface ImageDimensions {
  width: number
  height: number
}

const HEAD_BYTES = 65536

function toBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const meta = dataUrl.slice(0, comma)
  // 只取前 64KB 就够读到文件头，避免整张 4K 图做 base64 解码
  const slice = 4 * Math.floor(HEAD_BYTES / 4)
  const body = dataUrl.slice(comma + 1, comma + 1 + slice)
  try {
    if (/;base64/i.test(meta)) {
      const bin = atob(body)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
      return out
    }
    const text = decodeURIComponent(body)
    const out = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function ascii(b: Uint8Array, at: number, len: number) {
  let s = ''
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(b[at + i] ?? 0)
  return s
}

const u16be = (b: Uint8Array, at: number) => ((b[at] << 8) | b[at + 1]) >>> 0
const u16le = (b: Uint8Array, at: number) => ((b[at + 1] << 8) | b[at]) >>> 0
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u24le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) >>> 0

function pngSize(b: Uint8Array): ImageDimensions | null {
  if (b.length < 24) return null
  if (b[0] !== 0x89 || ascii(b, 1, 3) !== 'PNG') return null
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

function gifSize(b: Uint8Array): ImageDimensions | null {
  if (b.length < 10 || ascii(b, 0, 3) !== 'GIF') return null
  return { width: u16le(b, 6), height: u16le(b, 8) }
}

function webpSize(b: Uint8Array): ImageDimensions | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8X') {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  }
  if (chunk === 'VP8 ') {
    // 关键帧头：3 字节帧标签 + 起始码 9d 01 2a + 宽高各 2 字节（低 14 位）
    const w = u16le(b, 26) & 0x3fff
    const h = u16le(b, 28) & 0x3fff
    return w && h ? { width: w, height: h } : null
  }
  if (chunk === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

function jpegSize(b: Uint8Array): ImageDimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue }
    const marker = b[i + 1]
    if (marker === 0xff) { i += 1; continue }
    // 无长度的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = u16be(b, i + 2)
    if (len < 2) return null
    // SOF0..SOF15（排除 DHT/JPG/DAC）
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    i += 2 + len
  }
  return null
}

export function imageSizeFromDataUrl(dataUrl: string): ImageDimensions | null {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null
  const b = toBytes(dataUrl)
  if (!b || b.length < 10) return null
  const size = pngSize(b) || jpegSize(b) || webpSize(b) || gifSize(b)
  if (!size || !(size.width > 0) || !(size.height > 0)) return null
  return size
}
