import type { TaskRecord } from '../types'

/**
 * 重复度的比对范围。
 *
 * - card：只和同一张任务卡里的其它图比（看这张卡内部有没有撞车）
 * - direction：和同一「产品-方向」下的所有成品比（看这一批投放素材有没有重复）
 * - library：和本地向量库里的**全部历史图**比（跨批次、跨方向，看有没有跟老素材撞）
 *
 * 口径不同，同一张图算出来的重复度会不一样，所以算过的分数要带上口径标记，
 * 换了口径就重算，不能拿旧口径的数字冒充。
 */
export type DuplicateScope = 'card' | 'direction' | 'library'

export const DUPLICATE_SCOPE_LABEL: Record<DuplicateScope, string> = {
  card: '同一张任务卡',
  direction: '同产品-方向',
  library: '全部历史图',
}

/** 归一化：认不出来的值退回默认口径 */
export function toDuplicateScope(value: unknown): DuplicateScope {
  if (value === 'card') return 'card'
  if (value === 'library') return 'library'
  return 'direction'
}

/** 全库比对不靠 task 分组，走向量库；这两种口径需要挑 peers 任务 */
export function needsPeers(scope: DuplicateScope): boolean {
  return scope !== 'library'
}

/** 这张图属于哪个比对组：卡就看 sopJobId（没有就自己一组），方向看 sopDirectionId */
export function duplicateScopeKey(
  task: Pick<TaskRecord, 'id' | 'sopJobId' | 'sopDirectionId'>,
  scope: DuplicateScope,
): string {
  if (scope === 'card') return task.sopJobId ?? task.id
  return task.sopDirectionId ?? ''
}

/** 参与比对的任务：只要已完成、没进回收站的 */
function comparable(task: TaskRecord): boolean {
  return task.status === 'done' && !task.deletedAt && (task.outputImages?.length ?? 0) > 0
}

/** 按口径把任务分组（同一张卡 / 同一个方向），空方向归到 '' 这一组 */
export function groupTasksByScope(tasks: TaskRecord[], scope: DuplicateScope): Array<{ key: string; tasks: TaskRecord[] }> {
  const groups = new Map<string, TaskRecord[]>()
  for (const task of tasks) {
    if (!comparable(task)) continue
    const key = duplicateScopeKey(task, scope)
    const bucket = groups.get(key)
    if (bucket) bucket.push(task)
    else groups.set(key, [task])
  }
  return [...groups.entries()].map(([key, list]) => ({ key, tasks: list }))
}

/**
 * 某一张图该跟哪些任务比。
 *
 * 「同产品-方向」下如果只有自己一张卡，就退到全部成品 —— 否则重复度永远算不出来；
 * 「同一张任务卡」不退：这就是要看卡内部有没有撞车。
 */
export function peersForTask(
  tasks: TaskRecord[],
  task: Pick<TaskRecord, 'id' | 'sopJobId' | 'sopDirectionId'>,
  scope: DuplicateScope,
  limit = 12,
): TaskRecord[] {
  const key = duplicateScopeKey(task, scope)
  const sameGroup = tasks.filter((item) => comparable(item) && item.id !== task.id && duplicateScopeKey(item, scope) === key)
  if (sameGroup.length || scope === 'card') return sameGroup.slice(0, limit)
  return tasks.filter((item) => comparable(item) && item.id !== task.id).slice(0, limit)
}

/** 详情页/检查时要比的那一批任务（含自己），口径同 peersForTask */
export function scopeTasksFor(
  tasks: TaskRecord[],
  task: Pick<TaskRecord, 'id' | 'sopJobId' | 'sopDirectionId'>,
  scope: DuplicateScope,
): TaskRecord[] {
  const peers = peersForTask(tasks, task, scope)
  return [task as TaskRecord, ...peers]
}
