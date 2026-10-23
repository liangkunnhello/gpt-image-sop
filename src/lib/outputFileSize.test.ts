import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_PARAMS } from '../types'
import {
  SIZE_LIMIT_MAX_QUALITY,
  SIZE_LIMIT_MIN_QUALITY,
  dataUrlByteSize,
  findQualityWithinBytes,
  limitDataUrlSize,
  parseSizeLimitKb,
  shouldLimitOutputSize,
} from './outputFileSize'

/** 假的编码器：体积随画质线性变化，方便算准二分结果 */
function fakeEncoder(bytesAt: (quality: number) => number) {
  return vi.fn(async (quality: number) => ({ value: `q${quality}`, bytes: bytesAt(quality) }))
}

describe('dataUrlByteSize', () => {
  it('按 base64 长度算实际字节数', () => {
    // 3 字节原文 → 4 个字符，无补齐
    expect(dataUrlByteSize('data:image/jpeg;base64,AAAA')).toBe(3)
    // 2 字节 → 末尾 1 个 =，解码后 2 字节
    expect(dataUrlByteSize('data:image/png;base64,AA==')).toBe(1)
    expect(dataUrlByteSize('data:image/png;base64,AAA=')).toBe(2)
  })

  it('不是 base64 的数据按字符串长度算', () => {
    expect(dataUrlByteSize('data:text/plain,abcdef')).toBe(6)
    expect(dataUrlByteSize('没有逗号的字符串')).toBe(0)
  })
})

describe('shouldLimitOutputSize', () => {
  const base = { ...DEFAULT_PARAMS, output_format: 'jpeg' as const, max_file_kb: 500 }

  it('JPEG / WebP 且填了数值才生效', () => {
    expect(shouldLimitOutputSize(base)).toBe(true)
    expect(shouldLimitOutputSize({ ...base, output_format: 'webp' })).toBe(true)
  })

  it('没填、填 0、负数都不限制', () => {
    expect(shouldLimitOutputSize({ ...base, max_file_kb: null })).toBe(false)
    expect(shouldLimitOutputSize({ ...base, max_file_kb: 0 })).toBe(false)
    expect(shouldLimitOutputSize({ ...base, max_file_kb: -1 })).toBe(false)
  })

  it('PNG 无损，不参与限制', () => {
    expect(shouldLimitOutputSize({ ...base, output_format: 'png' })).toBe(false)
  })

  it('透明背景的 WebP 也参与限制：重编码保留 alpha，压完再存', () => {
    expect(shouldLimitOutputSize({ ...base, output_format: 'webp' })).toBe(true)
  })
})

describe('findQualityWithinBytes', () => {
  it('本来就没超，直接返回 null、不做任何编码', async () => {
    const encode = fakeEncoder((quality) => quality * 1000)
    await expect(findQualityWithinBytes({ currentBytes: 100, maxBytes: 500, encode })).resolves.toBeNull()
    expect(encode).not.toHaveBeenCalled()
  })

  it('最高画质就够小，直接用它，不进入二分', async () => {
    const encode = fakeEncoder((quality) => quality * 1000)
    const result = await findQualityWithinBytes({ currentBytes: 5000, maxBytes: 4000, encode })
    expect(result).toMatchObject({ quality: SIZE_LIMIT_MAX_QUALITY, fits: true })
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it('二分出能落进限制的最高画质', async () => {
    const encode = fakeEncoder((quality) => quality * 1000)
    const result = await findQualityWithinBytes({ currentBytes: 5000, maxBytes: 500, encode })
    expect(result).not.toBeNull()
    expect(result!.fits).toBe(true)
    expect(result!.bytes).toBeLessThanOrEqual(500)
    // 应该紧贴上限（0.5 附近），而不是一路压到最低
    expect(result!.quality).toBeGreaterThan(0.45)
    expect(result!.quality).toBeLessThan(0.5)
  })

  it('最低画质也压不下去时，返回最小体积并标记未达标', async () => {
    const encode = fakeEncoder(() => 900)
    const result = await findQualityWithinBytes({ currentBytes: 5000, maxBytes: 100, encode })
    expect(result).not.toBeNull()
    expect(result!.fits).toBe(false)
    expect(result!.quality).toBe(SIZE_LIMIT_MIN_QUALITY)
    expect(result!.bytes).toBe(900)
  })
})

describe('limitDataUrlSize', () => {
  it('本来就没超上限时原样返回，不做重编码', async () => {
    // 4 个 base64 字符只有 3 字节，远小于 100KB；jsdom 里没有 canvas，真去重编码会抛错
    const source = 'data:image/jpeg;base64,AAAA'
    await expect(limitDataUrlSize(source, 'jpeg', 100 * 1024)).resolves.toEqual({ dataUrl: source, fits: true })
  })
})

describe('parseSizeLimitKb', () => {
  it('空、0、非数字都算不限', () => {
    expect(parseSizeLimitKb('')).toBeNull()
    expect(parseSizeLimitKb('   ')).toBeNull()
    expect(parseSizeLimitKb('0')).toBeNull()
    expect(parseSizeLimitKb('abc')).toBeNull()
  })

  it('正常数值取整，小数四舍五入', () => {
    expect(parseSizeLimitKb('500')).toBe(500)
    expect(parseSizeLimitKb(' 800 ')).toBe(800)
    expect(parseSizeLimitKb('500.6')).toBe(501)
    expect(parseSizeLimitKb('1')).toBe(1)
  })
})
