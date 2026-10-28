// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_INSPECT_CONFIG, useInspectConfig } from '../lib/inspectConfig'
import InspectConfigModal from './InspectConfigModal'

/**
 * 质检设置弹窗：自定义检查项要能加、能改、能删。
 * 规则本身的有效性在 visionQc.test.ts 里验，这里只验界面对配置的读写。
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<InspectConfigModal onClose={() => {}} />))
  // 弹窗用 createPortal 挂在 document.body 上，查询要对着 body 做
  return document.body
}

/** 受控 input 要改值再发 input 事件，React 才认 */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const rules = () => useInspectConfig.getState().config.customRules

describe('质检设置里的自定义检查项', () => {
  beforeEach(() => {
    localStorage.clear()
    useInspectConfig.setState({ config: DEFAULT_INSPECT_CONFIG })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.body.innerHTML = ''
    container = null
    root = null
  })

  it('点「+ 新增」加出一条空规则，能填规则名和判定标准', async () => {
    const el = render()
    const add = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('新增'))!
    await act(async () => { add.click() })
    expect(rules()).toHaveLength(1)

    const [nameInput, detailInput] = [...el.querySelectorAll('input[type="text"]')].slice(-2) as HTMLInputElement[]
    await act(async () => {
      type(nameInput, '不许出现按钮')
      type(detailInput, '出现空胶囊、圆角长条占位即不通过')
    })
    expect(rules()[0]).toMatchObject({
      name: '不许出现按钮',
      detail: '出现空胶囊、圆角长条占位即不通过',
      enabled: true,
    })
  })

  it('关掉开关后规则仍在，只是不生效', async () => {
    useInspectConfig.setState({
      config: { ...DEFAULT_INSPECT_CONFIG, customRules: [{ id: 'r1', name: '规则', detail: 'x', enabled: true }] },
    })
    const el = render()
    // 规则那一行的开关：从「规则名」输入框往上找同一行
    const nameInput = el.querySelector('input[placeholder^="规则名"]') as HTMLInputElement
    const sw = nameInput.parentElement?.querySelector('[role="switch"]') as HTMLElement
    await act(async () => { sw.click() })
    expect(rules()[0].enabled).toBe(false)
  })

  it('点「删除」把规则删掉', async () => {
    useInspectConfig.setState({
      config: { ...DEFAULT_INSPECT_CONFIG, customRules: [{ id: 'r1', name: '规则', detail: 'x', enabled: true }] },
    })
    const el = render()
    const del = [...el.querySelectorAll('button')].find((b) => b.textContent === '删除')!
    await act(async () => { del.click() })
    expect(rules()).toEqual([])
  })

  it('判定标准为空时提示这条不会生效', async () => {
    useInspectConfig.setState({
      config: { ...DEFAULT_INSPECT_CONFIG, customRules: [{ id: 'r1', name: '规则', detail: '', enabled: true }] },
    })
    const el = render()
    expect(el.textContent).toContain('判定标准为空，这条不会生效')
  })
})
