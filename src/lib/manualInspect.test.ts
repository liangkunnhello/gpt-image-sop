import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'

// 只 mock 真正对外的东西：质检请求本身与取图；挑参照图、判可见图都用真实实现
const inspectImages = vi.fn()
vi.mock('./clipSimilarity', () => ({ inspectImages: (...args: unknown[]) => inspectImages(...args) }))

const ensureImageCached = vi.fn()
vi.mock('./imageCache', () => ({ ensureImageCached: (id: string) => ensureImageCached(id) }))

const configState = { config: { duplicateScope: 'direction' as 'card' | 'direction' | 'library' } }
vi.mock('./inspectConfig', () => ({
  useInspectConfig: {
    getState: () => configState,
    setState: (patch: { config: typeof configState.config }) => { configState.config = patch.config },
  },
}))

const { inspectCard } = await import('./manualInspect')

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: '主标题「赔付总限额600万」',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

/** 记下每次 inspectImages 收到的图 id */
function inspectedIds(): string[][] {
  return inspectImages.mock.calls.map((call) => (call[0] as Array<{ imageId: string }>).map((item) => item.imageId))
}

beforeEach(() => {
  inspectImages.mockReset()
  inspectImages.mockResolvedValue(undefined)
  ensureImageCached.mockReset()
  // 默认所有图都读得出来
  ensureImageCached.mockImplementation(async (id: string) => `data:${id}`)
  configState.config = { duplicateScope: 'direction' }
})

describe('手动质检：要检查哪些图', () => {
  it('不指定时检查整卡所有可见图', async () => {
    const t = task({ outputImages: ['a1', 'a2'], trashedOutputImages: ['a2'] })
    const result = await inspectCard({ task: t, tasks: [t] })
    expect(result.ok).toBe(true)
    // a2 在回收站里，不该送检
    expect(inspectedIds()[0]).toEqual(['a1'])
  })

  it('指定 imageIds 时只检查这几张（详情页多选批量用）', async () => {
    const t = task({ outputImages: ['a1', 'a2', 'a3'] })
    const result = await inspectCard({ task: t, tasks: [t], imageIds: ['a1', 'a3'] })
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(2)
    expect(inspectedIds()[0]).toEqual(['a1', 'a3'])
  })

  it('指定时重复 id 只送一次', async () => {
    const t = task({ outputImages: ['a1', 'a2'] })
    await inspectCard({ task: t, tasks: [t], imageIds: ['a1', 'a1'] })
    expect(inspectedIds()[0]).toEqual(['a1'])
  })

  it('整卡有多条任务时，把同卡其它任务的图也一起检', async () => {
    // SOP 卡：同一 sopJobId 的多条任务拼成一张卡
    const a = task({ id: 't1', sopJobId: 'job-1', outputImages: ['a1'] })
    const b = task({ id: 't2', sopJobId: 'job-1', outputImages: ['b1'] })
    await inspectCard({ task: a, tasks: [a, b] })
    expect(inspectedIds()[0].sort()).toEqual(['a1', 'b1'])
  })
})

describe('手动质检：参照图（决定重复度才有对照）', () => {
  it('整卡检查时会带上同方向的其它任务图', async () => {
    const mine = task({ id: 't1', sopDirectionId: 'dir-1', outputImages: ['a1'] })
    const peer = task({ id: 't2', sopDirectionId: 'dir-1', outputImages: ['p1', 'p2'] })
    await inspectCard({ task: mine, tasks: [mine, peer], scope: 'direction' })
    expect(inspectedIds()[0]).toContain('p1')
  })

  it('指定了 imageIds 时不带参照图（用户只想看这几张）', async () => {
    const mine = task({ id: 't1', sopDirectionId: 'dir-1', outputImages: ['a1'] })
    const peer = task({ id: 't2', sopDirectionId: 'dir-1', outputImages: ['p1'] })
    await inspectCard({ task: mine, tasks: [mine, peer], scope: 'direction', imageIds: ['a1'] })
    expect(inspectedIds()[0]).toEqual(['a1'])
  })

  it('全库口径不需要挑参照任务（参照来自本地向量库）', async () => {
    const mine = task({ id: 't1', sopDirectionId: 'dir-1', outputImages: ['a1'] })
    const peer = task({ id: 't2', sopDirectionId: 'dir-1', outputImages: ['p1'] })
    await inspectCard({ task: mine, tasks: [mine, peer], scope: 'library' })
    expect(inspectedIds()[0]).toEqual(['a1'])
  })
})

describe('手动质检：参数与失败处理', () => {
  it('不传 scope 时用设置里的当前口径', async () => {
    configState.config = { duplicateScope: 'library' }
    const t = task({ outputImages: ['a1'] })
    await inspectCard({ task: t, tasks: [t] })
    expect((inspectImages.mock.calls[0]![1] as { scope: string }).scope).toBe('library')
  })

  it('总是标记为手动（自动与手动的结论要能区分）', async () => {
    const t = task({ outputImages: ['a1'] })
    await inspectCard({ task: t, tasks: [t] })
    expect((inspectImages.mock.calls[0]![1] as { manual: boolean }).manual).toBe(true)
  })

  it('没有可检查的图时给明确错误，不发请求', async () => {
    const t = task({ outputImages: [] })
    const result = await inspectCard({ task: t, tasks: [t] })
    expect(result.ok).toBe(false)
    expect(result.checked).toBe(0)
    expect(result.error).toContain('还没有可检查的图')
    expect(inspectImages).not.toHaveBeenCalled()
  })

  it('图全都读不出来时给错误，不发请求', async () => {
    ensureImageCached.mockResolvedValue(null)
    const t = task({ outputImages: ['a1'] })
    const result = await inspectCard({ task: t, tasks: [t] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('读不出来')
    expect(inspectImages).not.toHaveBeenCalled()
  })

  it('质检抛错时把原因带回去（调用方据此提示）', async () => {
    inspectImages.mockRejectedValue(new Error('本地服务没启动'))
    const t = task({ outputImages: ['a1'] })
    const result = await inspectCard({ task: t, tasks: [t] })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('本地服务没启动')
  })

  it('单条任务用任务上的文案做对照（不是空期望）', async () => {
    const t = task({ outputImages: ['a1'], prompt: '主标题「赔付总限额600万」' })
    await inspectCard({ task: t, tasks: [t] })
    const expectText = (inspectImages.mock.calls[0]![1] as { expect: { mainTitle: string } }).expect
    expect(expectText.mainTitle).toBe('赔付总限额600万')
  })
})
