import { describe, expect, it, beforeEach } from 'vitest'
import { httpStats } from './httpStats'

/**
 * 网络层在途计数。
 *
 * 这个数用来回答「是不是真的 10 个请求同时跑」——闸门的 activeCount 只是
 * 「发出去的名额」，拿到名额还要读底图、拼请求体，请求可能还没发。
 * 所以计数必须严格 begin/end 配对，否则数字会只增不减。
 */
describe('在途请求计数', () => {
  beforeEach(() => httpStats.reset())

  it('begin / end 配对，峰值记最大值', () => {
    httpStats.begin()
    httpStats.begin()
    httpStats.begin()
    expect(httpStats.current).toBe(3)
    expect(httpStats.peakCount).toBe(3)

    httpStats.end()
    expect(httpStats.current).toBe(2)
    // 峰值不随当前值下降，直到全部结束
    expect(httpStats.peakCount).toBe(3)
  })

  it('全部结束（在途归零）时峰值清零，下一批重新量', () => {
    httpStats.begin()
    httpStats.begin()
    httpStats.end()
    httpStats.end()
    expect(httpStats.current).toBe(0)
    expect(httpStats.peakCount).toBe(0)
  })

  it('重复 end 不会把计数减成负数', () => {
    httpStats.begin()
    httpStats.end()
    httpStats.end()
    expect(httpStats.current).toBe(0)
  })

  it('失败单独计数，不影响在途', () => {
    httpStats.begin()
    httpStats.end(false)
    expect(httpStats.current).toBe(0)
    expect(httpStats.failedCount).toBe(1)
    expect(httpStats.completedCount).toBe(0)
  })
})
