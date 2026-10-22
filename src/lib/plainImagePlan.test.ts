import { describe, expect, it } from 'vitest'

import type { InputImage } from '../types'
import { planPlainRequests } from './plainImagePlan'

const img = (id: string): InputImage => ({ id, dataUrl: `data:image/jpeg;base64,${id}` })
const ids = (list: InputImage[]) => list.map((item) => item.id)

const variableImages = Array.from({ length: 8 }, (_, i) => img(`v${i}`))
const fixedImages = [img('f0'), img('f1')]

describe('批量模式：每个请求一张变量图', () => {
  it('数量与图数一致时一一对应', () => {
    const plan = planPlainRequests({
      mode: 'batch',
      count: 10,
      variableImages: Array.from({ length: 10 }, (_, i) => img(`v${i}`)),
      fixedImages: [],
    })
    expect(plan).toHaveLength(10)
    expect(plan?.map((item) => ids(item.images))).toEqual(
      Array.from({ length: 10 }, (_, i) => [`v${i}`]),
    )
  })

  it('图不够时循环使用', () => {
    const plan = planPlainRequests({ mode: 'batch', count: 10, variableImages, fixedImages: [] })
    expect(plan).toHaveLength(10)
    expect(plan?.[8]?.images[0].id).toBe('v0')
    expect(plan?.[9]?.images[0].id).toBe('v1')
  })

  it('固定图不参与批量请求', () => {
    const plan = planPlainRequests({ mode: 'batch', count: 2, variableImages, fixedImages })
    expect(plan?.every((item) => item.images.length === 1)).toBe(true)
    expect(plan?.some((item) => item.images.some((image) => image.id.startsWith('f')))).toBe(false)
  })

  it('只有固定图时也照常发，不丢图', () => {
    const plan = planPlainRequests({ mode: 'batch', count: 3, variableImages: [], fixedImages })
    expect(plan?.map((item) => ids(item.images))).toEqual([['f0'], ['f1'], ['f0']])
  })

  it('没有任何图时返回 null，交给纯文生图逻辑', () => {
    expect(planPlainRequests({ mode: 'batch', count: 4, variableImages: [], fixedImages: [] })).toBeNull()
  })
})

describe('融图模式：变量图分组 + 固定图每请求都带', () => {
  it('数量 1 时所有图放同一个请求', () => {
    const plan = planPlainRequests({ mode: 'merge', count: 1, variableImages, fixedImages })
    expect(plan).toHaveLength(1)
    expect(ids(plan![0].images)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'f0', 'f1'])
  })

  it('数量 4、8 张变量图：每组 2 张变量 + 全部固定图', () => {
    const plan = planPlainRequests({ mode: 'merge', count: 4, variableImages, fixedImages })
    expect(plan?.map((item) => ids(item.images))).toEqual([
      ['v0', 'v1', 'f0', 'f1'],
      ['v2', 'v3', 'f0', 'f1'],
      ['v4', 'v5', 'f0', 'f1'],
      ['v6', 'v7', 'f0', 'f1'],
    ])
  })

  it('变量图少于数量时循环补，每组一张', () => {
    const plan = planPlainRequests({ mode: 'merge', count: 4, variableImages: [img('v0'), img('v1'), img('v2')], fixedImages })
    expect(plan?.map((item) => item.images[0].id)).toEqual(['v0', 'v1', 'v2', 'v0'])
    expect(plan?.every((item) => item.images.length === 3)).toBe(true)
  })

  it('除不尽时每组张数一致，多出来的用循环补', () => {
    const plan = planPlainRequests({ mode: 'merge', count: 3, variableImages, fixedImages: [] })
    // ceil(8/3) = 3 张一组，最后一组循环回到第一张
    expect(plan?.map((item) => ids(item.images))).toEqual([
      ['v0', 'v1', 'v2'],
      ['v3', 'v4', 'v5'],
      ['v6', 'v7', 'v0'],
    ])
  })

  it('只有固定图时每个请求带同一组', () => {
    const plan = planPlainRequests({ mode: 'merge', count: 3, variableImages: [], fixedImages })
    expect(plan?.map((item) => ids(item.images))).toEqual([['f0', 'f1'], ['f0', 'f1'], ['f0', 'f1']])
  })

  it('数量写成 0 或负数时按 1 次处理', () => {
    expect(planPlainRequests({ mode: 'merge', count: 0, variableImages, fixedImages })).toHaveLength(1)
    expect(planPlainRequests({ mode: 'merge', count: -3, variableImages, fixedImages })).toHaveLength(1)
  })
})
