import { describe, expect, it } from 'vitest'

import { dedupeCopyInPrompt, dedupePrompts, normalizeCopy } from './copyDedupe'

describe('normalizeCopy', () => {
  it('忽略空白、标点与全半角差异', () => {
    expect(normalizeCopy('住院 0 免赔')).toBe(normalizeCopy('住院0免赔'))
    expect(normalizeCopy('600万医疗保障！')).toBe(normalizeCopy('600万医疗保障'))
    expect(normalizeCopy('首月1元，')).toBe(normalizeCopy('首月 1 元'))
  })

  it('不同文案不会归一成同一个 key', () => {
    expect(normalizeCopy('住院 0 免赔')).not.toBe(normalizeCopy('门诊 0 免赔'))
  })
})

describe('dedupeCopyInPrompt', () => {
  it('同一句卖点在一张图里只保留第一次', () => {
    const prompt = '画面左侧大标题「600万医疗保障」，右侧角标再写一遍「600万医疗保障」，底部「住院0免赔」。'
    const { text, removed } = dedupeCopyInPrompt(prompt)
    expect(removed).toEqual(['600万医疗保障'])
    expect(text.match(/600万医疗保障/g)?.length).toBe(1)
    expect(text).toContain('住院0免赔')
  })

  it('空白与标点不同的同一句也判为重复', () => {
    const prompt = '主标题「住院 0 免赔」，角标「住院0免赔」。'
    const { text, removed } = dedupeCopyInPrompt(prompt)
    expect(removed).toEqual(['住院0免赔'])
    expect(text.match(/住院/g)?.length).toBe(1)
  })

  it('不同卖点不会互相误删', () => {
    const prompt = '主标题「600万医疗保障」，副标题「住院0免赔」，角标「首月1元」。'
    const { text, removed } = dedupeCopyInPrompt(prompt)
    expect(removed).toEqual([])
    expect(text).toBe(prompt)
  })

  it('没有重复时不改动原文', () => {
    const prompt = '一张没有文字的纯画面：海边的日出。'
    expect(dedupeCopyInPrompt(prompt).text).toBe(prompt)
  })

  it('删掉重复项后清理残留的悬挂标点', () => {
    const prompt = '标题「首月1元」，强调「首月1元」，，底部留白。'
    const { text } = dedupeCopyInPrompt(prompt)
    expect(text).not.toMatch(/，，/)
    expect(text.match(/首月1元/g)?.length).toBe(1)
  })
})

describe('dedupePrompts', () => {
  it('逐条清洗并汇总所有被删掉的重复卖点', () => {
    const { prompts, removed } = dedupePrompts([
      '大标题「A」，角标「A」。',
      '不要文字，只画风景。',
      '主标题「B」，副标题「B」，角标「C」。',
    ])
    expect(prompts).toHaveLength(3)
    expect(removed).toEqual(['A', 'B'])
    expect(prompts[0].match(/A/g)?.length).toBe(1)
    expect(prompts[2].match(/B/g)?.length).toBe(1)
    expect(prompts[2]).toContain('C')
  })

  it('去重是按单张图做的，不同条目之间互不影响', () => {
    const { prompts, removed } = dedupePrompts(['「A」', '「A」'])
    // 每张图各用一次「A」是允许的：卖点在各图保持一致，只有同一张图内不许重复
    expect(prompts).toHaveLength(2)
    expect(removed).toEqual([])
  })

  it('空白条目会被丢弃', () => {
    const { prompts } = dedupePrompts(['大标题「A」。', '   ', '\n'])
    expect(prompts).toHaveLength(1)
  })
})
