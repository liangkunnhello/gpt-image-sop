import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskRecord } from '../types'

/**
 * 未读判定是纯函数，但同一份测试要顺带覆盖 store 里的「查看即已读」，
 * 这里沿用回收站测试的做法：把图片与数据库的最底层打桩。
 */
vi.mock('./idb', () => ({
  openDB: vi.fn(async () => ({
    transaction: () => ({ objectStore: () => ({ get: () => ({}) }), oncomplete: null, onerror: null, onabort: null }),
    objectStoreNames: { contains: () => false },
  })),
  dbTransaction: vi.fn(async (_mode: string, _stores: string[], run: (tx: unknown) => unknown) => run({
    objectStore: () => ({ get: () => ({ result: null, onsuccess: null, onerror: null }), put: () => ({}), delete: () => ({}) }),
    oncomplete: null,
    onerror: null,
    onabort: null,
  })),
  isDbBlocked: () => false,
  setDbBlockedHandler: () => {},
}))
vi.mock('./imageBlob', () => ({
  getStoredImageRecord: vi.fn(async () => undefined),
  putStoredImageRecord: vi.fn(async () => undefined),
  deleteStoredImageRecord: vi.fn(async () => undefined),
  deleteStoredThumbnail: vi.fn(async () => undefined),
}))
vi.mock('./db', async () => ({
  ...(await vi.importActual<typeof import('./db')>('./db')),
  putTask: vi.fn(async () => 'ok'),
  deleteTask: vi.fn(async () => undefined),
  commitTaskDeletion: vi.fn(async () => undefined),
  deleteImage: vi.fn(async () => undefined),
  getImage: vi.fn(async () => undefined),
  getImageMeta: vi.fn(async () => undefined),
  getStoredImageThumbnail: vi.fn(async () => undefined),
  deleteImageCacheEntry: vi.fn(),
  getAllTasks: vi.fn(async () => []),
  getAllImages: vi.fn(async () => []),
  getAllImageIds: vi.fn(async () => []),
}))

import { putTask } from './db'
import { useStore } from '../store'
import { groupSopTasks } from './sopGroup'
import { isAnyTaskUnread, isTaskUnread } from './unread'

const FINISHED_AT = 1_700_000_000_000

function makeTask(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: `提示词-${id}`,
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [`img-${id}`],
    status: 'done',
    error: null,
    createdAt: FINISHED_AT - 60_000,
    finishedAt: FINISHED_AT,
    elapsed: 60_000,
    ...patch,
  } as TaskRecord
}

describe('未读判定', () => {
  it('生成完成后没看过详情就是未读', () => {
    expect(isTaskUnread(makeTask('a'))).toBe(true)
  })

  it('看过详情后不再未读', () => {
    expect(isTaskUnread(makeTask('a', { detailViewedAt: FINISHED_AT + 1 }))).toBe(false)
  })

  it('生成过程中看过，结果回来后重新算未读', () => {
    // 打开详情时还在生成，finishedAt 比查看时间晚
    expect(isTaskUnread(makeTask('a', { detailViewedAt: FINISHED_AT - 30_000 }))).toBe(true)
  })

  it('重试完成后，之前看过的卡又变未读', () => {
    const task = makeTask('a', { detailViewedAt: FINISHED_AT + 1 })
    expect(isTaskUnread(task)).toBe(false)
    // 重试：完成时间往后走，查看时间留在原处
    expect(isTaskUnread({ ...task, finishedAt: FINISHED_AT + 120_000 })).toBe(true)
  })

  it('生成中 / 失败 / 没有产出图都不提示未读', () => {
    expect(isTaskUnread(makeTask('a', { status: 'running', finishedAt: null }))).toBe(false)
    expect(isTaskUnread(makeTask('a', { status: 'error' }))).toBe(false)
    expect(isTaskUnread(makeTask('a', { outputImages: [] }))).toBe(false)
  })

  it('反推 SOP 的占位卡不算未读', () => {
    expect(isTaskUnread(makeTask('a', { sopPlaceholder: true }))).toBe(false)
  })

  it('一卡多条任务时只要有一条没看过就算未读', () => {
    expect(isAnyTaskUnread([makeTask('a', { detailViewedAt: FINISHED_AT + 1 }), makeTask('b')])).toBe(true)
    expect(isAnyTaskUnread([makeTask('a', { detailViewedAt: FINISHED_AT + 1 })])).toBe(false)
  })
})

describe('未读跟随 SOP 卡聚合', () => {
  it('组里有一条没看过，代表卡就是未读', () => {
    const cards = groupSopTasks([
      makeTask('a', { sopJobId: 'job', sopPromptIndex: 1, detailViewedAt: FINISHED_AT + 1 }),
      makeTask('b', { sopJobId: 'job', sopPromptIndex: 2 }),
    ])
    expect(cards).toHaveLength(1)
    expect(isTaskUnread(cards[0]!)).toBe(true)
  })

  it('整组都看过就不算未读', () => {
    const cards = groupSopTasks([
      makeTask('a', { sopJobId: 'job', sopPromptIndex: 1, detailViewedAt: FINISHED_AT + 1 }),
      makeTask('b', { sopJobId: 'job', sopPromptIndex: 2, detailViewedAt: FINISHED_AT + 1 }),
    ])
    expect(isTaskUnread(cards[0]!)).toBe(false)
  })

  it('没有 SOP 的普通任务各自判断', () => {
    const cards = groupSopTasks([makeTask('a'), makeTask('b', { detailViewedAt: FINISHED_AT + 1 })])
    expect(cards.filter((task) => isTaskUnread(task)).map((task) => task.id)).toEqual(['a'])
  })
})

describe('首次启用前的历史任务不补红点', () => {
  it('完成时间早于基线就按已读处理', () => {
    const old = makeTask('old')
    expect(isTaskUnread(old, FINISHED_AT + 1)).toBe(false)
    expect(isTaskUnread(old, FINISHED_AT)).toBe(true)
  })

  it('基线之后完成、且没看过，才算未读', () => {
    expect(isTaskUnread(makeTask('new', { finishedAt: FINISHED_AT + 5_000 }), FINISHED_AT)).toBe(true)
  })
})

describe('打开详情后清未读', () => {
  beforeEach(() => {
    vi.mocked(putTask).mockClear()
    useStore.setState({
      tasks: [
        makeTask('a', { sopJobId: 'job-1', sopPromptIndex: 1, sopDirectionId: 'dir-1' }),
        makeTask('b', { sopJobId: 'job-1', sopPromptIndex: 2, sopDirectionId: 'dir-1' }),
        makeTask('c'),
      ],
    })
  })

  it('点开一张卡，同组任务一起标为已读', () => {
    useStore.getState().markTaskDetailViewed('a')
    const tasks = useStore.getState().tasks
    expect(tasks.find((task) => task.id === 'a')?.detailViewedAt).toBeTruthy()
    expect(tasks.find((task) => task.id === 'b')?.detailViewedAt).toBeTruthy()
    // 别的卡不受影响
    expect(isTaskUnread(tasks.find((task) => task.id === 'c')!)).toBe(true)
  })

  it('已读的卡再点一次不会重复写库', () => {
    useStore.getState().markTaskDetailViewed('a')
    expect(vi.mocked(putTask).mock.calls).toHaveLength(2)
    vi.mocked(putTask).mockClear()
    useStore.getState().markTaskDetailViewed('a')
    expect(vi.mocked(putTask).mock.calls).toHaveLength(0)
  })

  it('通过 setDetailTaskId 打开也算看过', () => {
    useStore.getState().setDetailTaskId('a')
    expect(isTaskUnread(useStore.getState().tasks.find((task) => task.id === 'a')!)).toBe(false)
  })
})
