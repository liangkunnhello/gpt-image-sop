/**
 * 渠道：同一业务-产品-方向下并行的一套投放口径。
 *
 * 和业务树是两套**互相独立**的筛选维度：
 * 业务树回答「这是什么业务」，渠道回答「投到哪个平台」。
 * 同一个方向下可以同时存在多个渠道的任务卡，筛选时两者取交集。
 *
 * 渠道目前是固定清单（按投放平台定的），不跟业务树一样能自由增删；
 * 需要扩展时直接在下面加一项即可，旧数据的 undefined 会落到「未指定」。
 */

export interface ChannelOption {
  /** 存进 TaskRecord.channel 的值，改了会导致旧数据对不上 */
  value: string
  label: string
}

export const CHANNELS: ChannelOption[] = [
  { value: 'ai-original', label: 'AI原图' },
  { value: 'gdt', label: '广点通' },
  { value: 'toutiao', label: '头条' },
  { value: 'baidu', label: '百度' },
  { value: 'vendor', label: '厂商' },
]

/** 筛选栏里额外需要的「未指定」，用于筛出还没归渠道的卡片 */
export const NO_CHANNEL = '__no_channel__'

/** 取值 → 展示名；未指定返回「未指定」 */
export function channelLabel(value: string | undefined | null): string {
  if (!value) return '未指定'
  return CHANNELS.find((item) => item.value === value)?.label ?? value
}

/** 判断任务是否命中渠道筛选；filter 为空或 'all' 表示不限 */
export function taskMatchesChannel(task: { channel?: string }, filter: string | null): boolean {
  if (!filter || filter === 'all') return true
  if (filter === NO_CHANNEL) return !task.channel
  return task.channel === filter
}

/**
 * 建卡时该继承的渠道。
 *
 * 与业务树同一个道理：点中哪个渠道，新卡就归到哪个渠道。
 * 但「全部」和「未指定」不是具体渠道，它们表示「不限」/「还没归渠道」，
 * 所以这两种情况一律不往新卡上写渠道 —— 否则在「未指定」视图下发送，
 * 新卡会突然带上一个用户没选过的渠道。
 *
 * 反过来，选了具体渠道却没写进新卡，卡片会被当前筛选立刻藏起来，
 * 看起来就像「发送了但没归属」，这也是这条继承存在的理由。
 */
export function channelForNewTask(filter: string | null | undefined): string | undefined {
  if (!filter || filter === 'all' || filter === NO_CHANNEL) return undefined
  return filter
}
