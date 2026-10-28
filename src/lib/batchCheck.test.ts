import { describe, expect, it } from 'vitest'
import { expectForTask, expectFromPrompt } from './batchCheck'

describe('expectFromPrompt', () => {
  it('只认「」包住的文案，最长那条当主标题', () => {
    const got = expectFromPrompt('标题「赔付总限额600万」副标题「带病投保」')
    expect(got.mainTitle).toBe('赔付总限额600万')
    expect(got.tags).toEqual(['带病投保'])
  })

  it('没有「」时给空', () => {
    const got = expectFromPrompt('纯画面描述')
    expect(got.mainTitle).toBe('')
    expect(got.tags).toEqual([])
  })
})

describe('expectForTask：卖点兜底', () => {
  it('提示词里有「」就用它，不看卖点', () => {
    const got = expectForTask({ prompt: '主标题「赔付总限额600万」', copyText: '另一段卖点' })
    expect(got.mainTitle).toBe('赔付总限额600万')
  })

  it('提示词里没有「」时用 copyText，最长那条当主标题', () => {
    const got = expectForTask({
      prompt: '纯画面描述，没有引号',
      copyText: '600万\n带病投保也能赔\n免赔额一万',
    })
    expect(got.mainTitle).toBe('带病投保也能赔')
    expect(got.tags).toEqual(['600万', '免赔额一万'])
  })

  it('copyText 用分号分隔同样能拆', () => {
    const got = expectForTask({ prompt: '', copyText: '第一条；第二条' })
    expect(got.mainTitle).toBe('第一条')
    expect(got.tags).toEqual(['第二条'])
  })

  it('都没有时给空（此时只判违规与压叠，不判文案）', () => {
    const got = expectForTask({ prompt: '纯画面', copyText: '  ' })
    expect(got.mainTitle).toBe('')
    expect(got.tags).toEqual([])
  })
})
