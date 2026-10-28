// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import ReapplyProgressBar from './ReapplyProgressBar'
import { usePostReapplyProgress } from '../lib/postProgress'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  usePostReapplyProgress.setState({ progress: null })
})

function render() {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => { root!.render(<ReapplyProgressBar />) })
  return container
}

describe('后处理进度条', () => {
  it('没在跑的时候什么都不渲染', () => {
    const container = render()
    expect(container.textContent).toBe('')
  })

  it('刚点下去就显示 0/总数，不用等第一张做完', () => {
    const container = render()
    act(() => {
      usePostReapplyProgress.getState().begin('task-a')
      usePostReapplyProgress.getState().update('task-a', { done: 0, total: 512 })
    })
    expect(container.textContent).toContain('0/512')
    expect(container.textContent).toContain('0%')
  })

  it('随进度更新张数与百分比，进度条宽度跟着走', () => {
    const container = render()
    act(() => {
      usePostReapplyProgress.getState().begin('task-a')
      usePostReapplyProgress.getState().update('task-a', { done: 128, total: 512 })
    })
    expect(container.textContent).toContain('128/512')
    expect(container.textContent).toContain('25%')
    const bar = [...container.querySelectorAll('div')].find((el) => (el as HTMLElement).style.width)
    expect((bar as HTMLElement).style.width).toBe('25%')
  })

  it('收尾后进度条消失', () => {
    const container = render()
    act(() => {
      usePostReapplyProgress.getState().begin('task-a')
      usePostReapplyProgress.getState().finish('task-a')
    })
    expect(container.textContent).toBe('')
  })
})
