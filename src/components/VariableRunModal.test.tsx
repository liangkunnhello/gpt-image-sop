// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskRecord, VariablePrompt } from '../types'
import { useSopStore } from '../lib/sopStore'
import VariableRunModal from './VariableRunModal'

/**
 * 变量模式不再让用户勾「直接出图」开关，通道由「有没有参考图」自动决定：
 * 有参考图 = 提取策略（变量提示词当提取指令），没参考图 = 直接拿变量提示词生图。
 * 这里盯住判定、回调参数，以及没参考图又用内置提取策略时不给跑。
 */

vi.mock('../lib/db', () => ({
  CURRENT_THUMBNAIL_VERSION: 2,
  getAllTasks: async () => [],
  putTask: async (task: TaskRecord) => task.id,
  deleteTask: async () => {},
  commitTaskDeletion: async () => {},
  clearTasks: async () => {},
  getAllAgentConversations: async () => [],
  putAgentConversation: async (conversation: { id: string }) => conversation.id,
  replaceAgentConversations: async () => {},
  clearAgentConversations: async () => {},
  getImage: async () => undefined,
  getStoredImageThumbnail: async () => undefined,
  getAllImageIds: async () => [],
  putImage: async (image: { id: string }) => image.id,
  putImageThumbnail: async () => {},
  deleteImage: async () => {},
  clearImages: async () => {},
  storeImage: async () => 'stored',
  storeImageWithSize: async () => ({ id: 'stored' }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

/** 用户自己写的「骨架 + 可变项」，能直接拿来生图 */
const OWN_PROMPT: VariablePrompt = {
  id: 'vp1',
  productId: '',
  name: '自写骨架',
  content: '中央 {{主体}} 的主视觉\n- {{主体}}：圆盘 / 方框',
  updatedAt: 0,
}

beforeEach(() => {
  useSopStore.setState({
    directions: [],
    variablePrompts: [],
    activeDirectionId: '',
    lastPick: {},
    defaultPick: {},
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function render(props: {
  imageCount?: number
  fixedCount?: number
  variableCount?: number
} = {}) {
  const onConfirm = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <VariableRunModal
        imageCount={props.imageCount ?? 0}
        fixedCount={props.fixedCount ?? 0}
        variableCount={props.variableCount ?? 0}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    )
  })
  const button = [...container.querySelectorAll('button')]
    .find((el) => el.textContent === '开始生成') as HTMLButtonElement
  return { container, onConfirm, button }
}

describe('变量模式的通道判定', () => {
  it('有参考图就走提取策略，回调 skipExtract=false', () => {
    const { container, onConfirm, button } = render({ imageCount: 3 })
    expect(container.textContent).toContain('提取策略')
    expect(container.textContent).toContain('先调模型提取策略')
    expect(button.disabled).toBe(false)
    act(() => button.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].skipExtract).toBe(false)
  })

  it('没有参考图、选了自己写的变量提示词，就直接出图', () => {
    useSopStore.setState({ variablePrompts: [OWN_PROMPT] })
    const { container, onConfirm, button } = render({ imageCount: 0, variableCount: 2 })
    expect(container.textContent).toContain('直接出图')
    expect(container.textContent).toContain('不调模型')
    expect(button.disabled).toBe(false)
    act(() => button.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].skipExtract).toBe(true)
  })

  it('没有参考图却用内置提取策略：不给跑，并说明要什么', () => {
    const { container, button } = render({ imageCount: 0, fixedCount: 1 })
    expect(container.textContent).toContain('提取策略需要参考图')
    expect(button.disabled).toBe(true)
  })
})
