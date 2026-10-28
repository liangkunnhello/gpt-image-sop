// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_VECTORS,
  VECTOR_VERSION,
  __resetClipVectorsForTest,
  clipVectorCount,
  flushClipVectors,
  hasClipVector,
  listClipVectorIds,
  matchAgainstLibrary,
  putClipVector,
  quantizeVector,
  removeClipVectors,
} from './clipVectors'

/**
 * 造一个 int8 向量并编码成 base64，模拟服务端返回。
 * 只给前几维取值，其余为 0 —— 这样两张图的余弦相似度就等于那几维的方向一致程度。
 */
function vectorBase64(values: number[]): string {
  const vec = new Int8Array(values.length)
  for (let i = 0; i < values.length; i += 1) vec[i] = values[i]
  let text = ''
  for (let i = 0; i < vec.length; i += 1) text += String.fromCharCode(vec[i])
  return btoa(text)
}

beforeEach(() => {
  __resetClipVectorsForTest()
  localStorage.clear()
})

afterEach(() => {
  __resetClipVectorsForTest()
  localStorage.clear()
  vi.useRealTimers()
})

describe('图像向量库', () => {
  it('存进去能查、能算张数、能列举', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    putClipVector('img-b', vectorBase64([0, 100, 0]))
    expect(hasClipVector('img-a')).toBe(true)
    expect(hasClipVector('img-c')).toBe(false)
    expect(clipVectorCount()).toBe(2)
    expect(clipVectorCount(['img-a'])).toBe(1)
    expect(listClipVectorIds().sort()).toEqual(['img-a', 'img-b'])
  })

  it('同一方向的向量相似度接近 1，正交方向接近 0', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    putClipVector('img-b', vectorBase64([90, 40, 0]))
    putClipVector('img-c', vectorBase64([0, 100, 0]))

    const same = matchAgainstLibrary('img-a')!
    expect(same.nearest).toBe('img-b')
    expect(same.max).toBeGreaterThan(0.9)
    expect(same.count).toBe(2)
    // c 与 a 正交，均值被拉低
    expect(same.mean).toBeLessThan(same.max)
  })

  it('不和自己比：最近的那张永远是别人', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    putClipVector('img-b', vectorBase64([100, 0, 0]))
    const match = matchAgainstLibrary('img-a')!
    expect(match.nearest).toBe('img-b')
    expect(match.max).toBeCloseTo(1, 5)
  })

  it('库里只有自己时返回 null（没有可比的对象）', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    expect(matchAgainstLibrary('img-a')).toBeNull()
  })

  it('没入库的图直接返回 null，不会按 0 处理', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    expect(matchAgainstLibrary('img-unknown')).toBeNull()
  })

  it('skip 里的图不参与比对（比如同卡里已进回收站的）', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    putClipVector('img-b', vectorBase64([100, 0, 0]))
    putClipVector('img-c', vectorBase64([0, 100, 0]))
    const match = matchAgainstLibrary('img-a', ['img-b'])!
    expect(match.nearest).toBe('img-c')
    expect(match.count).toBe(1)
  })

  it('删图时清掉向量，库不会越攒越虚', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    putClipVector('img-b', vectorBase64([0, 100, 0]))
    removeClipVectors(['img-a', 'img-不存在'])
    expect(hasClipVector('img-a')).toBe(false)
    expect(clipVectorCount()).toBe(1)
  })

  it('防抖落盘：多次写入只写一次，flush 后重启还能读回', () => {
    vi.useFakeTimers()
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    putClipVector('img-b', vectorBase64([0, 100, 0]))
    expect(localStorage.getItem('gpt-image-clip-vectors')).toBeNull()
    vi.advanceTimersByTime(1500)
    const raw = localStorage.getItem('gpt-image-clip-vectors')
    expect(raw).toBeTruthy()

    // 模拟重启：清掉内存缓存后应能从本地读回
    __resetClipVectorsForTest()
    expect(clipVectorCount()).toBe(2)
    expect(JSON.parse(raw!).version).toBe(VECTOR_VERSION)
  })

  it('手动 flush 立刻落盘（退出前用）', () => {
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    flushClipVectors()
    expect(localStorage.getItem('gpt-image-clip-vectors')).toBeTruthy()
  })

  it('版本不对的旧记录整体作废，不会拿旧模型的向量冒充', () => {
    localStorage.setItem('gpt-image-clip-vectors', JSON.stringify({
      version: 'old-model-v0',
      items: { 'img-a': { v: vectorBase64([100, 0, 0]), n: 100, t: 1 } },
    }))
    expect(clipVectorCount()).toBe(0)
    expect(hasClipVector('img-a')).toBe(false)
  })

  it('坏数据不至于把整个库读崩', () => {
    localStorage.setItem('gpt-image-clip-vectors', '{不是 JSON')
    expect(clipVectorCount()).toBe(0)
    putClipVector('img-a', vectorBase64([100, 0, 0]))
    expect(clipVectorCount()).toBe(1)
  })

  it('超出上限时保留最新的那批', () => {
    vi.useFakeTimers()
    for (let i = 0; i < MAX_VECTORS + 5; i += 1) {
      putClipVector(`img-${i}`, vectorBase64([100, 0, 0]))
    }
    flushClipVectors()
    const saved = JSON.parse(localStorage.getItem('gpt-image-clip-vectors')!) as { items: Record<string, unknown> }
    expect(Object.keys(saved.items).length).toBe(MAX_VECTORS)
    // 最老的被淘汰，最新的还在
    expect(saved.items['img-0']).toBeUndefined()
    expect(saved.items[`img-${MAX_VECTORS + 4}`]).toBeTruthy()
  })

  it('quantizeVector 把浮点量化成 int8 base64，能原样回读', () => {
    const quantized = quantizeVector([1, 0, -1, 0.5])!
    expect(quantized).toBeTruthy()
    putClipVector('img-a', quantized.base64)
    putClipVector('img-b', quantizeVector([1, 0, -1, 0.5])!.base64)
    const match = matchAgainstLibrary('img-a')!
    expect(match.max).toBeCloseTo(1, 3)
  })

  it('空向量不写进库', () => {
    putClipVector('img-a', '')
    putClipVector('', vectorBase64([100]))
    expect(clipVectorCount()).toBe(0)
    expect(quantizeVector([])).toBeNull()
  })
})
