import { describe, expect, it } from 'vitest'

import type { SopDirectionNode, SopSystemPrompt, VariablePrompt } from '../types'
import { scopeChain, nearestScopeId, scopeWithItems } from './sopScope'
import { resolveSystemPrompt } from '../components/SopSystemPromptPicker'
import { resolvePickedPreset } from '../components/SopPresetPicker'
import { resolveVariablePrompt } from '../components/VariablePromptPicker'
import { BUILTIN_VARIABLE_PROMPT } from './variablePipeline'
import { NO_PRESET, type SopPick, type SopPreset } from './sopStore'

function node(id: string, parentId: string | null, kind: SopDirectionNode['kind']): SopDirectionNode {
  return { id, parentId, name: id, kind }
}

// 用户的真实结构：先建产品「中华」，再在它下面建方向「图标 / 扁平插画」
const tree = [
  node('中华', null, 'product'),
  node('图标', '中华', 'direction'),
  node('扁平插画', '中华', 'direction'),
]

const prompt = (id: string, productId: string, content = id): SopSystemPrompt => ({
  id,
  productId,
  name: id,
  content,
  updatedAt: 0,
})

const preset = (id: string, productId: string, kind: SopPreset['kind']): SopPreset => ({
  id,
  productId,
  kind,
  name: id,
  content: id,
  updatedAt: 0,
})

const variablePrompt = (id: string, productId: string): VariablePrompt => ({
  id,
  productId,
  name: id,
  content: id,
  updatedAt: 0,
})

const noPick: Record<string, SopPick> = {}

describe('作用域链', () => {
  it('从节点自己一路到根', () => {
    expect(scopeChain(tree, '图标')).toEqual(['图标', '中华'])
  })

  it('方向归到父产品，产品用自己', () => {
    expect(nearestScopeId(tree, '图标')).toBe('中华')
    expect(nearestScopeId(tree, '中华')).toBe('中华')
  })

  it('脏数据成环不会死循环', () => {
    const cyclic = [node('a', 'b', 'direction'), node('b', 'a', 'direction')]
    expect(scopeChain(cyclic, 'a')).toEqual(['a', 'b'])
  })

  it('就近找第一个有内容的层', () => {
    expect(scopeWithItems(tree, '图标', (id) => id === '中华')).toBe('中华')
    // 自己那层就有内容时不再往上找
    expect(scopeWithItems(tree, '图标', (id) => id === '图标' || id === '中华')).toBe('图标')
    // 都没有则用最近的存储层
    expect(scopeWithItems(tree, '图标', () => false)).toBe('中华')
  })
})

describe('系统提示词按作用域继承', () => {
  it('产品配了提示词，新建的方向直接取到', () => {
    const prompts = [prompt('p1', '中华')]
    const current = resolveSystemPrompt(prompts, scopeChain(tree, '图标'), '图标', noPick, noPick)
    expect(current?.id).toBe('p1')
  })

  it('方向自己配了就用自己那份', () => {
    const prompts = [prompt('p1', '中华'), prompt('p2', '图标')]
    const current = resolveSystemPrompt(prompts, scopeChain(tree, '图标'), '图标', noPick, noPick)
    expect(current?.id).toBe('p2')
  })

  it('显式选过上层那份也认', () => {
    const prompts = [prompt('p1', '中华'), prompt('p2', '图标')]
    const lastPick = { 图标: { promptId: 'p1' } } as Record<string, SopPick>
    const current = resolveSystemPrompt(prompts, scopeChain(tree, '图标'), '图标', lastPick, noPick)
    expect(current?.id).toBe('p1')
  })

  it('整条链都没有才算未设置', () => {
    const prompts = [prompt('p9', '别的产品')]
    expect(resolveSystemPrompt(prompts, scopeChain(tree, '图标'), '图标', noPick, noPick)).toBeUndefined()
  })

  it('「不使用」优先于继承', () => {
    const prompts = [prompt('p1', '中华')]
    const lastPick = { 图标: { promptId: NO_PRESET } } as Record<string, SopPick>
    expect(resolveSystemPrompt(prompts, scopeChain(tree, '图标'), '图标', lastPick, noPick)).toBeUndefined()
  })
})

describe('卖点 / 风格同样继承', () => {
  it('产品上的卖点方向能取到', () => {
    const presets = [preset('k1', '中华', 'point')]
    const current = resolvePickedPreset(presets, '图标', scopeChain(tree, '图标'), 'point', noPick, noPick)
    expect(current?.id).toBe('k1')
  })

  it('卖点与风格互不串味', () => {
    const presets = [preset('k1', '中华', 'point'), preset('s1', '中华', 'style')]
    const style = resolvePickedPreset(presets, '图标', scopeChain(tree, '图标'), 'style', noPick, noPick)
    expect(style?.id).toBe('s1')
  })
})

describe('变量提示词继承', () => {
  it('产品上的变量提示词方向能取到', () => {
    const prompts = [variablePrompt('v1', '中华')]
    const current = resolveVariablePrompt(prompts, scopeChain(tree, '图标'), '图标', noPick, noPick)
    expect(current?.id).toBe('v1')
  })

  it('一条都没有时退回内置策略', () => {
    const current = resolveVariablePrompt([], scopeChain(tree, '图标'), '图标', noPick, noPick)
    expect(current?.id).toBe(BUILTIN_VARIABLE_PROMPT.id)
  })
})
