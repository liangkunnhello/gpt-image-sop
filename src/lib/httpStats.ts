/**
 * 网络层实测：**真正在途的 HTTP 请求数**。
 *
 * 为什么不复用 taskGate.activeCount：那只是「拿到并发名额的引擎条数」。
 * 拿到名额之后还要读底图、算尺寸、拼请求体、写库，请求可能还没发出去；
 * 反过来，请求发出去之后拿到响应头了但还在读 body，名额也没释放。
 * 所以「名额 10 个」不等于「10 个请求在飞」，用户对这一点有理由怀疑。
 *
 * 这里在真正调用 HTTP 的地方计数（platform.apiFetch），
 * 从「开始发」到「响应体读完 / 出错 / 取消」算一个在途，另有峰值。
 * 峰值 < 名额上限，就说明名额被非网络工作占着，或者请求压根没发出去。
 *
 * 纯内存、不持久化：它描述的是当下这一刻。
 */
class HttpStats {
  private inFlight = 0
  private peak = 0
  private completed = 0
  private failed = 0

  /** 当前在途请求数 */
  get current() {
    return this.inFlight
  }

  /** 本轮峰值（在途数归零时自动清零，避免显示上一批的旧峰值） */
  get peakCount() {
    return this.peak
  }

  get completedCount() {
    return this.completed
  }

  get failedCount() {
    return this.failed
  }

  begin(): void {
    this.inFlight += 1
    if (this.inFlight > this.peak) this.peak = this.inFlight
  }

  end(ok = true): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    if (ok) this.completed += 1
    else this.failed += 1
    // 全部结束就把峰值清掉：下一批重新量，不然「峰值」会一直是历史最高
    if (this.inFlight === 0) this.peak = 0
  }

  /** 仅测试用 */
  reset(): void {
    this.inFlight = 0
    this.peak = 0
    this.completed = 0
    this.failed = 0
  }
}

export const httpStats = new HttpStats()
