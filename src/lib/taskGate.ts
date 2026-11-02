/**
 * 全局出图并发闸门。
 *
 * 为什么要有这一层：普通模式、SOP、变量、补充生图、断点继续，每条链路都有自己的
 * 并发提交逻辑。同时开两批就等于把并发数叠加 —— 设置里写着「并发 10」，
 * 实际可能有 20~30 个请求同时在飞，服务商限流、客户端卡顿都从这里来。
 *
 * 这里不改变「提交」：任务卡照旧立刻创建，用户马上能看到进度。
 * 它只决定「什么时候真去发请求」，超过上限就排队等名额。
 *
 * 计数必须 try/finally 配对，漏一次释放就会永久少一个名额。
 */
export class TaskGate {
  private active = 0
  /** Infinity 表示不限制（设置里关掉「限制并发数」时） */
  private limit = Number.POSITIVE_INFINITY
  private waiters: Array<() => void> = []

  /** 设置变化时更新上限；调大之后立刻把等着的那批放进来 */
  setLimit(limit: number | null | undefined) {
    const next = limit == null || !Number.isFinite(limit) || limit <= 0
      ? Number.POSITIVE_INFINITY
      : Math.floor(limit)
    if (next === this.limit) return
    this.limit = next
    this.drain()
  }

  /** 当前真正在跑的请求数，界面上可以拿来显示 */
  get activeCount() {
    return this.active
  }

  /** 并发上限（Infinity 表示不限制），界面用来解释「为什么在排队」 */
  get limitCount() {
    return this.limit
  }

  /** 现在申请名额会不会立刻拿到（false = 要排队） */
  get hasFreeSlot() {
    return this.active < this.limit
  }

  /** 已经拿到名额但还在等（说明上限被打满了） */
  get waitingCount() {
    return this.waiters.length
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  private drain() {
    while (this.active < this.limit && this.waiters.length) {
      // 名额直接转交给等待者：先加计数再唤醒，避免中间被人插队
      this.active += 1
      this.waiters.shift()?.()
    }
  }
}

export const taskGate = new TaskGate()
