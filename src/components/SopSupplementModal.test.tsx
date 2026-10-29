// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_PARAMS, type TaskRecord } from '../types'

// 两条去向各走一个函数：这里只关心点了哪个按钮走的是哪条，不真的去写提示词
const enqueueSopJobs = vi.fn<(jobs: unknown) => void>()
const supplementCardWithSop = vi.fn<(input: unknown) => Promise<string[]>>(async () => ['task-new'])
vi.mock('../lib/sopPipeline', () => ({
  enqueueSopJobs: (jobs: unknown) => enqueueSopJobs(jobs),
  supplementCardWithSop: (input: unknown) => supplementCardWithSop(input),
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
