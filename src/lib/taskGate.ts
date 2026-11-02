/**
 * 出图并发闸门：**按「一张卡 / 一批」限流**，不是全局共用一份名额。
 *
 * 为什么按批而不是全局：
 * 设置里的「同时在跑 N 个」说的是「一批里同时发多少个请求」。
 * 一次提交 500 张，是这一个批次内部按 10 个一批往下推；
 * 另外提交的一批（或者另一张 SOP 卡）属于另一批，不该来抢这 10 个名额。
 * 全局共用会造成「SOP 在跑的时候，普通模式那批几乎不动」——
 * 看着就像「一个个出」，而用户设置的是每批 10 个。
 *
 * 批的划分沿用画廊的卡片口径：有 `sopJobId` 就是同一批（SOP 分卡 / 变量 / 普通模式批量拆分共用它），
 * 单任务卡用它自己的 id。这样「一张卡 = 一份名额」，界面上也不会出现
 * 「卡上写着 10 个并发，实际只分到 3 个」的落差。
 *
 * 这里不改变「提交」：任务卡照旧立刻创建，用户马上能看到进度。
 * 它只决定「什么时候真去发请求」，某批超过上限就在这批里排队等名额。
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

  /** 这批已经跑完（没有在跑的、也没有排队的）：可以从表里摘掉 */
  get isIdle() {
    return this.active === 0 && this.waiters.length === 0
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

  /**
   * 清空计数与等待队列。**只给测试用**：
   * 用例里 mock 的请求永远不返回，active 会一直挂在那里，
   * 后面的用例就永远拿不到名额（表现为「一个请求都没发」）。
   */
  reset(): void {
    this.active = 0
    this.waiters = []
  }

  private drain() {
    while (this.active < this.limit && this.waiters.length) {
      // 名额直接转交给等待者：先加计数再唤醒，避免中间被人插队
      this.active += 1
      this.waiters.shift()?.()
    }
  }
}

/** 批 → 闸门。键与画廊的卡片口径一致，见 gateKeyOf */
const gates = new Map<string, TaskGate>()

/**
 * 这条任务属于哪一批。
 *
 * 有 `sopJobId` 就是同一批（SOP 分卡、变量模式、普通模式「数量 N」拆出的请求都共用一个），
 * 没有就按单任务卡自己算 —— 单任务卡本来就只有一个请求，给它独立名额最省事。
 */
export function gateKeyOf(task: { id: string; sopJobId?: string }): string {
  return task.sopJobId ?? `task:${task.id}`
}

export function gateFor(key: string): TaskGate {
  let gate = gates.get(key)
  if (!gate) {
    gate = new TaskGate()
    gates.set(key, gate)
  }
  return gate
}

/** 一批跑完就把闸门摘掉：否则 Map 会随提交次数一直长 */
export function releaseIdleGate(key: string) {
  const gate = gates.get(key)
  if (gate?.isIdle) gates.delete(key)
}

export interface GateTotals {
  /** 所有批加起来在跑几个 */
  active: number
  /** 所有批加起来还有几个在排队 */
  waiting: number
  /** 每批上限（取当前在跑批次里的最大值；都没设置时为 0） */
  perBatchLimit: number
  /** 现在有几批在跑 */
  batches: number
}

/** 给界面用的汇总：按批限流之后，光看单批的数字解释不了整体 */
export function gateTotals(): GateTotals {
  let active = 0
  let waiting = 0
  let perBatchLimit = 0
  let batches = 0
  for (const gate of gates.values()) {
    if (gate.isIdle) continue
    batches += 1
    active += gate.activeCount
    waiting += gate.waitingCount
    const limit = Number.isFinite(gate.limitCount) ? gate.limitCount : 0
    if (limit > perBatchLimit) perBatchLimit = limit
  }
  return { active, waiting, perBatchLimit, batches }
}

/** 仅测试用：清空所有批次的闸门 */
export function resetAllGates() {
  gates.clear()
}
