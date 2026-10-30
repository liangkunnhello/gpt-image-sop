import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { isTauri } from './platform'
import { ensureImageCached } from './imageCache'
import { useSopStore } from './sopStore'
import { buildSkillMarkdown } from './mcpSkill'

/** 与 Rust 侧 mcp::bridge::INVOKE_EVENT 一致 */
const INVOKE_EVENT = 'mcp-invoke'

interface McpCall {
  id: string
  action: string
  args: Record<string, unknown>
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const num = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : []

/** 图库 id → InputImage（读不出就跳过，不让整次调用失败） */
async function loadImages(imageIds: string[]) {
  const out: Array<{ id: string; dataUrl: string }> = []
  for (const id of imageIds) {
    const dataUrl = await ensureImageCached(id)
    if (dataUrl) out.push({ id, dataUrl })
  }
  return out
}

/**
 * 等界面把任务卡建出来，拿到新增的 id。
 *
 * 提交本身是「建卡 + 后台跑」，出图要好几分钟；MCP 只需要拿到任务 id，
 * 进度和结果让调用方用 list_tasks 查，不能在这里干等出图。
 */
async function collectNewTasks(before: Set<string>, timeoutMs = 8000): Promise<string[]> {
  const { useStore } = await import('../store')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const added = useStore.getState().tasks.filter((task) => !before.has(task.id))
    if (added.length) return added.map((task) => task.id)
    if (Date.now() > deadline) return []
    await new Promise((resolve) => { setTimeout(resolve, 150) })
  }
}

/**
 * MCP 触发的界面操作。
 *
 * 这里刻意复用界面上那套入口（submitTask / enqueueSopJobs / retryTask …），
 * 而不是在 Rust 里另写一套：建卡、拼提示词、渠道校验、落库全都走得同一条路，
 * 用户事后在界面上能看到完整的流程，出了问题也能按界面的行为复盘。
 */
async function runAction(action: string, args: Record<string, unknown>): Promise<unknown> {
  const { useStore, submitTask, retryTask, stopTask, resumeInterruptedTasks } = await import('../store')
  const sop = useSopStore.getState()

  if (action === 'get_skill') return { markdown: buildSkillMarkdown() }

  if (action === 'retry_task') {
    const taskId = str(args.task_id)
    const task = useStore.getState().tasks.find((item) => item.id === taskId)
    if (!task) throw new Error(`找不到任务 ${taskId}`)
    await retryTask(task)
    return { retried: taskId }
  }

  if (action === 'stop_task') {
    const taskId = str(args.task_id)
    const stopped = await stopTask(taskId)
    return { stopped, taskId }
  }

  if (action === 'resume_tasks') {
    const count = await resumeInterruptedTasks()
    return { resumed: count }
  }

  const before = new Set(useStore.getState().tasks.map((task) => task.id))

  if (action === 'submit_plain') {
    const prompt = str(args.prompt)
    if (!prompt) throw new Error('prompt 不能为空')
    const images = await loadImages(ids(args.image_ids))
    const state = useStore.getState()
    const params = { ...state.params }
    const size = str(args.size)
    if (size) params.size = size
    params.n = num(args.count) ?? 1
    const directionId = str(args.direction_id)
    if (directionId) sop.setActiveDirection(directionId)
    useStore.setState({
      prompt,
      inputImages: images,
      fixedImages: [],
      params,
      customCopy: str(args.copy_text),
    })
    // 不 await：submitTask 会等到这批全部出图完成，MCP 侧等不起也不该等
    void submitTask()
    const taskIds = await collectNewTasks(before)
    return { taskIds, note: '任务已提交，出图结果用 list_tasks 查' }
  }

  if (action === 'submit_sop') {
    const savedSopId = str(args.saved_sop_id)
    const savedSop = savedSopId ? sop.savedSops.find((item) => item.id === savedSopId) : undefined
    if (savedSopId && !savedSop) throw new Error(`找不到 SOP ${savedSopId}`)
    const sopText = str(args.sop_text) || savedSop?.content || ''
    const systemPromptId = str(args.system_prompt_id)
    const systemPrompt = systemPromptId ? sop.systemPrompts.find((item) => item.id === systemPromptId) : undefined
    if (systemPromptId && !systemPrompt) throw new Error(`找不到系统提示词 ${systemPromptId}`)
    if (!sopText && !systemPrompt) throw new Error('要么给 saved_sop_id / sop_text，要么给 system_prompt_id')
    const pointId = str(args.point_preset_id)
    const point = pointId ? sop.presets.find((item) => item.id === pointId) : undefined
    if (pointId && !point) throw new Error(`找不到卖点 ${pointId}`)
    const images = await loadImages(ids(args.image_ids))
    const directionId = str(args.direction_id)
    if (directionId) sop.setActiveDirection(directionId)

    const { enqueueSopJobs } = await import('./sopPipeline')
    enqueueSopJobs([{
      label: savedSop?.name ?? 'MCP',
      // 参数按当前输入区来：和人工点发送时用的是同一份
      params: useStore.getState().params,
      imageDataUrls: images.map((item) => item.dataUrl),
      imageIds: images.map((item) => item.id),
      systemPromptText: systemPrompt?.content ?? '',
      systemPromptName: systemPrompt?.name,
      sopText: sopText || undefined,
      savedSopName: savedSop?.name,
      copyText: [str(args.copy_text), point?.content ?? ''].filter(Boolean).join('\n\n'),
      promptsPerGroup: num(args.prompts_per_group) ?? 1,
      directionId: directionId || undefined,
    }])
    const taskIds = await collectNewTasks(before)
    return { taskIds, note: 'SOP 批次已入队：先写提示词再逐条出图，进度用 list_tasks 查' }
  }

  if (action === 'submit_variable') {
    const promptId = str(args.variable_prompt_id)
    const savedPrompt = promptId ? sop.variablePrompts.find((item) => item.id === promptId) : undefined
    if (promptId && !savedPrompt) throw new Error(`找不到变量提示词 ${promptId}`)
    const variablePromptText = str(args.variable_prompt_text) || savedPrompt?.content || ''
    if (!variablePromptText.trim()) throw new Error('变量提示词为空')
    const images = await loadImages(ids(args.image_ids))
    const fixedImages = await loadImages(ids(args.fixed_image_ids))
    const variableImages = await loadImages(ids(args.variable_image_ids))
    const directionId = str(args.direction_id)
    if (directionId) sop.setActiveDirection(directionId)

    const { enqueueVariableJobs } = await import('./variablePipeline')
    enqueueVariableJobs([{
      label: savedPrompt?.name ?? 'MCP',
      params: useStore.getState().params,
      imageDataUrls: images.map((item) => item.dataUrl),
      imageIds: images.map((item) => item.id),
      variablePromptText,
      variablePromptName: savedPrompt?.name ?? 'MCP',
      copyText: str(args.copy_text),
      fillsPerCard: num(args.prompts_per_card) ?? 1,
      directionId: directionId || undefined,
      fixedImages,
      variableImages,
      // 没有参考图就只能直出（提取策略要看图）
      skipExtract: images.length === 0,
    }])
    const taskIds = await collectNewTasks(before)
    return { taskIds, note: '变量批次已入队：先提取策略再逐条填词出图，进度用 list_tasks 查' }
  }

  throw new Error(`未知动作：${action}`)
}

/** 挂上 MCP 指令监听，返回取消函数 */
export function startMcpBridge(): () => void {
  if (!isTauri) return () => {}

  const subscription = listen<McpCall>(INVOKE_EVENT, (event) => {
    const payload = event.payload
    if (!payload?.id) return
    void (async () => {
      try {
        const data = await runAction(payload.action, payload.args ?? {})
        await invoke('mcp_invoke_reply', { id: payload.id, ok: true, data })
      } catch (err) {
        await invoke('mcp_invoke_reply', {
          id: payload.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => {})
      }
    })()
  })

  return () => {
    void subscription.then((fn) => fn()).catch(() => {})
  }
}
