// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPostTemplate, type PostTemplate } from '../lib/postTemplate'
import { useSopStore } from '../lib/sopStore'
import PostTemplateModal from './PostTemplateModal'

/**
 * 图层列表原来是一行灰字 + 一个灰勾，「避让」和删除都很淡，
 * 看不出有几层、哪层选中、哪层写了什么。
 * 现在：标题栏带计数、每行有类型图标 / 名称 / 内容两行、选中带蓝条，
 * 「避让」做成小开关。这里盯住这些信息别在后续改版里丢掉。
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

function template(patch: Partial<PostTemplate> = {}): PostTemplate {
  return { ...createPostTemplate(2048, 2048, '方图'), enabled: true, ...patch }
}

let root: ReturnType<typeof createRoot> | null = null

function setTemplates(list: PostTemplate[]) {
  useSopStore.setState({
    directions: [
      { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
      { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
    ],
    postTemplates: { 'prod-1': list },
    postPreviewImages: {},
  })
}

beforeEach(() => setTemplates([template()]))

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
  /** 图层行靠删除按钮反查：每行恰好一个「删除这个图层」 */
  const rows = () => [...container.querySelectorAll('[title="删除这个图层"]')]
    .map((btn) => btn.parentElement as HTMLElement)
  return { container, rows }
}

describe('后处理模板图层列表', () => {
  it('标题栏显示图层数量', () => {
    const { container } = render()
    const header = [...container.querySelectorAll('span')]
      .find((el) => el.textContent?.replace(/\s/g, '') === '图层2')
    expect(header).not.toBeUndefined()
  })

  it('每行显示自定义名称与内容摘要', () => {
    const { rows } = render()
    const all = rows()
    expect(all).toHaveLength(2)
    // 默认模板的两层分别叫「主标题」「警示语」
    expect(all[0]!.textContent).toContain('主标题')
    expect(all[0]!.textContent).toContain('主标题留白')
    expect(all[1]!.textContent).toContain('警示语')
    expect(all[1]!.textContent).toContain('免赔额')
  })

  it('点某一行就选中它，右侧属性面板跟着切换', () => {
    const { container, rows } = render()
    const selectButton = rows()[1]!.querySelector('button')!
    act(() => {
      selectButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toContain('免赔额')
    expect(container.textContent).toContain('文字设置')
  })

  it('「避让」默认开，点一下就关', () => {
    const { rows } = render()
    const input = rows()[0]!.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(input.checked).toBe(true)
    act(() => input.click())
    expect(input.checked).toBe(false)
  })

  it('删除图标移掉这一层，数量同步变化', () => {
    const { container, rows } = render()
    act(() => {
      rows()[0]!.querySelector('[title="删除这个图层"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(rows()).toHaveLength(1)
    expect(container.querySelectorAll('[title="拖动调整位置，双击编辑文字"]')).toHaveLength(1)
    const header = [...container.querySelectorAll('span')]
      .find((el) => el.textContent?.replace(/\s/g, '') === '图层1')
    expect(header).not.toBeUndefined()
  })

  it('没有元素时给一句空态引导', () => {
    setTemplates([template({ elements: [] })])
    const { rows } = render()
    expect(rows()).toHaveLength(0)
    expect(document.body.textContent).toContain('还没有元素')
  })

  /**
   * 眼睛：隐藏 = 画布不显示 + 成品不叠这块（参数都留着，随时切回来）。
   * 所以副标题会变成「已隐藏」，画布上那一块也跟着消失。
   */
  it('眼睛可以隐藏图层，再点一下恢复', () => {
    const { container, rows } = render()
    const eye = () => rows()[0]!.querySelector('button[aria-label="隐藏图层"], button[aria-label="显示图层"]') as HTMLElement

    expect(container.textContent).toContain('主标题留白')

    act(() => eye().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(rows()[0]!.textContent).toContain('已隐藏')
    // 画布上不再渲染这一层，列表副标题也被「已隐藏」顶掉
    expect(container.textContent).not.toContain('主标题留白')

    act(() => eye().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(rows()[0]!.textContent).not.toContain('已隐藏')
    expect(container.textContent).toContain('主标题留白')
  })
})
