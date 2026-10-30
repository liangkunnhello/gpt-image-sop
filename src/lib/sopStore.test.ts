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

/**
 * 侧栏排序：显示顺序就是 directions 数组的顺序。
 * 上移/下移走 moveSibling，拖拽走 reorderNode，两者都只在同级内生效 ——
 * 跨层级是「移动节点」的活，排序不该顺手把节点挪到别的父级下。
 */
describe('产品 / 方向的排序', () => {
  const seed = () => [
    { id: 'cat-1', parentId: null, name: '保险', kind: 'category' as const },
    { id: 'prod-1', parentId: 'cat-1', name: '产品甲', kind: 'product' as const },
    { id: 'prod-2', parentId: 'cat-1', name: '产品乙', kind: 'product' as const },
    { id: 'dir-1', parentId: 'prod-1', name: '方向一', kind: 'direction' as const },
    { id: 'dir-2', parentId: 'prod-1', name: '方向二', kind: 'direction' as const },
  ]

  const names = (parentId: string | null) => useSopStore
    .getState()
    .directions
    .filter((node) => node.parentId === parentId && !node.deletedAt)
    .map((node) => node.name)

  it('上移 / 下移换的是同级里的位置', () => {
    useSopStore.setState({ directions: seed() })
    useSopStore.getState().moveSibling('dir-2', -1)
    expect(names('prod-1')).toEqual(['方向二', '方向一'])

    useSopStore.getState().moveSibling('dir-1', -1)
    expect(names('prod-1')).toEqual(['方向一', '方向二'])
  })

  it('到顶 / 到底时什么都不做', () => {
    useSopStore.setState({ directions: seed() })
    useSopStore.getState().moveSibling('dir-1', -1)
    expect(names('prod-1')).toEqual(['方向一', '方向二'])
    useSopStore.getState().moveSibling('dir-2', 1)
    expect(names('prod-1')).toEqual(['方向一', '方向二'])
  })

  it('产品之间的顺序同样能调', () => {
    useSopStore.setState({ directions: seed() })
    useSopStore.getState().moveSibling('prod-2', -1)
    expect(names('cat-1')).toEqual(['产品乙', '产品甲'])
  })

  it('拖拽：放到目标前面 / 后面', () => {
    useSopStore.setState({ directions: seed() })
    useSopStore.getState().reorderNode('dir-1', 'dir-2', 'after')
    expect(names('prod-1')).toEqual(['方向二', '方向一'])

    useSopStore.getState().reorderNode('dir-1', 'dir-2', 'before')
    expect(names('prod-1')).toEqual(['方向一', '方向二'])
  })

  it('跨层级拖动不生效（那是「移动到…」的活）', () => {
    useSopStore.setState({ directions: seed() })
    useSopStore.getState().reorderNode('dir-1', 'prod-2', 'after')
    expect(names('prod-1')).toEqual(['方向一', '方向二'])
    expect(useSopStore.getState().directions.find((node) => node.id === 'dir-1')?.parentId).toBe('prod-1')
  })

  it('回收站里的节点不占显示位，不影响邻居上移', () => {
    const list = seed().map((node) => (node.id === 'dir-1' ? { ...node, deletedAt: 1 } : node))
    useSopStore.setState({ directions: list })
    // 活着的只剩 dir-2，它已经在顶上了
    useSopStore.getState().moveSibling('dir-2', -1)
    expect(names('prod-1')).toEqual(['方向二'])
  })
})
