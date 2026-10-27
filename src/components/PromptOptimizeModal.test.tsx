// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiProfile } from '../types'
import PromptOptimizeModal from './PromptOptimizeModal'

/**
 * 优化提示词是「覆盖输入框」的操作，覆盖后没法撤销，
 * 所以这里盯住两点：改写结果先给用户看，点「应用并覆盖」才回写；失败时不给应用按钮。
 */

const optimizePrompt = vi.fn()

vi.mock('../lib/sopPipeline', () => ({
  chat: vi.fn(),
  shrinkToDataUrl: async (url: string) => url,
}))
vi.mock('../lib/promptOptimize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/promptOptimize')>()
  return { ...actual, optimizePrompt: (...args: unknown[]) => optimizePrompt(...args) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

const profile = { id: 'p1', provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example.com/v1' } as unknown as ApiProfile

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

beforeEach(() => {
  optimizePrompt.mockReset()
})

function render(props: { prompt?: string; images?: Array<{ id: string; dataUrl: string }> } = {}) {
  const onApply = vi.fn()
  const onClose = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <PromptOptimizeModal
        prompt={props.prompt ?? '参考@图1的排版设计和动作内容'}
        images={props.images ?? []}
        profile={profile}
        onApply={onApply}
        onClose={onClose}
      />,
    )
  })
  const buttons = () => [...container.querySelectorAll('button')]
  const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement
  return { container, onApply, onClose, buttons, textarea }
}

const findButton = (container: HTMLElement, label: string) => (
  [...container.querySelectorAll('button')].find((el) => el.textContent === label) as HTMLButtonElement | undefined
)

describe('优化提示词弹窗', () => {
  it('展示原提示词与快捷要求，点快捷项把要求拼进输入框', () => {
    const { container, textarea } = render()
    expect(container.textContent).toContain('参考@图1的排版设计和动作内容')
    expect(container.textContent).toContain('更具体')

    act(() => findButton(container, '更具体')!.click())
    expect(textarea().value).toContain('补上主体细节')
    // 再点一个就接着拼，不是覆盖
    act(() => findButton(container, '更简洁')!.click())
    expect(textarea().value).toContain('补上主体细节')
    expect(textarea().value).toContain('精简到只保留最关键的画面信息')
  })

  it('改写结果先展示，点「应用并覆盖输入框」才回写', async () => {
    optimizePrompt.mockResolvedValue('只参考@图1的排版设计与动作内容，其他按提示词进行')
    const { container, onApply, onClose } = render()

    await act(async () => {
      findButton(container, '开始优化')!.click()
    })

    // 结果已经出来，但还没写回输入框
    expect(container.textContent).toContain('优化后')
    expect(container.textContent).toContain('只参考@图1的排版设计与动作内容')
    expect(onApply).not.toHaveBeenCalled()

    act(() => findButton(container, '应用并覆盖输入框')!.click())
    expect(onApply).toHaveBeenCalledWith('只参考@图1的排版设计与动作内容，其他按提示词进行')
    expect(onClose).toHaveBeenCalled()
  })

  it('失败时只显示错误，不给应用按钮', async () => {
    optimizePrompt.mockRejectedValue(new Error('模型把图片引用弄丢了（@图1），请重试或换个要求'))
    const { container, onApply } = render()

    await act(async () => {
      findButton(container, '开始优化')!.click()
    })

    expect(container.textContent).toContain('模型把图片引用弄丢了')
    expect(findButton(container, '应用并覆盖输入框')).toBeUndefined()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('有参考图时默认带上，取消勾选就不传图', async () => {
    optimizePrompt.mockResolvedValue('优化后的画面描述')
    const { container } = render({ images: [{ id: 'i1', dataUrl: 'data:image/png;base64,AAA' }] })
    expect(container.textContent).toContain('带上 1 张参考图一起看')

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    act(() => {
      checkbox.click()
    })

    await act(async () => {
      findButton(container, '开始优化')!.click()
    })
    expect(optimizePrompt).toHaveBeenCalledTimes(1)
    expect(optimizePrompt.mock.calls[0][0]).toMatchObject({ imageDataUrls: [] })
  })
})
