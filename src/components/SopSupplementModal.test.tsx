// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { useStore } from '../store'

// 两条去向各走一个函数：这里只关心点了哪个按钮走的是哪条，不真的去写提示词
const enqueueSopJobs = vi.fn<(jobs: unknown) => void>()
const supplementCardWithSop = vi.fn<(input: unknown) => Promise<string[]>>(async () => ['task-new'])
const rewriteSopText = vi.fn<(profile: unknown, original: string, instruction: string) => Promise<string>>(
  async () => '## 改后的 SOP\n\n- 主标题改成两行',
)
vi.mock('../lib/sopPipeline', () => ({
  enqueueSopJobs: (jobs: unknown) => enqueueSopJobs(jobs),
  supplementCardWithSop: (input: unknown) => supplementCardWithSop(input),
  rewriteSopText: (profile: unknown, original: string, instruction: string) => rewriteSopText(profile, original, instruction),
}))
vi.mock('../lib/imageCache', () => ({
  ensureImageCached: async () => 'data:image/png;base64,AAA',
}))

const { default: SopSupplementModal } = await import('./SopSupplementModal')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  enqueueSopJobs.mockReset()
  supplementCardWithSop.mockClear()
  rewriteSopText.mockClear()
})

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    prompt: '旧提示词',
    params: { ...DEFAULT_PARAMS, size: '1728x2304' },
    inputImageIds: ['img-1'],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    sopJobId: 'sop-1',
    sopName: '默认项目 SOP',
    sopText: '## SOP 正文',
    sopReferenceImageIds: ['img-1'],
    ...patch,
  }
}

function render(source: TaskRecord = task()) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const onClose = vi.fn()
  act(() => {
    root!.render(<SopSupplementModal task={source} existingCount={3} onClose={onClose} />)
  })
  return { container, onClose }
}

// 模式按钮里除了标题还有一行说明，textContent 是拼起来的，所以用 includes 找
const buttonWithText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text))

/** 取 mock 的第一次调用参数（两个 vi.fn 的签名不同，用结构类型统一） */
const firstArg = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0]?.[0]

describe('再次生成图片：补充 or 新建卡', () => {
  it('默认是「补充到这张卡」，走 supplementCardWithSop', async () => {
    const { container, onClose } = render()
    expect(container.textContent).toContain('补充到这张卡')

    act(() => buttonWithText(container, '开始补充')?.click())
    await act(async () => {})

    expect(supplementCardWithSop).toHaveBeenCalledTimes(1)
    expect(enqueueSopJobs).not.toHaveBeenCalled()
    expect(firstArg(supplementCardWithSop)).toMatchObject({ sopJobId: 'sop-1', existingCount: 3 })
    expect(onClose).toHaveBeenCalled()
  })

  it('选「新建一张卡」后走 enqueueSopJobs，沿用这张卡的 SOP 与参考图', async () => {
    const { container } = render()

    act(() => buttonWithText(container, '新建一张卡')?.click())
    expect(container.textContent).toContain('新建并生成')

    act(() => buttonWithText(container, '新建并生成')?.click())
    await act(async () => {})

    expect(supplementCardWithSop).not.toHaveBeenCalled()
    expect(enqueueSopJobs).toHaveBeenCalledTimes(1)
    const jobs = firstArg(enqueueSopJobs) as Array<Record<string, unknown>>
    expect(jobs[0]).toMatchObject({
      sopText: '## SOP 正文',
      imageDataUrls: ['data:image/png;base64,AAA'],
      imageIds: ['img-1'],
      promptsPerGroup: expect.any(Number),
    })
  })

  it('新建卡不需要原卡有 sopJobId，只要有 SOP 正文就能点', async () => {
    const { container } = render(task({ sopJobId: undefined }))

    // 「补充」在这种情况下本来就该禁用（没有卡可补）
    expect(buttonWithText(container, '开始补充')?.hasAttribute('disabled')).toBe(true)

    act(() => buttonWithText(container, '新建一张卡')?.click())
    act(() => buttonWithText(container, '新建并生成')?.click())
    await act(async () => {})

    expect(enqueueSopJobs).toHaveBeenCalledTimes(1)
  })

  it('没有 SOP 正文时两种方式都点不了', () => {
    const { container } = render(task({ sopText: '' }))
    expect(buttonWithText(container, '开始补充')?.hasAttribute('disabled')).toBe(true)
    act(() => buttonWithText(container, '新建一张卡')?.click())
    expect(buttonWithText(container, '新建并生成')?.hasAttribute('disabled')).toBe(true)
  })
})
/**
 * 新建卡也要把底图带过去。
 *
 * 不带的话新卡退回纯文生图，和原卡不是一套基底 ——
 * 用户点「新建一张卡」想的是「同样的图再生一版」。
 */
describe('新建卡带上原卡的底图', () => {
  const baseTask = () => task({
    inputImageIds: ['fixed-1', 'var-1'],
    variableFixedImageIds: ['fixed-1'],
    imageFidelity: 'product',
    inputSnapshot: {
      mode: 'sop',
      fixedImageIds: ['fixed-1'],
      variableImageIds: ['var-1'],
    },
  })

  it('固定图与变量图都传给新卡，保真档一起带', async () => {
    const { container } = render(baseTask())
    act(() => buttonWithText(container, '新建一张卡')?.click())
    act(() => buttonWithText(container, '新建并生成')?.click())
    await act(async () => {})

    const jobs = firstArg(enqueueSopJobs) as Array<Record<string, unknown>>
    expect((jobs[0].fixedImages as unknown[]).length).toBe(1)
    expect((jobs[0].variableImages as unknown[]).length).toBe(1)
    expect(jobs[0].imageFidelity).toBe('product')
  })

  it('弹窗里写明会带上几张底图', () => {
    const { container } = render(baseTask())
    act(() => buttonWithText(container, '新建一张卡')?.click())
    expect(container.textContent).toContain('底图一起带上：固定图 1 张 · 变量图 1 张')
  })

  it('没有底图的卡不显示这一行', () => {
    const { container } = render(task())
    expect(container.textContent).not.toContain('底图一起带上')
  })
})
/**
 * 「新建一张卡」可以先让 AI 改一版 SOP 再用。
 *
 * 关键点：改完必须真的用改后的那份去写提示词，而不是只是界面上改了一下；
 * 撤销要能退回原文；补充模式不提供这个入口（同一张卡里两份 SOP 会打架）。
 */
describe('新建卡时用 AI 改 SOP', () => {
  /** 受控 input 要手写 setter 再派发 input 事件，React 才认 */
  const typeInto = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const openNewCard = (container: HTMLElement) => {
    act(() => buttonWithText(container, '新建一张卡')?.click())
  }

  const reviseInput = (container: HTMLElement) =>
    [...container.querySelectorAll('input')].find((el) => el.placeholder.includes('主标题')) as HTMLInputElement

  beforeEach(() => {
    // getActiveApiProfile 读顶层 apiKey；没有 Key 会直接提示去设置，不会调模型
    useStore.setState({ settings: { ...useStore.getState().settings, apiKey: 'test-key' } })
  })

  it('只有「新建一张卡」才显示改写入口', () => {
    const { container } = render()
    expect(container.textContent).not.toContain('用 AI 改一版')
    openNewCard(container)
    expect(container.textContent).toContain('用 AI 改一版')
  })

  it('改写后新建用的是改后的 SOP', async () => {
    const { container } = render()
    openNewCard(container)
    act(() => typeInto(reviseInput(container), '主标题改成两行'))
    act(() => buttonWithText(container, '改一版')?.click())
    await act(async () => {})

    expect(rewriteSopText).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('已改过')

    act(() => buttonWithText(container, '新建并生成')?.click())
    await act(async () => {})
    const jobs = firstArg(enqueueSopJobs) as Array<Record<string, unknown>>
    expect(jobs[0].sopText).toBe('## 改后的 SOP\n\n- 主标题改成两行')
  })

  it('撤销后退回原文', async () => {
    const { container } = render()
    openNewCard(container)
    act(() => typeInto(reviseInput(container), '随便改'))
    act(() => buttonWithText(container, '改一版')?.click())
    await act(async () => {})

    act(() => buttonWithText(container, '撤销')?.click())
    act(() => buttonWithText(container, '新建并生成')?.click())
    await act(async () => {})
    const jobs = firstArg(enqueueSopJobs) as Array<Record<string, unknown>>
    expect(jobs[0].sopText).toBe('## SOP 正文')
  })
})
