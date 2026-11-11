import { describe, expect, it } from 'vitest'

import type { SavedSop } from '../types'
import { resolveSavedSop, isSavedSopOff } from './savedSop'
import { NO_PRESET, resolvePick, type SopPick } from './sopStore'

const SOPS: SavedSop[] = [
  { id: 'sop-prod', productId: 'prod-1', name: '产品级 SOP', content: 'A', updatedAt: 1 },
  { id: 'sop-dir', productId: 'dir-1', name: '方向级 SOP', content: 'B', updatedAt: 1 },
  { id: 'sop-other', productId: 'prod-2', name: '别的产品', content: 'C', updatedAt: 1 },
]

/** 与 InputBar / SopSplitModal 一致的作用域链：自身 → 父 → 根 */
const CHAIN = ['dir-1', 'prod-1', 'cat-1']

describe('resolveSavedSop', () => {
  it('没有任何选择时不返回：保持「按参考图反推」的默认行为', () => {
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', {}, {})).toBeUndefined()
  })

  it('选了哪份就返回哪份，按作用域链就近找', () => {
    const pick: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-prod' } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', pick, {})?.id).toBe('sop-prod')
  })

  /**
   * 优先级在 2.0.12 反转：以前是「方向默认 > 上次使用」，导致设过默认的方向里，
   * 左侧列表点「不使用生图 SOP」写进 lastPick 后被 defaultPick 盖住，界面上毫无反应。
   * 现在以「用户这次的显式点选」为准，默认只在没点过时兜底。
   */
  it('显式点选优先于方向默认', () => {
    const last: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-prod' } }
    const preset: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-dir' } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', last, preset)?.id).toBe('sop-prod')
  })

  it('设过默认之后点「不使用生图 SOP」立刻生效', () => {
    const last: Record<string, SopPick> = { 'dir-1': { sopId: NO_PRESET } }
    const preset: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-dir' } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', last, preset)).toBeUndefined()
    expect(isSavedSopOff('dir-1', last, preset)).toBe(true)
  })

  it('这次没点过时仍按方向默认走', () => {
    const preset: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-dir' } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', {}, preset)?.id).toBe('sop-dir')
  })

  it('显式「不用 SOP」时不回退到第一条', () => {
    const pick: Record<string, SopPick> = { 'dir-1': { sopId: NO_PRESET } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', pick, {})).toBeUndefined()
    expect(isSavedSopOff('dir-1', pick, {})).toBe(true)
  })

  it('选中的 SOP 被删掉后返回 undefined，而不是拿别的顶上', () => {
    const pick: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-gone' } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', pick, {})).toBeUndefined()
  })

  it('id 对其他产品存在也不算命中：作用域链里没有该产品', () => {
    const pick: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-other' } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', pick, {})).toBeUndefined()
  })
})

describe('resolvePick（显式点选 > 方向默认）', () => {
  it('点了「不使用」就压过方向默认', () => {
    const last: Record<string, SopPick> = { 'dir-1': { sopId: NO_PRESET } }
    const preset: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-dir' } }
    expect(resolvePick(last, preset, 'dir-1').sopId).toBe(NO_PRESET)
  })

  it('按字段合并：只点了 SOP，卖点仍沿用默认', () => {
    const last: Record<string, SopPick> = { 'dir-1': { sopId: NO_PRESET } }
    const preset: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-dir', pointId: 'point-1' } }
    expect(resolvePick(last, preset, 'dir-1')).toEqual({ sopId: NO_PRESET, pointId: 'point-1' })
  })

  it('两边都没有时返回空对象，交给调用方退回第一条', () => {
    expect(resolvePick({}, {}, 'dir-1')).toEqual({})
  })
})
