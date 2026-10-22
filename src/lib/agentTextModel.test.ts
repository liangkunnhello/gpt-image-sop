import { describe, expect, it } from 'vitest'

import type { ApiProfile } from '../types'
import { applyAgentTextModel } from './agentTextModel'

const profile = (model: string, selectedModel?: string): ApiProfile => ({
  id: 'p1',
  name: '默认（文本）',
  provider: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model,
  selectedModel,
  timeout: 120,
  apiMode: 'responses',
  codexCli: false,
  apiProxy: false,
  transparentBackgroundMethod: 'api',
})

describe('文本模型选择', () => {
  it('模型已在列表里时只改选中项', () => {
    const next = applyAgentTextModel(profile('gpt-6.1-sol, gpt-4.1'), 'gpt-4.1')
    expect(next.model).toBe('gpt-6.1-sol, gpt-4.1')
    expect(next.selectedModel).toBe('gpt-4.1')
  })

  it('新模型自动追加进列表，否则 agent 解析时会回退到第一个', () => {
    const next = applyAgentTextModel(profile('gpt-6.1-sol'), 'deepseek-v4.1-flash')
    expect(next.model).toBe('gpt-6.1-sol, deepseek-v4.1-flash')
    expect(next.selectedModel).toBe('deepseek-v4.1-flash')
  })

  it('中文逗号也能识别，不重复追加', () => {
    const next = applyAgentTextModel(profile('gpt-6.1-sol，gpt-4.1'), 'gpt-4.1')
    expect(next.model).toBe('gpt-6.1-sol, gpt-4.1')
    expect(next.selectedModel).toBe('gpt-4.1')
  })

  it('空输入保持原配置', () => {
    const source = profile('gpt-6.1-sol')
    expect(applyAgentTextModel(source, '   ')).toBe(source)
  })

  it('已经选中同一个模型时返回原对象，避免无谓的重渲染', () => {
    const source = profile('gpt-6.1-sol, gpt-4.1', 'gpt-4.1')
    expect(applyAgentTextModel(source, 'gpt-4.1')).toBe(source)
  })
})
