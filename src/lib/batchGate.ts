/**
 * 单批请求闸门：**一张任务卡 = 一份名额**，控制「这一批同时在跑多少条请求」。
 *
 * 为什么需要它（实测依据，v1.2.85 去掉限流之后的问题）：
 * - 一次提交 488 条，请求全部同时发出 → 经本地代理实测：
 *   170 条以上同时建连接开始被重置，200 条时约 40% 失败，报错就是
 *   「TLS 握手失败」「连接被服务器重置（10054）」；
 * - 每条出图请求要占住连接 3~7 分钟（数据库里 434 条成功任务，单条耗时中位约 420 秒），
 *   所以「同时占用连接数」会持续累积，不像短请求那样发完就散。
 *
 * 和 v1.2.84 之前那套的区别：
 * - 名额按批算，不是全局共用：同 `sopJobId` 算一批，单任务卡用它自己。
 *   全局共用会让「SOP 在跑时普通模式几乎不动」；
 * - 默认值取自实测上限的保守比例（见 DEFAULT_BATCH_CONCURRENCY），不是拍脑袋的 10；
 * - 只限制「在跑」，不改变「建卡」——卡片立刻出现，用户马上看到整批进度。
 *
 * 释放必须 try/finally 配对，漏一次就会永久少一个名额。
 */
import { create } from 'zustand'

/** 实测拐点 170~180，取 60 为默认：约为上限的 1/3，留足网络抖动的余量 */
export const DEFAULT_BATCH_CONCURRENCY = 60

/** 允许用户填的范围：1 到实测拐点，超过拐点没有意义（只会换来连接被重置） */
export const MAX_BATCH_CONCURRENCY = 180

export function normalizeBatchConcurrency(value: unknown) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_BATCH_CONCURRENCY
  return Math.min(MAX_BATCH_CONCURRENCY, Math.max(1, Math.floor(num)))
}

interface BatchGateState {
  /** 全局设置里的「本批最多同时发几个」，改设置时同步 */
  limit: number
  setLimit: (limit: number) => void
  /** 每批当前在跑的条数 */
  active: Map<string, number>
  /** 等名额的排队者 */
  waiters: Map<string, Array<() => void>>
}

const pending = new Map<string, number>()
const waiters = new Map<string, Array<() => void>>()
let currentLimit = DEFAULT_BATCH_CONCURRENCY
/** 订阅者：界面要显示「排队中」和进度，所以状态变化要能被监听到 */
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function subscribeBatchGate(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getBatchGateLimit() {
  return currentLimit
}

/** 某一批当前在跑的条数 */
export function getBatchActive(key: string) {
  return pending.get(key) ?? 0
}

/** 某一批当前在等名额的条数 */
export function getBatchWaiting(key: string) {
  return (waiters.get(key) ?? []).length
}

/**
 * 批的划分与画廊的卡片口径一致：有 sopJobId 就是同一张卡，
 * 单任务卡（没 jobId）用它自己的 id，保证「一张卡 = 一份名额」。
 */
export function batchKeyOf(task: { id: string; sopJobId?: string | null }) {
  return task.sopJobId || `single:${task.id}`
}

function drain(key: string) {
  const queue = waiters.get(key)
  if (!queue) return
  while (queue.length && (pending.get(key) ?? 0) < currentLimit) {
    const next = queue.shift()!
    pending.set(key, (pending.get(key) ?? 0) + 1)
    next()
  }
  if (!queue.length) waiters.delete(key)
  notify()
}

/**
 * 申请一个名额。拿到就直接返回，没有就挂起直到前面的释放。
 *
 * 返回的 release 必须调用一次且只调一次（用 try/finally）。
 */
export function acquireBatchSlot(key: string): Promise<() => void> {
  const release = () => {
    const left = Math.max(0, (pending.get(key) ?? 0) - 1)
    if (left === 0) pending.delete(key)
    else pending.set(key, left)
    drain(key)
    notify()
  }

  if ((pending.get(key) ?? 0) < currentLimit) {
    pending.set(key, (pending.get(key) ?? 0) + 1)
    notify()
    return Promise.resolve(release)
  }
  notify()
  return new Promise((resolve) => {
    const queue = waiters.get(key) ?? []
    queue.push(() => resolve(release))
    waiters.set(key, queue)
    /**
     * 入队之后再抢一次名额。
     *
     * 上面那次 notify() 会同步通知订阅者，期间名额可能刚好被还回来、drain 也在那一刻跑完；
     * 而那时这个等待者还没进队列，等于被跳过一次。之后再没人唤醒它，
     * 任务就会永远停在 acquireBatchSlot 上 —— 状态一直是 running、不写库、也不报错。
     * 真实案例 mw1rsl4k1iw3xs：同一批 488 条都出了图，它卡了 40 分钟没动静。
     * 这里补一次 drain，把「刚好错过」的等待者立刻放行。
     */
    drain(key)
  })
}

/** 设置里的并发数变化时调用：调大立刻放行排队的那批 */
export function setBatchGateLimit(limit: number) {
  const next = normalizeBatchConcurrency(limit)
  if (next === currentLimit) return
  currentLimit = next
  for (const key of waiters.keys()) drain(key)
  notify()
}

/** 停止 / 删除整批时：把还排着队的全部放掉，避免卡死在等待里 */
export function cancelBatchWaiters(key: string) {
  const queue = waiters.get(key)
  if (!queue) return
  waiters.delete(key)
  for (const wake of queue) wake()
  notify()
}

/** 测试用：把计数清空，避免上一个用例残留 */
export function resetBatchGate() {
  pending.clear()
  waiters.clear()
  currentLimit = DEFAULT_BATCH_CONCURRENCY
}

/** 给界面用的订阅版状态（zustand，只在需要显示的地方读） */
export const useBatchGate = create<{ tick: number; bump: () => void }>((set) => ({
  tick: 0,
  bump: () => set((s) => ({ tick: s.tick + 1 })),
}))

subscribeBatchGate(() => useBatchGate.getState().bump())

export type { BatchGateState }
