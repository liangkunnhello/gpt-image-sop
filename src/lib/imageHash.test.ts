import { describe, expect, it } from 'vitest'

import { HASH_SAMPLE, hashFromPixels, hashScores, hammingDistance, similarityFromHashes } from './imageHash'

/**
 * 多频率叠加的「类照片」图案。
 * 不用纯线性渐变：那种图理论上大部分 DCT 系数是 0，浮点残差会让 bit 随机翻转，
 * 测出来的是图案的退化，不是算法的稳定性。
 */
function pixelsWith(scale = 1, noise = 0): number[] {
  const pixels: number[] = []
  for (let y = 0; y < HASH_SAMPLE; y += 1) {
    for (let x = 0; x < HASH_SAMPLE; x += 1) {
      const base = 90
        + 40 * Math.sin(x * 0.35)
        + 25 * Math.cos(y * 0.22)
        + 18 * Math.sin((x + y) * 0.15)
      const wobble = noise ? ((x * 7 + y * 13) % 11) - 5 : 0
      pixels.push(Math.min(255, Math.max(0, base * scale + wobble * noise)))
    }
  }
  return pixels
}

function gradient(scale = 1): string {
  return hashFromPixels(pixelsWith(scale))
}

/** 同一张图加确定性噪声，模拟压缩 / 微调 */
function gradientWithNoise(): string {
  return hashFromPixels(pixelsWith(1, 1.2))
}

/** 棋盘格 */
function checker(): string {
  const pixels: number[] = []
  for (let y = 0; y < HASH_SAMPLE; y += 1) {
    for (let x = 0; x < HASH_SAMPLE; x += 1) {
      pixels.push((x + y) % 2 === 0 ? 220 : 30)
    }
  }
  return hashFromPixels(pixels)
}

/** 竖条纹 */
function stripes(): string {
  const pixels: number[] = []
  for (let y = 0; y < HASH_SAMPLE; y += 1) {
    for (let x = 0; x < HASH_SAMPLE; x += 1) {
      pixels.push(x % 2 === 0 ? 220 : 30)
    }
  }
  return hashFromPixels(pixels)
}

describe('感知哈希', () => {
  it('哈希是 64 位（16 个 hex 字符）', () => {
    expect(gradient()).toHaveLength(16)
  })

  it('同一张图完全一致，相似度为 1', () => {
    const a = gradient()
    const b = gradient()
    expect(a).toBe(b)
    expect(hammingDistance(a, b)).toBe(0)
    expect(similarityFromHashes(a, b)).toBe(1)
  })

  it('轻微噪声后仍然高度相似', () => {
    expect(similarityFromHashes(gradient(), gradientWithNoise())).toBeGreaterThan(0.9)
  })

  it('整体调亮调暗不影响判定（先减均值再取中位数）', () => {
    expect(similarityFromHashes(gradient(1), gradient(0.7))).toBe(1)
    expect(similarityFromHashes(gradient(1), gradient(1.3))).toBeGreaterThan(0.9)
  })

  it('结构不同的图相似度明显低', () => {
    expect(similarityFromHashes(gradient(), checker())).toBeLessThan(0.9)
    expect(similarityFromHashes(checker(), stripes())).toBeLessThan(1)
  })

  it('像素数量不对时直接报错，避免算出无意义的哈希', () => {
    expect(() => hashFromPixels([1, 2, 3])).toThrow()
  })
})

describe('成对打分', () => {
  it('相同的两张互为最近邻，最高相似度为 1', () => {
    const scores = hashScores([
      { key: 'a', hash: gradient() },
      { key: 'b', hash: gradient() },
      { key: 'c', hash: checker() },
    ])
    expect(scores.a.max).toBe(1)
    expect(scores.a.nearest).toBe('b')
    expect(scores.b.nearest).toBe('a')
    // 与另一张完全不同的图比，相似度会被平均拉低
    expect(scores.a.mean).toBeLessThan(1)
    expect(scores.c.max).toBeLessThan(1)
  })

  it('少于两张时不给分，避免单张被判成 100% 重复', () => {
    expect(hashScores([{ key: 'a', hash: gradient() }])).toEqual({})
    expect(hashScores([])).toEqual({})
  })
})
