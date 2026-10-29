// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskRecord } from '../types'

// 复制与缩略图都换成可观测的桩：只验「点了复制的是哪段文本」
const copyTextToClipboard = vi.fn()
vi.mock('../lib/clipboard', () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
  getClipboardFailureMessage: (fallback: string) => fallback,
}))
vi.mock('../lib/imageCache', () => ({
  ensureImageThumbnailCached: async () => '',
  subscribeImageThumbnail: () => () => {},
}))

const showToast = vi.fn()

const { default: PromptPairModal } = await import('./PromptPairModal')
const { useStore } = await import('../store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeTask(patch: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'id',
    prompt: '',
    status: 'done',
    error: null,
    outputImages: [],
    inputImageIds: [],
    createdAt: 0,
    finishedAt: null,
    elapsed: null,
    sopJobId: 'job-1',
    ...patch,
  } as unknown as TaskRecord
}

const TASKS = [
  makeTask({ id: 'a', sopPromptIndex: 1, prompt: '提示词甲' }),
  makeTask({ id: 'b', sopPromptIndex: 2, prompt: '提示词乙' }),
  makeTask({ id: 'c', sopPromptIndex: 3, prompt: '提示词丙' }),
]

let root: ReturnType<typeof createRoot> | null = null

beforeEach(() => {
  copyTextToClipboard.mockReset()
  copyTextToClipboard.mockResolvedValue(undefined)
  showToast.mockReset()
  useStore.setState({ showToast })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function render(tasks: TaskRecord[] = TASKS): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<PromptPairModal tasks={tasks} title="测试卡" onClose={() => {}} />)
  })
  // 弹窗用 createPortal 挂到 body 上，查询要从 document.body 找
  return document.body
}

/** 按 title 找按钮并点击 */
async function clickByTitle(container: HTMLElement, title: string, index = 0) {
  const buttons = [...container.querySelectorAll('button')].filter((node) => node.getAttribute('title') === title)
  expect(buttons.length, `找不到按钮：${title}`).toBeGreaterThan(index)
  await act(async () => {
    buttons[index].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('对照表里一键复制提示词', () => {
  it('每条提示词都有自己的复制按钮', async () => {
    const container = await render()
    const copyButtons = [...container.querySelectorAll('button')].filter((node) => node.getAttribute('title') === '复制这条提示词')
    expect(copyButtons).toHaveLength(3)
  })

  it('点第 2 条的复制，复制的是第 2 条提示词（不串条）', async () => {
    const container = await render()
    await clickByTitle(container, '复制这条提示词', 1)
    expect(copyTextToClipboard).toHaveBeenCalledWith('提示词乙')
    expect(showToast).toHaveBeenCalledWith('已复制第 2 条提示词', 'success')
  })

  it('顶部「复制全部」按空行分隔拼所有提示词', async () => {
    const container = await render()
    await clickByTitle(container, '按空行分隔复制全部提示词，可直接粘回输入框批量跑')
    expect(copyTextToClipboard).toHaveBeenCalledWith('提示词甲\n\n提示词乙\n\n提示词丙')
    expect(showToast).toHaveBeenCalledWith('已复制全部 3 条提示词', 'success')
  })

  it('空白提示词不显示复制按钮（点不出空内容）', async () => {
    const container = await render([
      makeTask({ id: 'a', sopPromptIndex: 1, prompt: '有内容的' }),
      makeTask({ id: 'b', sopPromptIndex: 2, prompt: '   ' }),
    ])
    const copyButtons = [...container.querySelectorAll('button')].filter((node) => node.getAttribute('title') === '复制这条提示词')
    expect(copyButtons).toHaveLength(1)
  })

  it('只有一条可复制时不显示「复制全部」（和单条按钮重复）', async () => {
    const container = await render([makeTask({ id: 'a', sopPromptIndex: 1, prompt: '只有一条' })])
    const allButton = [...container.querySelectorAll('button')].filter(
      (node) => node.getAttribute('title') === '按空行分隔复制全部提示词，可直接粘回输入框批量跑',
    )
    expect(allButton).toHaveLength(0)
    // 单条复制按钮仍然要在，否则就是「整块都没渲染」而不是「故意不显示全部」
    const oneButton = [...container.querySelectorAll('button')].filter((node) => node.getAttribute('title') === '复制这条提示词')
    expect(oneButton).toHaveLength(1)
  })
})
