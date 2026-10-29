// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { MAX_SYSTEM_PROMPT_VERSIONS, useSopStore } from './sopStore'

/**
 * 系统提示词的版本管理。
 *
 * 一次保存只做一件事：把「被替换掉的那份」收进 history，当前内容换成新的。
 * 恢复则是反向的一次替换 —— 当前内容同样归档，所以误点也能退回来。
 */

beforeEach(() => {
  useSopStore.setState({ systemPrompts: [] })
})

function seed(content = '第一版正文') {
  return useSopStore.getState().addSystemPrompt('prod-1', '系统提示词 A', content)
}

function promptOf(id: string) {
  const found = useSopStore.getState().systemPrompts.find((item) => item.id === id)
  if (!found) throw new Error('系统提示词没找到')
  return found
}

describe('系统提示词版本管理', () => {
  it('保存新内容时，旧内容被收进历史，最新的排在最前', () => {
    const id = seed('第一版')
    useSopStore.getState().updateSystemPrompt(id, { content: '第二版' })
    useSopStore.getState().updateSystemPrompt(id, { content: '第三版' })

    const prompt = promptOf(id)
    expect(prompt.content).toBe('第三版')
    expect(prompt.history?.map((item) => item.content)).toEqual(['第二版', '第一版'])
  })

  it('只改名字不产生历史版本（内容没变，存进去只是重复）', () => {
    const id = seed('正文')
    useSopStore.getState().updateSystemPrompt(id, { name: '改个名字' })

    const prompt = promptOf(id)
    expect(prompt.name).toBe('改个名字')
    expect(prompt.history ?? []).toHaveLength(0)
  })

  it('来回改成同一份内容时，历史里不会出现两条一模一样的', () => {
    const id = seed('A')
    useSopStore.getState().updateSystemPrompt(id, { content: 'B' })
    useSopStore.getState().updateSystemPrompt(id, { content: 'A' })

    const contents = promptOf(id).history?.map((item) => item.content) ?? []
    expect(contents.filter((item) => item === 'A')).toHaveLength(1)
    expect(contents).toContain('B')
  })

  it('恢复某个版本：正文回到那一版，当前内容同时进历史', () => {
    const id = seed('第一版')
    useSopStore.getState().updateSystemPrompt(id, { content: '第二版' })

    const target = promptOf(id).history?.find((item) => item.content === '第一版')
    expect(target).toBeTruthy()
    useSopStore.getState().restoreSystemPromptVersion(id, target!.id)

    const prompt = promptOf(id)
    expect(prompt.content).toBe('第一版')
    // 恢复本身可撤销：刚被换下的「第二版」在历史里
    expect(prompt.history?.map((item) => item.content)).toContain('第二版')
    // 恢复过的那一版已经从历史移到当前，不该再重复出现
    expect(prompt.history?.filter((item) => item.content === '第一版')).toHaveLength(0)
  })

  it('版本数量有上限，超出的丢最旧的', () => {
    const id = seed('v0')
    for (let index = 1; index <= MAX_SYSTEM_PROMPT_VERSIONS + 5; index += 1) {
      useSopStore.getState().updateSystemPrompt(id, { content: `v${index}` })
    }

    const history = promptOf(id).history ?? []
    expect(history).toHaveLength(MAX_SYSTEM_PROMPT_VERSIONS)
    // 最新的（刚被换下的那份）在最前，最旧的已经被挤掉
    expect(history[0]?.content).toBe(`v${MAX_SYSTEM_PROMPT_VERSIONS + 4}`)
    expect(history.some((item) => item.content === 'v0')).toBe(false)
  })

  it('恢复到不存在的版本时什么都不改', () => {
    const id = seed('正文')
    useSopStore.getState().restoreSystemPromptVersion(id, 'not-exist')
    expect(promptOf(id).content).toBe('正文')
  })
})
