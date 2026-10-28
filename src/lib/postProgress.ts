import { create } from 'zustand'

export interface PostReapplyProgress {
  /** 正在重做的卡；换卡时旧进度作废 */
  taskId: string
  done: number
  total: number
}

interface PostReapplyProgressState {
  progress: PostReapplyProgress | null
  begin: (taskId: string) => void
  update: (taskId: string, progress: { done: number; total: number }) => void
  finish: (taskId: string) => void
}

/**
 * 「再次后处理」的进度单独放一个极小的 store，而不是详情页的本地 state。
 *
 * 详情页可能有几百张缩略图，任何一次重渲染都不便宜；进度是「一张一更新」，
 * 塞进详情页的 state 等于让那几百张图跟着刷新几百次 —— 实测几百张的卡跑后处理时
 * 直接把渲染进程拖到「页面未响应」。只有进度条组件订阅这里，详情页本身不受影响。
 */
export const usePostReapplyProgress = create<PostReapplyProgressState>()((set, get) => ({
  progress: null,
  begin: (taskId) => set({ progress: { taskId, done: 0, total: 0 } }),
  update: (taskId, next) => {
    const current = get().progress
    // 别的卡在跑、或者已经收尾了，迟到的回调直接丢
    if (!current || current.taskId !== taskId) return
    set({ progress: { taskId, done: next.done, total: next.total } })
  },
  finish: (taskId) => {
    const current = get().progress
    if (current && current.taskId !== taskId) return
    set({ progress: null })
  },
}))
