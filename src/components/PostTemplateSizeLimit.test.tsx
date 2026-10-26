// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPostTemplate, type PostTemplate } from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'
import PostTemplateModal from './PostTemplateModal'

/**
 * 体积上限跟模板走：各平台的体积要求是绑在「渠道 + 尺寸」上的，
 * 输入区那个全局开关填不下一个尺寸一个值。这里验三件事：
 * 输入框存在、填了能存进模板、留空就是「不限制」。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  // jsdom 没有 ResizeObserver / 指针捕获，弹窗里的画布要用
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  proto.getBoundingClientRect = () => ({
    width: 500,
    height: 500,
    top: 0,
    left: 0,
    right: 500,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
})

const template = (): PostTemplate => ({
  ...createPostTemplate(2048, 2048, '方图'),
  enabled: true,
})

let root: ReturnType<typeof createRoot> | null = null

beforeEach(() => {
  useSopStore.setState({
    directions: [
      { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
      { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
    ],
    postTemplates: { 'prod-1': [template()] },
    postPreviewImages: {},
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function render() {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(<PostTemplateModal ownerId="prod-1" ownerName="百万医疗险" onClose={() => {}} />)
  })
  return container
}

/** 体积上限那一行的输入框 */
function sizeLimitInput(container: HTMLElement): HTMLInputElement {
  const label = [...container.querySelectorAll('div')].find((node) => node.textContent === '限制文件大小（留空不限制）')
  const input = label?.parentElement?.querySelector('input')
  if (!input) throw new Error('没找到「限制文件大小」输入框')
  return input as HTMLInputElement
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '保存')
  if (!button) throw new Error('没找到保存按钮')
  return button as HTMLButtonElement
}

/** 模拟真人全选后重打：受控输入必须走原生 setter，否则 React 收不到变更 */
async function retype(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function blur(input: HTMLInputElement) {
  await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
}

describe('后处理模板的体积上限', () => {
  it('模板设置里有「限制文件大小」，默认留空', () => {
    const container = render()
    expect(sizeLimitInput(container).value).toBe('')
  })

  it('填了 KB 后保存，写进这套模板', async () => {
    const container = render()
    const input = sizeLimitInput(container)
    await retype(input, '300')
    await blur(input)
    await act(async () => { saveButton(container).click() })
    expect(useSopStore.getState().postTemplates['prod-1'][0]?.maxFileKb).toBe(300)
  })

  it('留空保存表示不限制', async () => {
    useSopStore.setState({ postTemplates: { 'prod-1': [{ ...template(), maxFileKb: 500 }] } })
    const container = render()
    const input = sizeLimitInput(container)
    expect(input.value).toBe('500')
    await retype(input, '')
    await blur(input)
    await act(async () => { saveButton(container).click() })
    expect(useSopStore.getState().postTemplates['prod-1'][0]?.maxFileKb).toBeNull()
  })

  it('只收数字，字母点号会被过滤', async () => {
    const container = render()
    const input = sizeLimitInput(container)
    await retype(input, '2a0.5')
    expect(input.value).toBe('205')
  })
})
