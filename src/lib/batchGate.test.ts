import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_CONCURRENCY,
  acquireBatchSlot,
  batchKeyOf,
  cancelBatchWaiters,
  getBatchActive,
  getBatchWaiting,
  normalizeBatchConcurrency,
  resetBatchGate,
  setBatchGateLimit,
} from './batchGate'

/**
 * 这道闸门是防止把接口压垮的关键：实测经本地代理 170~180 条连接同时建立就被重置。
 * 所以要锁住三件事：名额按批算、满了会等、释放后会放行排队者。
 */
describe('normalizeBatchConcurrency', () => {
  it('非法值退回默认，超过实测拐点按拐点封顶', () => {
    expect(normalizeBatchConcurrency(0)).toBe(DEFAULT_BATCH_CONCURRENCY)
    expect(normalizeBatchConcurrency(-3)).toBe(DEFAULT_BATCH_CONCURRENCY)
    expect(normalizeBatchConcurrency('abc')).toBe(DEFAULT_BATCH_CONCURRENCY)
    expect(normalizeBatchConcurrency(undefined)).toBe(DEFAULT_BATCH_CONCURRENCY)
    // 超过 180 没有意义：那里开始出现连接被重置
    expect(normalizeBatchConcurrency(9999)).toBe(MAX_BATCH_CONCURRENCY)
    expect(normalizeBatchConcurrency(15)).toBe(15)
    expect(normalizeBatchConcurrency('15')).toBe(15)
  })
})

describe('batchKeyOf', () => {
  it('同 sopJobId 是同一批，单任务卡各自成批', () => {
    expect(batchKeyOf({ id: 'a', sopJobId: 'job-1' })).toBe('job-1')
    expect(batchKeyOf({ id: 'b', sopJobId: 'job-1' })).toBe('job-1')
    // 没有 jobId 的单独一张卡，不能和别的卡共用名额
    expect(batchKeyOf({ id: 'x', sopJobId: null })).not.toBe(batchKeyOf({ id: 'y', sopJobId: null }))
  })
})

describe('acquireBatchSlot', () => {
  beforeEach(() => resetBatchGate())
  afterEach(() => resetBatchGate())

  it('没到上限时直接拿到名额，并计入该批在跑数', async () => {
    setBatchGateLimit(3)
    const r1 = await acquireBatchSlot('job-1')
    const r2 = await acquireBatchSlot('job-1')
    expect(getBatchActive('job-1')).toBe(2)
    r1()
    r2()
    expect(getBatchActive('job-1')).toBe(0)
  })

  it('到上限后要排队，释放一个才放行一个', async () => {
    setBatchGateLimit(2)
    const r1 = await acquireBatchSlot('job-1')
    const r2 = await acquireBatchSlot('job-1')
    let thirdGot = false
    const third = acquireBatchSlot('job-1').then((release) => {
      thirdGot = true
      return release
    })
    // 还没释放，第三个一定拿不到
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(thirdGot).toBe(false)
    expect(getBatchWaiting('job-1')).toBe(1)

    r1()
    const r3 = await third
    expect(thirdGot).toBe(true)
    r2()
    r3()
    expect(getBatchActive('job-1')).toBe(0)
  })

  it('名额按批算：一批占满不影响另一批', async () => {
    setBatchGateLimit(2)
    const a1 = await acquireBatchSlot('job-A')
    const a2 = await acquireBatchSlot('job-A')
    // B 批有自己的名额，不该被 A 批挡住
    const b1 = await acquireBatchSlot('job-B')
    expect(getBatchActive('job-B')).toBe(1)
    a1()
    a2()
    b1()
  })

  it('调大上限会立刻放行排队的那批', async () => {
    setBatchGateLimit(1)
    const r1 = await acquireBatchSlot('job-1')
    let secondGot = false
    const second = acquireBatchSlot('job-1').then((release) => {
      secondGot = true
      return release
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondGot).toBe(false)

    // 用户把并发数调大：排队的应该马上进来，不用等前一个释放
    setBatchGateLimit(4)
    const r2 = await second
    expect(secondGot).toBe(true)
    r1()
    r2()
  })

  it('停止整批时把排队者全部放掉，避免永久卡住', async () => {
    setBatchGateLimit(1)
    const r1 = await acquireBatchSlot('job-1')
    let woke = false
    const pending = acquireBatchSlot('job-1').then((release) => {
      woke = true
      return release
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    cancelBatchWaiters('job-1')
    await pending
    expect(woke).toBe(true)
    expect(getBatchWaiting('job-1')).toBe(0)
    r1()
  })

  it('重复释放不会把计数压成负数', async () => {
    setBatchGateLimit(5)
    const release = await acquireBatchSlot('job-1')
    release()
    release()
    expect(getBatchActive('job-1')).toBe(0)
  })
})
