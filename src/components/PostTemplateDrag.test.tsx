// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPostTemplate, type PostTemplate } from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'
import PostTemplateModal from './PostTemplateModal'

/**
 * 拖动要跟 PS 一样：在元素任意位置按下都能拖，不用非得抓左上角那个小圆点。
 * 而且抓哪儿都不该「跳」一下 —— 位移按指针走了多少算，不把锚点吸到指针上。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  // jsdom 没有 ResizeObserver / 指针捕获，补上最小实现
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  // 画布尺寸必须稳定：drag 用 rect 换算相对位移，jsdom 默认全是 0
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
      { id: 'dir-1', parentId: 'prod-1', name: '月亮', kind: 'direction' },
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
  const text = container.querySelector('[title="拖动调整位置，双击编辑文字"]') as HTMLElement
  const stage = text.parentElement as HTMLElement
  return { container, text, stage }
}

function pointer(target: HTMLElement, type: string, clientX: number, clientY: number) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 }))
  })
}

describe('后处理模板拖动（PS 式：整块可拖）', () => {
  it('在文字中间按下也能拖动，不必抓左上角', () => {
    const { text, stage } = render()
    expect(text.style.left).toBe('6%')

    pointer(text, 'pointerdown', 100, 100)
    pointer(stage, 'pointermove', 150, 120)
    pointer(stage, 'pointerup', 150, 120)

    // 500px 画布上右移 50px = +10%，下移 20px = +4%
    expect(text.style.left).toBe('16%')
    expect(text.style.top).toBe('12%')
  })

  it('抓右下角拖动不会让元素跳到指针下面', () => {
    const { text, stage } = render()
    // 从元素远端按下，只移动 10px
    pointer(text, 'pointerdown', 400, 400)
    pointer(stage, 'pointermove', 410, 400)
    pointer(stage, 'pointerup', 410, 400)
    expect(text.style.left).toBe('8%')
  })

  it('只点一下不移动，位置不变（不会因为拖动逻辑而微移）', () => {
    const { text, stage } = render()
    pointer(text, 'pointerdown', 100, 100)
    pointer(stage, 'pointermove', 101, 100)
    pointer(stage, 'pointerup', 101, 100)
    expect(text.style.left).toBe('6%')
  })

  it('双击进入文字编辑，单击不进入', () => {
    const { container, text } = render()
    pointer(text, 'pointerdown', 100, 100)
    pointer(text, 'pointerup', 100, 100)
    expect(container.querySelector('[contenteditable="true"]')).toBeNull()

    act(() => {
      text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull()
  })
})
