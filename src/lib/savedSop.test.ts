import { describe, expect, it } from 'vitest'

import type { SavedSop } from '../types'
import { resolveSavedSop, isSavedSopOff } from './savedSop'
import { NO_PRESET, type SopPick } from './sopStore'

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

  it('默认项优先于上次使用', () => {
    const last: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-prod' } }
    const preset: Record<string, SopPick> = { 'dir-1': { sopId: 'sop-dir' } }
    expect(resolveSavedSop(SOPS, CHAIN, 'dir-1', last, preset)?.id).toBe('sop-dir')
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
