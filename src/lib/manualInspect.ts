import type { TaskRecord } from '../types'
import { expectForTask, expectFromPrompt } from './batchCheck'
import { inspectImages } from './clipSimilarity'
import { tasksOfCard } from './deliver'
import { duplicateScopeKey, needsPeers, peersForTask, type DuplicateScope } from './duplicateScope'
import { ensureImageCached } from './imageCache'
import { useInspectConfig } from './inspectConfig'
import { visibleOutputImages } from './taskState'

export interface ManualInspectResult {
  ok: boolean
  /** 实际送去检查的张数（读不出图的会被跳过） */
  checked: number
  error?: string
}

/**
 * 手动跑一次质检 + 重复度。
 *
 * 为什么抽出来：详情页的「重新检查」和任务卡上的「质检」是同一件事，
 * 各写一份必然走偏（这个项目已经因为「两处各写一遍」出过好几种不一致的 bug）。
 *
 * @param imageIds 只检查这几张（详情页多选时的批量检查）。
 *   不传 = 检查这张卡里所有还看得见的图。
 */
export async function inspectCard(options: {
  task: TaskRecord
  tasks: TaskRecord[]
  /** 重复度口径；不传就读设置里的当前口径 */
  scope?: DuplicateScope
  imageIds?: string[]
}): Promise<ManualInspectResult> {
  const { task, tasks } = options
  const scope = options.scope ?? useInspectConfig.getState().config.duplicateScope
  const group = tasksOfCard(tasks, task)

  /** 要检查的图：指定了就按指定的，否则整卡可见图（回收站里的不算） */
  const targetIds = options.imageIds?.length
    ? [...new Set(options.imageIds)]
    : group.flatMap((item) => visibleOutputImages(item))
  if (!targetIds.length) return { ok: false, checked: 0, error: '这张卡还没有可检查的图' }

  const entries: Array<{ imageId: string; dataUrl: string }> = []
  /** 已经在待检列表里的图：参照图不能和它重复，否则同一张会被送检两次 */
  const queued = new Set<string>()
  for (const id of targetIds) {
    const dataUrl = await ensureImageCached(id)
    if (!dataUrl) continue
    entries.push({ imageId: id, dataUrl })
    queued.add(id)
  }
  if (!entries.length) return { ok: false, checked: 0, error: '选中的图读不出来了（可能已被清理）' }

  /**
   * 只检查整卡时才带参照图。
   * 挑同方向的历史图一起送过去，重复度才有对照；指定了几张时按用户意图只看这几张，
   * 混进参照图反而会多出一批判定。
   */
  if (!options.imageIds?.length) {
    for (const peer of needsPeers(scope) ? peersForTask(tasks, task, scope, 12) : []) {
      for (const id of visibleOutputImages(peer).slice(0, 2)) {
        // 同卡其它任务的图本身就是目标图，跳过 —— 重复送检会白跑一次模型
        if (queued.has(id)) continue
        const dataUrl = await ensureImageCached(id)
        if (!dataUrl) continue
        entries.push({ imageId: id, dataUrl })
        queued.add(id)
      }
      if (entries.length >= 12) break
    }
  }

  try {
    await inspectImages(entries, {
      // 整卡检查时图来自多条提示词，没法用一份「应出现文案」对照，交给模型只判违规与压叠；
      // 单条任务时用 expectForTask，提示词里没有「」就退回任务上的卖点原文
      expect: group.length > 1 ? expectFromPrompt('') : expectForTask(task),
      manual: true,
      scope,
      group: duplicateScopeKey(task, scope),
    })
  } catch (err) {
    return {
      ok: false,
      checked: entries.length,
      error: err instanceof Error ? err.message : '未知原因',
    }
  }
  return { ok: true, checked: entries.length }
}
