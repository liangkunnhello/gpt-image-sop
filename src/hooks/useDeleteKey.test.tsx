// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDeleteKey } from './useDeleteKey'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let roots: Array<ReturnType<typeof createRoot>> = []

/** 在独立组件里挂一次 hook，返回卸载函数 */
function mount(enabled: boolean, onDelete: () => void) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  function Probe() {
    useDeleteKey(enabled, onDelete)
    return null
  }
  act(() => { root.render(<Probe />) })
  return { unmount: () => act(() => root.unmount()) }
}

function press(key: string, target: HTMLElement = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true })
  Object.defineProperty(event, 'target', { value: target, configurable: true })
  act(() => { window.dispatchEvent(event) })
}

afterEach(() => {
  for (const root of roots) {
    try { act(() => root.unmount()) } catch { /* 已卸载 */ }
  }
  roots = []
  document.body.replaceChildren()
})

describe('Delete 键：把当前图移入回收站', () => {
  it('Delete 触发回调', () => {
    const onDelete = vi.fn()
    mount(true, onDelete)
    press('Delete')
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('Backspace 也算删除', () => {
    const onDelete = vi.fn()
    mount(true, onDelete)
    press('Backspace')
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('没启用时按了也不动', () => {
    const onDelete = vi.fn()
    mount(false, onDelete)
    press('Delete')
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('在输入框里按退格是删字，不是删图', () => {
    const onDelete = vi.fn()
    mount(true, onDelete)
    const input = document.createElement('input')
    document.body.append(input)
    press('Backspace', input)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('在文本框里同理', () => {
    const onDelete = vi.fn()
    mount(true, onDelete)
    const area = document.createElement('textarea')
    document.body.append(area)
    press('Delete', area)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('contentEditable（提示词输入区）里也不删图', () => {
    const onDelete = vi.fn()
    mount(true, onDelete)
    const div = document.createElement('div')
    div.contentEditable = 'true'
    // jsdom 不自动算 isContentEditable，手动补上
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true })
    document.body.append(div)
    press('Backspace', div)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('其他键不触发', () => {
    const onDelete = vi.fn()
    mount(true, onDelete)
    press('a')
    press('Escape')
    press('Enter')
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('只有栈顶那层响应：灯箱开着时详情页不会重复触发', () => {
    const detail = vi.fn()
    const lightbox = vi.fn()
    mount(true, detail)
    // 后注册的在栈顶（模拟灯箱盖在详情页之上）
    mount(true, lightbox)
    press('Delete')
    expect(lightbox).toHaveBeenCalledTimes(1)
    expect(detail).not.toHaveBeenCalled()
  })

  it('上层卸载后，下层重新接管（关掉灯箱还能继续删）', () => {
    const detail = vi.fn()
    const lightbox = vi.fn()
    mount(true, detail)
    const top = mount(true, lightbox)
    press('Delete')
    expect(lightbox).toHaveBeenCalledTimes(1)
    top.unmount()
    press('Delete')
    expect(detail).toHaveBeenCalledTimes(1)
  })

  it('卸载后不再响应', () => {
    const onDelete = vi.fn()
    const view = mount(true, onDelete)
    press('Delete')
    expect(onDelete).toHaveBeenCalledTimes(1)
    view.unmount()
    press('Delete')
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
