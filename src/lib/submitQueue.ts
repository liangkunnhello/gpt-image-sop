/**
 * 提交排队规则。
 *
 * 批量出图时一次可能跑几十条提示词、耗时几十分钟。以前批量进行中整个输入区被锁死，
 * 想再发任务只能等或先停。现在改成排队：新提交先进队列，当前批跑完自动开始，
 * 既不打断正在跑的批，也不会让多批同时抢渠道并发。
 */

/** 队列最多排多少个提交，防止连点堆成几十批 */
export const MAX_PENDING_SUBMISSIONS = 20

export type SubmissionDisposition = 'run' | 'queue' | 'reject'

/**
 * 这次提交该立刻执行、排队、还是拒绝。
 *
 * `busy`：有一批正在跑，或上一次提交还在启动中（存图、遮罩校验那段 await）
 * `queued`：队列里已有多少个等待提交
 */
export function submissionDisposition({ busy, queued }: { busy: boolean; queued: number }): SubmissionDisposition {
  // 队列里有人的时候一律按先后排，不能插队，否则队列顺序会被新提交打乱
  if (!busy && queued === 0) return 'run'
  return queued >= MAX_PENDING_SUBMISSIONS ? 'reject' : 'queue'
}

/** 排队提示里的「前面还有几个提交」：正在跑的这批算一个，队列里的按顺序数 */
export function queuePositionLabel(queued: number): string {
  if (queued <= 0) return '当前批完成后自动开始'
  return `前面还有 ${queued} 个提交，当前批完成后依次自动开始`
}
