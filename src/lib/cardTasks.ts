import type { TaskRecord } from '../types'
import { mergePromptText } from './sopGroup'

/**
 * 把同一张卡（同一 sopJobId）的多条任务摊平成一条，供详情页展示。
 *
 * 为什么要集中在这里：详情页是按「一张卡」展示的，但数据层是「一条提示词一条任务」，
 * 每条任务只存自己那几张图。凡是「按图打标记」的字段（回收站、人工改判）都必须一起合并 ——
 * 之前 outputImages 合并了、trashedOutputImages 没合并，结果就是
 * 「图移进回收站了，详情页照样显示」，只能靠清空回收站才消失。
 */
export function mergeCardTasks(group: TaskRecord[]): TaskRecord {
  const leader = group[0]
  const anyRunning = group.some((item) => item.status === 'running')
  const allError = group.every((item) => item.status === 'error')
  const merged = mergePromptText(group.map((item) => item.prompt))
  const trashedOutputImages = group.flatMap((item) => item.trashedOutputImages ?? [])
  const qcVerdicts = Object.assign({}, ...group.map((item) => item.qcVerdicts ?? {}))

  return {
    ...leader,
    // 输入内容显示真正提交的提示词（内容相同的只留一份）
    prompt: merged.text || leader.prompt,
    outputImages: group.flatMap((item) => item.outputImages),
    // 原图也按同顺序摊平：否则「下载原图」永远只指向第一条提示词那张，
    // 后面的图会拿错源。老任务没有这个字段时补空串占位，保持下标对齐。
    sourceImages: group.flatMap((item) => item.outputImages.map((_, index) => item.sourceImages?.[index] || '')),
    transparentOriginalImages: group.flatMap((item) => (
      item.outputImages.map((_, index) => item.transparentOriginalImages?.[index] || '')
    )),
    // 回收站标记与人工改判同样按整卡合并，缺一个就会出现「标记了但没生效」
    trashedOutputImages: trashedOutputImages.length ? trashedOutputImages : undefined,
    qcVerdicts: Object.keys(qcVerdicts).length ? qcVerdicts : undefined,
    status: anyRunning ? 'running' : allError ? 'error' : 'done',
    elapsed: group.reduce((sum, item) => sum + (item.elapsed ?? 0), 0),
  }
}
