import { describe, expect, it } from 'vitest'

import { TaskGate } from './taskGate'

/**
 * 全局出图闸门。
 *
 * 这层的意义只有一个：同一时刻最多放 N 个请求出去，多出来的排队等。
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
