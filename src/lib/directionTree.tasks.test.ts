import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskRecord } from '../types'

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
  getAllTasks: vi.fn(async () => []),
  getAllImages: vi.fn(async () => []),
  getAllImageIds: vi.fn(async () => []),
}))

const { useStore } = await import('../store')
const { useSopStore } = await import('./sopStore')
const { trashNodeWithTasks, restoreTrashBatchWithTasks } = await import('./directionTree')

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

const reset = () => {
  useSopStore.setState({
    directions: [
      { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
      { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
      { id: 'dir-1', parentId: 'prod-1', name: '月亮', kind: 'direction' },
      { id: 'dir-2', parentId: 'prod-1', name: '图标', kind: 'direction' },
      { id: 'cat-2', parentId: null, name: 'APP', kind: 'category' },
    ],
    activeDirectionId: 'dir-1',
    activeFilterId: null,
  })
  useStore.setState({
    tasks: [
      makeTask('t1', { sopDirectionId: 'dir-1', sopJobId: 'job-a' }),
      makeTask('t2', { sopDirectionId: 'dir-1', sopJobId: 'job-a' }),
      makeTask('t3', { sopDirectionId: 'dir-2' }),
      makeTask('t4'),
    ],
    trashedTasks: [],
    selectedTaskIds: [],
  })
}

const taskIds = () => useStore.getState().tasks.map((task) => task.id).sort()
const trashedIds = () => useStore.getState().trashedTasks.map((task) => task.id).sort()

describe('删方向：任务卡跟着一起进回收站', () => {
  beforeEach(reset)

  it('归属该方向的任务卡被一起移入回收站，不是划为未归属', async () => {
    const { trashedCards } = await trashNodeWithTasks('dir-1')
    expect(taskIds()).toEqual(['t3', 't4'])
    expect(trashedIds()).toEqual(['t1', 't2'])
    // 两张任务卡属于同一张 SOP 卡
    expect(trashedCards).toBe(1)
  })

  it('其他方向和未归属的任务卡不受影响', async () => {
    await trashNodeWithTasks('dir-1')
    expect(useStore.getState().tasks.find((task) => task.id === 't3')?.sopDirectionId).toBe('dir-2')
    expect(useStore.getState().tasks.some((task) => task.id === 't4')).toBe(true)
  })

  it('节点和任务卡共用同一个回收站批次', async () => {
    const { batchId } = await trashNodeWithTasks('dir-1')
    const nodeBatch = useSopStore.getState().directions.find((node) => node.id === 'dir-1')?.trashBatchId
    const taskBatches = new Set(useStore.getState().trashedTasks.map((task) => task.trashBatchId))
    expect(nodeBatch).toBe(batchId)
    expect([...taskBatches]).toEqual([batchId])
  })

  it('删产品时，它下面所有方向的任务卡一起进回收站', async () => {
    await trashNodeWithTasks('prod-1')
    expect(trashedIds()).toEqual(['t1', 't2', 't3'])
    expect(taskIds()).toEqual(['t4'])
  })

  it('没有任务卡的方向也能正常删', async () => {
    useStore.setState({ tasks: [makeTask('only', { sopDirectionId: 'dir-1' })] })
    const { trashedCards } = await trashNodeWithTasks('dir-2')
    expect(trashedCards).toBe(0)
    expect(useSopStore.getState().directions.find((node) => node.id === 'dir-2')?.deletedAt).toBeTruthy()
  })

  it('进回收站的任务卡仍占着图片，不会被当孤儿图清掉', async () => {
    await trashNodeWithTasks('dir-1')
    const trashed = useStore.getState().trashedTasks
    expect(trashed.every((task) => task.outputImages.length > 0)).toBe(true)
  })
})

describe('恢复：节点和任务卡一起回来，归属原样保留', () => {
  beforeEach(reset)

  it('恢复后任务卡回到原来的方向下', async () => {
    const { batchId } = await trashNodeWithTasks('dir-1')
    await restoreTrashBatchWithTasks(batchId)

    expect(taskIds()).toEqual(['t1', 't2', 't3', 't4'])
    expect(trashedIds()).toEqual([])
    expect(useStore.getState().tasks.find((task) => task.id === 't1')?.sopDirectionId).toBe('dir-1')
    expect(useSopStore.getState().directions.find((node) => node.id === 'dir-1')?.deletedAt).toBeUndefined()
  })

  it('恢复后节点层级也回来了', async () => {
    const { batchId } = await trashNodeWithTasks('prod-1')
    await restoreTrashBatchWithTasks(batchId)
    const dir1 = useSopStore.getState().directions.find((node) => node.id === 'dir-1')
    expect(dir1?.parentId).toBe('prod-1')
    expect(useStore.getState().tasks.find((task) => task.id === 't3')?.sopDirectionId).toBe('dir-2')
  })

  it('恢复不会重复插入任务卡', async () => {
    const { batchId } = await trashNodeWithTasks('dir-1')
    await restoreTrashBatchWithTasks(batchId)
    await restoreTrashBatchWithTasks(batchId)
    expect(taskIds()).toEqual(['t1', 't2', 't3', 't4'])
  })
})
