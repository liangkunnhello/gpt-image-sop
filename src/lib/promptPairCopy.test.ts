import { describe, expect, it } from 'vitest'
import { hasCopyablePrompt, joinPromptsForClipboard } from './promptPairCopy'

describe('全部复制：提示词怎么拼', () => {
  it('多条之间用空行分隔（可直接粘回输入框按空行切成多条）', () => {
    expect(joinPromptsForClipboard(['第一条', '第二条'])).toBe('第一条\n\n第二条')
  })

  it('只有一条时不加分隔符，原样返回', () => {
    expect(joinPromptsForClipboard(['就一条'])).toBe('就一条')
  })

  it('空白条目被跳过，不会复制出一堆空行', () => {
    expect(joinPromptsForClipboard(['第一条', '   ', '', '第二条'])).toBe('第一条\n\n第二条')
  })

  it('两边空白会去掉（提示词末尾的空行不该带进去）', () => {
    expect(joinPromptsForClipboard(['  第一条  ', '\n第二条\n'])).toBe('第一条\n\n第二条')
  })

  it('一条都没有时给空串（调用方据此提示而不是复制出空内容）', () => {
    expect(joinPromptsForClipboard([])).toBe('')
    expect(joinPromptsForClipboard(['', '  '])).toBe('')
    expect(joinPromptsForClipboard([undefined, null])).toBe('')
  })

  it('不加「第 N 条」这类编号：编号会被当成提示词内容一起发出去', () => {
    const text = joinPromptsForClipboard(['甲', '乙', '丙'])
    expect(text).not.toContain('第 1 条')
    expect(text).not.toContain('1.')
    expect(text).toBe('甲\n\n乙\n\n丙')
  })

  it('提示词内部的换行原样保留（本来就是多段内容）', () => {
    expect(joinPromptsForClipboard(['第一行\n第二行', '另一条'])).toBe('第一行\n第二行\n\n另一条')
  })
})

describe('哪些提示词值得复制', () => {
  it('有内容的算', () => {
    expect(hasCopyablePrompt('内容')).toBe(true)
  })

  it('空白 / 空值不算（不显示复制按钮，免得点出一片空）', () => {
    expect(hasCopyablePrompt('   ')).toBe(false)
    expect(hasCopyablePrompt('')).toBe(false)
    expect(hasCopyablePrompt(undefined)).toBe(false)
    expect(hasCopyablePrompt(null)).toBe(false)
  })
})
