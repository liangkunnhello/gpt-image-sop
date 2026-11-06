import type { ApiProvider, TaskParams, TaskRecord } from '../types'

type TaskLifecyclePatch = Pick<TaskRecord, 'status' | 'error' | 'finishedAt' | 'elapsed'>
type ActualParams = Partial<TaskParams>
type ImageSize = { width?: number; height?: number }

export function createTaskDonePatch(task: Pick<TaskRecord, 'createdAt' | 'startedAt'>, now: number): TaskLifecyclePatch {
  return {
    status: 'done',
    error: null,
    finishedAt: now,
    elapsed: now - (task.startedAt ?? task.createdAt),
  }
}

export function createTaskErrorPatch(task: Pick<TaskRecord, 'createdAt' | 'startedAt'>, error: string, now: number): TaskLifecyclePatch {
  return {
    status: 'error',
    error,
    finishedAt: now,
    elapsed: now - (task.startedAt ?? task.createdAt),
  }
}

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now: number) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    const isOpenAITask = (task.apiProvider ?? 'openai') !== 'fal'
    if (task.status !== 'running' || !isOpenAITask || task.customTaskId) return task

    const updated: TaskRecord = {
      ...task,
      ...createTaskErrorPatch(task, '请求中断', now),
      falRecoverable: false,
      elapsed: Math.max(0, now - (task.startedAt ?? task.createdAt)),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

export function hasActualParams(params: ActualParams | undefined): params is ActualParams {
  return Boolean(params && Object.keys(params).length > 0)
}

export function firstActualParams(paramsList: Array<ActualParams | undefined> | undefined): ActualParams | undefined {
  return paramsList?.find(hasActualParams)
}

export function mapActualParamsByImage(outputIds: string[], paramsList: Array<ActualParams | undefined> | undefined) {
  const mapped = paramsList?.reduce<Record<string, ActualParams>>((acc, params, index) => {
    const imgId = outputIds[index]
    if (imgId && hasActualParams(params)) acc[imgId] = params
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

export function hasActualSizeParam(params: ActualParams | undefined) {
  return Boolean(params?.size)
}

export function addImageSizeParam(params: ActualParams | undefined, size: ImageSize | undefined): ActualParams | undefined {
  if (hasActualSizeParam(params) || !size?.width || !size.height) return params
  return { ...(params ?? {}), size: `${size.width}x${size.height}` }
}

export function deriveAgentImageActualParams(params: ActualParams | undefined, size: ImageSize | undefined): ActualParams {
  return {
    ...(addImageSizeParam(hasActualParams(params) ? params : undefined, size) ?? {}),
    n: 1,
  }
}

export function deriveGalleryActualParams(
  provider: ApiProvider,
  isAsyncCustomTask: boolean,
  resultParams: ActualParams | undefined,
  paramsList: Array<ActualParams | undefined> | undefined,
  outputCount: number,
): ActualParams | undefined {
  if (provider === 'fal' || isAsyncCustomTask) return firstActualParams(paramsList)
  const firstParams = firstActualParams(paramsList)
  return {
    ...resultParams,
    size: resultParams?.size ?? firstParams?.size,
    n: outputCount,
  }
}

export function mapRevisedPromptsByImage(outputIds: string[], revisedPrompts: Array<string | undefined> | undefined) {
  const mapped = revisedPrompts?.reduce<Record<string, string>>((acc, prompt, index) => {
    const imgId = outputIds[index]
    if (imgId && prompt?.trim()) acc[imgId] = prompt
    return acc
  }, {})
  return mapped && Object.keys(mapped).length > 0 ? mapped : undefined
}

/**
 * 按请求的张数截断接口返回的图。
 *
 * 渠道偶尔不照 `n` 来：gpt-image-2 上实测过 n=1 却回 3 张。
 * 批量「数量 500」是 500 个请求、每个 n=1，多出来的图会让总数变成 518，
 * 而且它们就是同一条提示词的多次采样，彼此高度相似，看起来像「重复图」。
 * 所以按请求张数截断，用户设多少就是多少。
 *
 * 注意只截「多给的」，回得比请求少时原样返回（那是失败，交给上层报错/续跑）。
 */
export function trimOutputImages(images: string[], requested: number | undefined): string[] {
  const expected = Math.max(1, Math.floor(requested ?? 1))
  if (images.length <= expected) return images
  console.warn(`[出图] 渠道返回 ${images.length} 张，超过请求的 ${expected} 张，多余的已丢弃`)
  return images.slice(0, expected)
}

/**
 * 把进「图片回收站」的图从 outputImages 的渲染副本里排掉。
 *
 * 刻意不真的从 outputImages 里删元素：transparentOriginalImages、actualParamsByImage
 * 一类字段是按 outputImages 的下标对齐的，删元素会让这些映射整体错位。
 * 只在「展示 / 计数 / 下载 / 交付」这些按图逐张处理的场景用这个结果。
 * 传 undefined 的 trashedOutputImages 时原样返回，避免给老任务多分配数组。
 */
export function visibleOutputImages(task: Pick<TaskRecord, 'outputImages' | 'trashedOutputImages'>): string[] {
  const list = task.outputImages ?? []
  const trashed = task.trashedOutputImages
  if (!trashed?.length) return list
  const hidden = new Set(trashed)
  return list.filter((id) => !hidden.has(id))
}
