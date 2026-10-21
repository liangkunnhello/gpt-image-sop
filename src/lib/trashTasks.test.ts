import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskRecord } from '../types'

/**
 * 彻底删除那条路会一路走到 IndexedDB 清图，测试环境没有 indexedDB，
 * 这里把图片相关的最底层模块整体打桩，只为验证「回收站两个数组之间的搬移」。
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

import {
  purgeAllTrashTasks,
  purgeTrashTasks,
  restoreTrashTasks,
  trashTask,
  trashTasks,
  useStore,
} from '../store'
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

function makeTask(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    prompt: `提示词-${id}`,
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [`img-${id}`],
    status: 'done',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    ...patch,
  } as TaskRecord
}

const ids = () => useStore.getState().tasks.map((task) => task.id)
const trashIds = () => useStore.getState().trashedTasks.map((task) => task.id)

describe('任务卡进回收站', () => {
  beforeEach(() => {
    useStore.setState({
      tasks: [makeTask('a'), makeTask('b'), makeTask('c')],
      trashedTasks: [],
      selectedTaskIds: [],
    })
  })

  it('进回收站后从主列表移走，出现在回收站里', () => {
    void trashTasks(['a'])
    expect(ids()).toEqual(['b', 'c'])
    expect(trashIds()).toEqual(['a'])
  })

  it('同一批删除共用一个批次号，便于整批恢复', () => {
    void trashTasks(['a', 'b'])
    const batches = new Set(useStore.getState().trashedTasks.map((task) => task.trashBatchId))
    expect(batches.size).toBe(1)
  })

  it('进回收站的同时从选中集合里移除', () => {
    useStore.setState({ selectedTaskIds: ['a', 'b'] })
    void trashTasks(['a'])
    expect(useStore.getState().selectedTaskIds).toEqual(['b'])
  })

  it('同一 SOP 的整组任务一起进回收站', () => {
    useStore.setState({
      tasks: [makeTask('s1', { sopJobId: 'job' }), makeTask('s2', { sopJobId: 'job' }), makeTask('x')],
      trashedTasks: [],
    })
    void trashTasks([`s1`])
    expect(trashIds().sort()).toEqual(['s1', 's2'])
    expect(ids()).toEqual(['x'])
  })

  it('trashTask 单卡删除同样进回收站', () => {
    void trashTask(useStore.getState().tasks[0])
    expect(trashIds()).toEqual(['a'])
  })
})

describe('回收站恢复', () => {
  beforeEach(() => {
    useStore.setState({
      tasks: [makeTask('a')],
      trashedTasks: [],
      selectedTaskIds: [],
    })
  })

  it('恢复后回到主列表，标记被清掉', () => {
    void trashTasks(['a'])
    const batchId = useStore.getState().trashedTasks[0].trashBatchId as string
    void restoreTrashTasks(batchId)
    expect(ids()).toEqual(['a'])
    expect(trashIds()).toEqual([])
    expect(useStore.getState().tasks[0].deletedAt).toBeUndefined()
    expect(useStore.getState().tasks[0].trashBatchId).toBeUndefined()
  })

  it('只恢复指定批次，其他批次不受影响', async () => {
    useStore.setState({
      tasks: [makeTask('a'), makeTask('b')],
    })
    await trashTasks(['a'])
    const first = useStore.getState().trashedTasks[0].trashBatchId as string
    await trashTasks(['b'])
    // 第二次删除后 b 在最前面
    await restoreTrashTasks(first)
    expect(ids()).toEqual(['a'])
    expect(trashIds()).toEqual(['b'])
  })
})

describe('回收站彻底删除', () => {
  beforeEach(() => {
    useStore.setState({
      tasks: [makeTask('a'), makeTask('b')],
      trashedTasks: [],
      selectedTaskIds: [],
    })
  })

  it('按批次彻底删除后两边都没有了', async () => {
    await trashTasks(['a'])
    const batchId = useStore.getState().trashedTasks[0].trashBatchId as string
    await purgeTrashTasks(batchId)
    expect(ids()).toEqual(['b'])
    expect(trashIds()).toEqual([])
  })

  it('清空回收站把所有回收站任务一次删掉，主列表不动', async () => {
    await trashTasks(['a'])
    await purgeAllTrashTasks()
    expect(ids()).toEqual(['b'])
    expect(trashIds()).toEqual([])
  })

  it('回收站为空时清空是安全的', async () => {
    await purgeAllTrashTasks()
    expect(ids()).toEqual(['a', 'b'])
  })
})
