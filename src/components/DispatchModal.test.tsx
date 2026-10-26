// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { createPostTemplate } from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'
import { useStore } from '../store'
import DispatchModal from './DispatchModal'

/**
 * 派发弹窗：目标按「产品-方向」列出来，能出几张由原图比例决定。
 * 这里验三件事：只列有启用模板的目标、比例对不上的目标不可选、汇总张数跟着勾选走。
 */

// 1×1 的 PNG，用来让 imageSizeFromDataUrl 读出真实比例（方图）
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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
  getImage: async (id: string) => ({ id, dataUrl: PNG_1X1, createdAt: 1 }),
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

beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const task = (): TaskRecord => ({
  id: 'task-a',
  prompt: '月球上的医疗险海报',
  params: { ...DEFAULT_PARAMS },
  inputImageIds: [],
  outputImages: ['out-1', 'out-2'],
  status: 'done',
  error: null,
  createdAt: 1,
  finishedAt: 2,
  elapsed: 1,
  sopName: '大字报',
})

const squareTemplate = () => ({ ...createPostTemplate(2048, 2048, '方图'), enabled: true })

let root: ReturnType<typeof createRoot> | null = null

beforeEach(() => {
  useSopStore.setState({
    directions: [
      { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
      { id: 'prod-a', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
      { id: 'dir-a1', parentId: 'prod-a', name: '月亮', kind: 'direction' },
      { id: 'dir-a2', parentId: 'prod-a', name: '大字报', kind: 'direction' },
    ],
    // 产品有模板，两个方向都继承它；类目没有模板
    postTemplates: { 'prod-a': [squareTemplate()] },
    deliveryDirs: { 'prod-a': 'D:\\交付\\百万医疗险' },
  })
  useStore.setState({ settings: { ...useStore.getState().settings, saveLocationMode: 'default' } })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function render() {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<DispatchModal task={task()} onClose={() => {}} />)
  })
  // 原图尺寸是异步读出来的，等一轮微任务让汇总文案变成真实张数
  await act(async () => {})
  return container
}

function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('label')].map((node) => node.textContent ?? '')
}

function checkboxOf(container: HTMLElement, text: string): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find((node) => (node.textContent ?? '').includes(text))
  const input = label?.querySelector('input')
  if (!input) throw new Error(`没找到「${text}」这一行的勾选框`)
  return input as HTMLInputElement
}

function dispatchButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) => (node.textContent ?? '').startsWith('开始派发'))
  if (!button) throw new Error('没找到开始派发按钮')
  return button as HTMLButtonElement
}

describe('派发弹窗', () => {
  it('只列产品与方向，顶层类目不出现', async () => {
    const container = await render()
    const labels = rowLabels(container)
    expect(labels.some((text) => text.includes('保险 / 百万医疗险'))).toBe(true)
    expect(labels.some((text) => text.includes('保险 / 百万医疗险 / 月亮'))).toBe(true)
    // 1 个产品 + 2 个方向；类目只是分组容器，不该多出一行
    expect(labels).toHaveLength(3)
  })

  it('每行报出能出几张，并带交付地址', async () => {
    const container = await render()
    const label = rowLabels(container).find((text) => text.includes('月亮'))
    expect(label).toContain('2 张')
    expect(label).toContain('D:\\交付\\百万医疗险')
  })

  it('原图尺寸读出来后按张数汇总', async () => {
    const container = await render()
    expect(container.textContent).toContain('共 2 张')
    await act(async () => { checkboxOf(container, '月亮').click() })
    expect(dispatchButton(container).textContent).toContain('（2 张）')
  })

  it('全选把所有能出图的目标一起勾上', async () => {
    const container = await render()
    const selectAll = [...container.querySelectorAll('button')].find((node) => node.textContent === '全选')
    await act(async () => { selectAll!.click() })
    // 产品 + 两个方向，各 2 张
    expect(dispatchButton(container).textContent).toContain('（6 张）')
  })

  it('一个目标都没选时按钮不可点', async () => {
    const container = await render()
    expect(dispatchButton(container).disabled).toBe(true)
  })
})
