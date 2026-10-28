import { afterEach, describe, expect, it } from 'vitest'
import { usePostReapplyProgress } from './postProgress'

afterEach(() => {
  usePostReapplyProgress.setState({ progress: null })
})

describe('再次后处理的进度 store', () => {
  it('begin 之后立刻有 0/0，界面能马上显示进度条', () => {
    usePostReapplyProgress.getState().begin('task-a')
    expect(usePostReapplyProgress.getState().progress).toEqual({ taskId: 'task-a', done: 0, total: 0 })
  })

  it('update 推进进度', () => {
    const store = usePostReapplyProgress.getState()
    store.begin('task-a')
    store.update('task-a', { done: 3, total: 50 })
    expect(usePostReapplyProgress.getState().progress).toEqual({ taskId: 'task-a', done: 3, total: 50 })
  })

  it('别的卡的迟到回调不会串到当前进度上', () => {
    const store = usePostReapplyProgress.getState()
    store.begin('task-a')
    store.update('task-a', { done: 1, total: 10 })
    store.update('task-b', { done: 99, total: 99 })
    expect(usePostReapplyProgress.getState().progress).toEqual({ taskId: 'task-a', done: 1, total: 10 })
  })

  it('还没 begin 时 update 不生效（不会凭空造出一条进度）', () => {
    usePostReapplyProgress.getState().update('task-a', { done: 1, total: 10 })
    expect(usePostReapplyProgress.getState().progress).toBeNull()
  })

  it('finish 清掉进度，且别的卡 finish 不会误清', () => {
    const store = usePostReapplyProgress.getState()
    store.begin('task-a')
    store.finish('task-b')
    expect(usePostReapplyProgress.getState().progress?.taskId).toBe('task-a')
    store.finish('task-a')
    expect(usePostReapplyProgress.getState().progress).toBeNull()
  })
})
