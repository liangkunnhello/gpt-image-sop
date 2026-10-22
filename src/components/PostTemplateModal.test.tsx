// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { NumberInput } from './PostTemplateModal'

/**
 * 尺寸输入框曾经有两个毛病，根因是同一个：onChange 里立刻把值夹到下限。
 * 输入「2」当场变成 64，接着敲就成了 645；同时每次按键都重建受控值，
 * 光标和选区被重置，数字没法长按框选。
 * 现在输入期间只存草稿，失焦或回车才提交。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function render(value: number, min: number, commits: number[] = []) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const draw = (next: number) => root!.render(
    <NumberInput
      value={next}
      min={min}
      onCommit={(committed) => {
        commits.push(committed)
        draw(committed)
      }}
    />,
  )
  // render 是异步生效的：要在 act 里等它挂完，否则拿到的 input 还是 null
  act(() => draw(value))
  const input = container.querySelector('input') as HTMLInputElement
  return { input, commits }
}

/** 模拟用户在框里全选后重新输入：和真人在已有数字上重打一遍的路径一致 */
async function retype(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('NumberInput（模板尺寸 / 字号 / 描边宽度共用）', () => {
  it('重打 1460 的过程中不会被改写成 64', async () => {
    const { input, commits } = render(840, 64)
    await retype(input, '1460')
    expect(input.value).toBe('1460')
    expect(commits).toEqual([])
  })

  it('只敲一位 2 不会自己变成 64', async () => {
    const { input, commits } = render(2560, 64)
    await retype(input, '2')
    expect(input.value).toBe('2')
    expect(commits).toEqual([])
  })

  it('输入期间不提交，选区不会被重置（能长按框选）', async () => {
    const { input } = render(840, 64)
    await retype(input, '123')
    input.setSelectionRange(0, 2)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(2)
  })

  it('失焦才提交合法值', async () => {
    const { input, commits } = render(840, 64)
    await retype(input, '1460')
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(commits).toEqual([1460])
  })

  it('提交低于下限的值夹到下限', async () => {
    const { input, commits } = render(840, 64)
    await retype(input, '10')
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(commits).toEqual([64])
  })

  it('删空后失焦回到原值，不写下限', async () => {
    const { input, commits } = render(1460, 64)
    await retype(input, '')
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(commits).toEqual([])
    expect(input.value).toBe('1460')
  })

  it('回车立即提交，不必等失焦', async () => {
    const { input, commits } = render(840, 64)
    await retype(input, '2000')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(commits).toEqual([2000])
  })

  it('只接受数字，字母被过滤掉', async () => {
    const { input, commits } = render(840, 64)
    await retype(input, '12a3')
    expect(input.value).toBe('123')
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(commits).toEqual([123])
  })
})
