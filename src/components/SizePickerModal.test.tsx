// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import SizePickerModal from './SizePickerModal'

/**
 * 渠道不支持的尺寸（短边 < 1024，例如 1K 档的 720×1280）原来直接灰掉。
 * 现在没有后处理时可以选：生成时用同比例的 1440×2560，出图后缩到 720×1280。
 * 有后处理时仍然灰掉，因为模板字号是按成品像素写死的。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

function render(props: { allowUpscale?: boolean; onSelect?: (size: string) => void } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const selected: string[] = []
  act(() => {
    root!.render(
      <SizePickerModal
        currentSize="1024x1024"
        onSelect={(size) => {
          selected.push(size)
          props.onSelect?.(size)
        }}
        onClose={() => {}}
        allowUpscale={props.allowUpscale}
      />,
    )
  })
  const buttons = [...container.querySelectorAll('button')]
  /** 比例格子：靠「比例文字 + 尺寸文字」两段一起认 */
  const ratioButton = (label: string) => buttons.find((btn) => btn.textContent?.includes(label))
  return { container, buttons, ratioButton, selected }
}

describe('SizePickerModal（不支持的尺寸也能选）', () => {
  it('没开后处理时，1K 的 9:16 可选，并标明要放大生成', () => {
    const { ratioButton } = render({ allowUpscale: true })
    const button = ratioButton('9:16')!
    expect(button).not.toBeUndefined()
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.textContent).toContain('↑720×1280')
  })

  it('有后处理时仍然灰掉，并说明不支持', () => {
    const { ratioButton } = render({ allowUpscale: false })
    const button = ratioButton('9:16')!
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.textContent).toContain('不支持')
  })

  it('选中后确定，带出去的是用户设的尺寸（不是生成用的那张大图）', () => {
    const { ratioButton, buttons, selected } = render({ allowUpscale: true })
    act(() => {
      ratioButton('9:16')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const confirm = buttons.find((btn) => btn.textContent?.trim() === '确定')!
    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(selected).toEqual(['720x1280'])
  })

  it('底部提示写清「按哪张尺寸生成、缩到哪个尺寸」', () => {
    const { ratioButton, container } = render({ allowUpscale: true })
    act(() => {
      ratioButton('9:16')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('渠道不支持 720×1280')
    expect(container.textContent).toContain('1440×2560')
  })
})
