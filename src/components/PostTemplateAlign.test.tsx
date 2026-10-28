// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPostTemplate, type PostTemplate } from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'
import PostTemplateModal from './PostTemplateModal'

/**
 * 后处理模板编辑器里的对齐与间距：
 * 之前 align 只有代码字段、行距写死 1.35，界面上根本调不了。
 * 这里盯住「左中右」「居中到画布」「行距」「字间距」四个入口别退化。
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

const template = (): PostTemplate => ({ ...createPostTemplate(2048, 2048, '方图'), enabled: true })

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
  window.localStorage.clear()
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

/** 选中第一层（主标题） */
function selectFirstLayer(container: HTMLElement) {
  const row = [...container.querySelectorAll('[title="删除这个图层"]')][0]!.parentElement as HTMLElement
  act(() => {
    row.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 弹窗是本地草稿、点保存才落盘，这里点一下保存再读 store */
function saveThenRead(container: HTMLElement) {
  act(() => { buttonByText(container, '保存').click() })
  return useSopStore.getState().postTemplates['prod-1']![0]!.elements[0]!
}

/** 预览里那个主标题文字层（带 textAlign 的那层） */
function previewText(container: HTMLElement) {
  return [...container.querySelectorAll('div')]
    .find((el) => (el as HTMLElement).style.textAlign === 'center' && el.textContent?.includes('主标题'))
    ?? [...container.querySelectorAll('div')]
      .find((el) => el.textContent?.includes('主标题') && (el as HTMLElement).style.whiteSpace === 'pre') as HTMLElement
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll('button')].find((btn) => btn.textContent?.trim() === text) as HTMLButtonElement
}

function setRange(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 按标签文字找那一行的滑杆：label 里包含「行距」「字间距」 */
function rangeByLabel(container: HTMLElement, label: string) {
  const holder = [...container.querySelectorAll('label')]
    .find((item) => item.textContent?.trim().startsWith(label))!
  return holder.querySelector('input[type="range"]') as HTMLInputElement
}

describe('后处理模板的对齐与间距', () => {
  it('选左中右会写到元素上，预览按锚点位移', () => {
    const container = render()
    selectFirstLayer(container)
    expect(previewText(container).style.textAlign).toBe('left')
    expect(previewText(container).style.transform).toBe('')

    act(() => { buttonByText(container, '中').click() })
    // 画布上 x 是锚点：居中要往左展开半格，预览得跟着走
    expect(previewText(container).style.textAlign).toBe('center')
    expect(previewText(container).style.transform).toBe('translateX(-50%)')
    expect(saveThenRead(container).align).toBe('center')

    act(() => { buttonByText(container, '右').click() })
    expect(previewText(container).style.transform).toBe('translateX(-100%)')
  })

  it('「居中到画布」把 x 拉到 50% 并改成居中对齐', () => {
    const container = render()
    selectFirstLayer(container)
    act(() => { buttonByText(container, '居中到画布').click() })

    const text = previewText(container)
    expect(text.style.transform).toBe('translateX(-50%)')
    const wrapper = text.closest('div[style*="left"]') as HTMLElement
    expect(wrapper.style.left).toBe('50%')
    expect(saveThenRead(container).x).toBe(0.5)
  })

  it('行距可调，写进元素并在预览里生效', () => {
    const container = render()
    selectFirstLayer(container)
    const slider = rangeByLabel(container, '行距')
    act(() => { setRange(slider, '2.1') })
    expect(previewText(container).style.lineHeight).toBe('2.1')
    expect(saveThenRead(container).lineHeight).toBe(2.1)
  })

  it('字间距可调，写进元素并在预览里生效', () => {
    const container = render()
    selectFirstLayer(container)
    const slider = rangeByLabel(container, '字间距')
    act(() => { setRange(slider, '8') })
    // 预览按成品宽等比缩放，所以这里只校验有值、方向对
    expect(previewText(container).style.letterSpacing).toMatch(/px$/)
    expect(saveThenRead(container).letterSpacing).toBe(8)
  })
})
