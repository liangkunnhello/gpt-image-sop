// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPostTemplate, type PostTemplate } from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'
import PostTemplateModal from './PostTemplateModal'

/**
 * 成品尺寸的口径开关。
 *
 * 真实事故：模板上填着 1280×720，交付目录里却是 `…-2560x1440-梁坤` 的 18 张图。
 * 画布跟着 AI 原图走了，而 1280×720 才是投放平台收片的规格。
 * 现在默认「按模板尺寸」，要保留 2K 就在这里显式切到「跟随原图」。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
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
  ...createPostTemplate(1280, 720, '16:9'),
  enabled: true,
})

let root: ReturnType<typeof createRoot> | null = null

beforeEach(() => {
  useSopStore.setState({
    directions: [
      { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
      { id: 'prod-1', parentId: 'cat-1', name: '京东保', kind: 'product' },
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
    root!.render(<PostTemplateModal ownerId="prod-1" ownerName="京东保" onClose={() => {}} />)
  })
  return container
}

/** 「出图尺寸」那一行的下拉 */
function modeSelect(container: HTMLElement): HTMLSelectElement {
  const label = [...container.querySelectorAll('div')].find((node) => node.textContent === '出图尺寸')
  const select = label?.parentElement?.querySelector('select')
  if (!select) throw new Error('没找到「出图尺寸」下拉')
  return select as HTMLSelectElement
}

async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function save(container: HTMLElement) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === '保存')
  if (!button) throw new Error('没找到保存按钮')
  act(() => button.click())
}

describe('后处理模板的出图尺寸', () => {
  it('默认「按模板尺寸」，并且把尺寸写在选项里', () => {
    const container = render()
    const select = modeSelect(container)
    expect(select.value).toBe('template')
    expect(select.textContent).toContain('1280×720')
  })

  it('切成「跟随原图」后保存，模板记下 source', async () => {
    const container = render()
    await choose(modeSelect(container), 'source')
    expect(modeSelect(container).value).toBe('source')
    save(container)
    expect(useSopStore.getState().postTemplates['prod-1'][0].outputSizeMode).toBe('source')
  })

  it('改回「按模板尺寸」保存，字段回到 template（不是残留 source）', async () => {
    useSopStore.setState({
      postTemplates: { 'prod-1': [{ ...template(), outputSizeMode: 'source' }] },
    })
    const container = render()
    expect(modeSelect(container).value).toBe('source')
    await choose(modeSelect(container), 'template')
    save(container)
    expect(useSopStore.getState().postTemplates['prod-1'][0].outputSizeMode).toBe('template')
  })
})
