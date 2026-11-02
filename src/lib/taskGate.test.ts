import { beforeEach, describe, expect, it } from 'vitest'

import { TaskGate, gateFor, gateKeyOf, gateTotals, releaseIdleGate, resetAllGates } from './taskGate'

/**
 * 出图并发闸门（按「一批」限流）。
 *
 * 意义：**同一批**里同一时刻最多放 N 个请求出去，多出来的在这批里排队。
 * 不同批各自有 N 个名额，互不占 —— 设置里的「同时在跑 10 个」说的是每批 10 个。
 * 计数必须严格配对，漏一次释放就会永久少一个名额，所以这里把每种走向都盯住。
 */

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('TaskGate', () => {
  it('上限内直接拿到名额', async () => {
    const gate = new TaskGate()
    gate.setLimit(2)
    await gate.acquire()
    await gate.acquire()
    expect(gate.activeCount).toBe(2)
    expect(gate.waitingCount).toBe(0)
  })

  it('超过上限要排队，释放一个才放进一个', async () => {
    const gate = new TaskGate()
    gate.setLimit(1)
    await gate.acquire()

    let entered = false
    const waiting = gate.acquire().then(() => { entered = true })
    await tick()
    expect(entered).toBe(false)
    expect(gate.waitingCount).toBe(1)

    gate.release()
    await waiting
    expect(entered).toBe(true)
    expect(gate.activeCount).toBe(1)
  })

  it('调大上限会立刻把排队的那批放进来', async () => {
    const gate = new TaskGate()
    gate.setLimit(1)
    await gate.acquire()

    const order: number[] = []
    const p1 = gate.acquire().then(() => { order.push(1) })
    const p2 = gate.acquire().then(() => { order.push(2) })
    await tick()
    expect(order).toEqual([])

    gate.setLimit(3)
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
    expect(gate.activeCount).toBe(3)
  })

  it('关掉限制（null）时全部放行', async () => {
    const gate = new TaskGate()
    gate.setLimit(1)
    await gate.acquire()
    const waiting = gate.acquire()
    gate.setLimit(null)
    await waiting
    expect(gate.activeCount).toBe(2)
  })

  it('多释放几次不会把计数减成负数', () => {
    const gate = new TaskGate()
    gate.setLimit(1)
    gate.release()
    gate.release()
    expect(gate.activeCount).toBe(0)
  })
})

/**
 * 按批限流。
 *
 * 用户的原话：「限制 10 个是对于单任务卡，不是全局」——
 * 一次提交 500 张，是这张卡内部按 10 个往下推；另外提交的一批属于另一张卡，
 * 不该来抢这 10 个名额（全局共用会让两批互相拖，看着像「一个个出」）。
 */
describe('按批限流', () => {
  beforeEach(() => resetAllGates())

  it('同一批（同 sopJobId）共用一个闸门', () => {
    const a = gateKeyOf({ id: 't1', sopJobId: 'job-1' })
    const b = gateKeyOf({ id: 't2', sopJobId: 'job-1' })
    expect(a).toBe(b)
    expect(gateFor(a)).toBe(gateFor(b))
  })

  it('单任务卡各自成批：没有 sopJobId 就按自己的 id', () => {
    expect(gateKeyOf({ id: 't1' })).not.toBe(gateKeyOf({ id: 't2' }))
  })

  it('两批各有各的 10 个名额：一批排满不影响另一批', async () => {
    const first = gateFor('job-a')
    const second = gateFor('job-b')
    first.setLimit(2)
    second.setLimit(2)

    await first.acquire()
    await first.acquire()
    // 第一批满了
    expect(first.hasFreeSlot).toBe(false)

    // 第二批照样能拿满自己那两个，不会被第一批卡住
    await second.acquire()
    await second.acquire()
    expect(second.activeCount).toBe(2)
    expect(second.waitingCount).toBe(0)

    const totals = gateTotals()
    expect(totals.batches).toBe(2)
    expect(totals.active).toBe(4)
    expect(totals.perBatchLimit).toBe(2)
  })

  it('一批跑完（空转）时可以从表里摘掉，汇总也不再算它', async () => {
    const gate = gateFor('job-done')
    gate.setLimit(1)
    await gate.acquire()
    gate.release()
    releaseIdleGate('job-done')

    expect(gateTotals().batches).toBe(0)
    // 摘掉之后再取是同名但全新的闸门，计数干净
    expect(gateFor('job-done').activeCount).toBe(0)
  })

  it('还有等待者时不摘掉，否则排队的那批会永远卡住', async () => {
    const gate = gateFor('job-busy')
    gate.setLimit(1)
    await gate.acquire()
    const waiting = gate.acquire()
    releaseIdleGate('job-busy')
    expect(gateTotals().batches).toBe(1)

    gate.release()
    await waiting
    expect(gate.activeCount).toBe(1)
  })
})
