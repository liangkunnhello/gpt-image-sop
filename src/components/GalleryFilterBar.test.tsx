// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GalleryFilterBar from './GalleryFilterBar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function render(props: Partial<React.ComponentProps<typeof GalleryFilterBar>> = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const onChange = props.onChange ?? vi.fn()
  act(() => {
    root!.render(
      <GalleryFilterBar
        filter="all"
        counts={{ pass: 5, unsure: 2, fail: 3, dup: 4 }}
        total={12}
        limit={0.92}
        {...props}
        onChange={onChange}
      />,
    )
  })
  return { container, onChange }
}

const chipTexts = (container: HTMLElement) => [...container.querySelectorAll('button')].map((b) => b.textContent)

describe('详情页画廊筛选条', () => {
  it('按标签列出张数', () => {
    const { container } = render()
    expect(chipTexts(container)).toEqual(['全部12', '合格5', '待定2', '不合格3', '重复4'])
  })

  it('点某一档就把筛选条件交给上层', () => {
    const { container, onChange } = render()
    const fail = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('不合格'))!
    act(() => { fail.click() })
    expect(onChange).toHaveBeenCalledWith('fail')
  })

  it('当前档位高亮，其它不高亮', () => {
    const { container } = render({ filter: 'fail' })
    const fail = [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('不合格'))!
    expect(fail.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
  })

  it('张数为 0 的档位不显示，避免点了发现是空的', () => {
    const { container } = render({ counts: { pass: 0, unsure: 0, fail: 2, dup: 0 } })
    expect(chipTexts(container)).toEqual(['全部12', '不合格2'])
  })

  it('完全没有质检/重复度数据时整条不出现', () => {
    const { container } = render({ counts: { pass: 0, unsure: 0, fail: 0, dup: 0 } })
    expect(container.querySelector('button')).toBeNull()
  })
})
