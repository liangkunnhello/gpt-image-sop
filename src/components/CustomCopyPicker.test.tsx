// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useStore } from '../store'
import CustomCopyPicker from './CustomCopyPicker'

// 和项目里其它组件测试一致：告诉 React 当前处于测试环境，否则 act 会刷警告
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 「本次文案」入口：三件事要保证 ——
 * 能填、填了会显示摘要、清空后回到未填；且它改的是 store 里那一栏，不是输入框。
 */

let root: ReturnType<typeof createRoot> | null = null

beforeEach(() => {
  useStore.setState({ customCopy: '', prompt: '' })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<CustomCopyPicker />)
  })
  return container
}

/** 点击带指定文本的按钮 */
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find((node) => (node.textContent ?? '').includes(text))
  expect(button, `找不到按钮：${text}`).toBeTruthy()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 往 textarea 里输入（受控组件要走原生 setter 才会触发 React 的 onChange） */
async function type(container: HTMLElement, text: string) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
  expect(textarea).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(textarea, text)
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('本次文案入口', () => {
  it('默认显示「未填」，点开才有输入区', async () => {
    const container = await render()
    expect(container.textContent).toContain('未填')
    expect(container.querySelector('textarea')).toBeNull()

    await click(container, '本次文案')
    expect(container.querySelector('textarea')).toBeTruthy()
  })

  it('输入内容写进 store，不碰输入框提示词', async () => {
    useStore.setState({ prompt: '输入框里的提示词' })
    const container = await render()
    await click(container, '本次文案')
    await type(container, '赔付总限额600万')

    expect(useStore.getState().customCopy).toBe('赔付总限额600万')
    // 关键：这一栏和输入框提示词是两份东西
    expect(useStore.getState().prompt).toBe('输入框里的提示词')
  })

  it('填了之后按钮上显示摘要（多行压成一行）', async () => {
    useStore.setState({ customCopy: '第一句\n第二句' })
    const container = await render()
    expect(container.textContent).toContain('第一句 第二句')
    expect(container.textContent).not.toContain('未填')
  })

  it('清空按钮把这一栏清掉，按钮回到「未填」', async () => {
    useStore.setState({ customCopy: '写过的文案' })
    const container = await render()
    await click(container, '本次文案')
    await click(container, '清空')

    expect(useStore.getState().customCopy).toBe('')
    expect(container.textContent).toContain('未填')
  })

  it('内容为空时「清空」不可点（避免点了没反应）', async () => {
    const container = await render()
    await click(container, '本次文案')
    const clear = [...container.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === '清空')
    expect(clear?.disabled).toBe(true)
  })
})
