// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useSopStore } from '../lib/sopStore'
import SopSplitModal, { type SopRunOptions } from './SopSplitModal'

/**
 * 点「全部任务」会把归属清空（等于未归属）。
 * 这里锁定弹窗在这种状态下仍然可用：默认停在「未归属」，不是替用户挑第一个产品，
 * 而且能直接生成出方向为空的任务卡，出图后才会落到「未归属」里。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tree = [
  { id: 'cat-1', parentId: null, name: '保险', kind: 'category' as const },
  { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' as const },
  { id: 'dir-1', parentId: 'prod-1', name: '图标', kind: 'direction' as const },
  { id: 'dir-2', parentId: 'prod-1', name: '月亮', kind: 'direction' as const },
]

let root: ReturnType<typeof createRoot> | null = null

beforeEach(() => {
  useSopStore.setState({
    directions: tree,
    systemPrompts: [],
    variablePrompts: [],
    presets: [],
    lastPick: {},
    defaultPick: {},
    postTemplates: {},
    activeFilterId: null,
    activeDirectionId: '',
    ignoreCompliance: true,
    useImageSellingPoints: false,
    avoidCtaDesign: true,
    avoidOverlay: true,
    promptsPerGroup: 5,
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function render(imageCount = 0) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const results: SopRunOptions[] = []
  act(() => {
    root!.render(<SopSplitModal imageCount={imageCount} onClose={() => {}} onConfirm={(options) => results.push(options)} />)
  })
  const selects = () => [...container.querySelectorAll('select')] as HTMLSelectElement[]
  const startButton = () => [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('开始生成')) as HTMLButtonElement
  return { container, results, selects, startButton }
}

describe('SOP 生图弹窗的产品 / 方向', () => {
  it('归属为空时默认选「未归属」，不是第一个产品', () => {
    const { selects } = render()
    expect(selects()[0].value).toBe('')
    expect(selects()[0].selectedOptions[0].textContent).toBe('未归属')
    // 没有方向可选，第二个下拉是占位项
    expect(selects()[1].disabled).toBe(true)
  })

  it('未归属时可以直接生成，交出的方向是空', () => {
    const { results, startButton } = render()
    expect(startButton().disabled).toBe(false)
    act(() => startButton().click())
    expect(results).toHaveLength(1)
    expect(results[0].directionId).toBe('')
  })

  it('有归属时仍然默认带出那个方向', () => {
    useSopStore.setState({ activeDirectionId: 'dir-2' })
    const { selects, results, startButton } = render()
    expect(selects()[0].value).toBe('prod-1')
    expect(selects()[1].value).toBe('dir-2')
    act(() => startButton().click())
    expect(results[0].directionId).toBe('dir-2')
  })

  it('从「未归属」切回具体产品后，必须落到方向才能生成', () => {
    const { selects, startButton } = render()
    const productSelect = selects()[0]
    act(() => {
      productSelect.value = 'prod-1'
      productSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // 切产品会自动选上第一个方向
    expect(selects()[1].value).toBe('dir-1')
    expect(startButton().disabled).toBe(false)
  })
})
