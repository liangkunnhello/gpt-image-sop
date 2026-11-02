/**
 * Agent 卡模式：在输入框里连着几轮对话出图，**所有轮次的图都落在同一张任务卡里**。
 *
 * 和侧边栏那个 agent 页不是一回事：
 * - 那边是独立对话页，每轮各自成卡，有自己的 conversation / round 数据结构；
 * - 这边就是画廊里的一张卡，靠 `sopJobId` 把多轮任务聚在一张卡上（普通模式拆请求也是这个机制）。
 *
 * 参考图的使用方式**不在这里写死**：程序只做一件事 —— 把这张卡上一版的图带进去；
 * 具体「拿它当底图改标题」还是「完全不参考」，由用户在对话里说、模型自己理解。
 */

import type { AgentCardTurn, ApiProfile, InputImage, TaskParams, TaskRecord } from '../types'
import { MAX_INPUT_IMAGES } from '../types'
import { chat } from './sopPipeline'
import { useStore, submitSopTasks } from '../store'
import { useSopStore } from './sopStore'
import { ensureImageCached } from './imageCache'

/** 一轮对话 + 这轮产出的任务，详情页与取底图都用它 */
export interface AgentTurnGroup {
  turn: AgentCardTurn
  tasks: TaskRecord[]
  /** 本轮的输出图 id（按任务顺序摊平） */
  outputImages: string[]
}

/** 生成一个卡 id。和 store 的 genId 同款，但带 agent- 前缀，排查时一眼能认出来 */
export function newAgentCardJobId(): string {
  return `agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把一张卡里的任务还原成轮次。
 *
 * 同一轮的每条任务都带同一份 agentTurn（见 submitSopTasks），按 index 去重即可；
 * 没有 agentTurn 的任务（理论上只可能是手工塞进同一 job 的）不参与，避免把别的东西算成一轮。
 */
export function groupAgentTurns(tasks: TaskRecord[]): AgentTurnGroup[] {
  const buckets = new Map<number, { turn: AgentCardTurn; tasks: TaskRecord[] }>()
  for (const task of tasks) {
    const turn = task.agentTurn
    if (!turn) continue
    const bucket = buckets.get(turn.index)
    if (bucket) bucket.tasks.push(task)
    else buckets.set(turn.index, { turn, tasks: [task] })
  }
  return [...buckets.values()]
    .sort((a, b) => a.turn.index - b.turn.index)
    .map((bucket) => {
      const sorted = [...bucket.tasks].sort((a, b) => (a.sopPromptIndex ?? 0) - (b.sopPromptIndex ?? 0))
      return {
        turn: bucket.turn,
        tasks: sorted,
        outputImages: sorted.flatMap((task) => task.outputImages),
      }
    })
}

/**
 * 这一轮要带进去的底图 = 这张卡**最近一轮**出的图。
 *
 * 只取最近一轮，不取全部：用户说「标题再大一点」时，参照物就是上一版；
 * 把几十张历史图全塞进去，模型反而不知道以哪张为准。
 * 上一轮一张都没出（全失败）就继续往前找，实在没有就是纯文生图。
 *
 * 张数受单请求输入图上限约束（MAX_INPUT_IMAGES），超出的部分丢弃 ——
 * 这是接口限制，不是「用法规定」，不值得为此挡住整轮。
 */
export async function loadLastTurnBaseImages(
  turns: AgentTurnGroup[],
  limit = MAX_INPUT_IMAGES,
): Promise<InputImage[]> {
  const cap = Math.max(1, Math.min(limit, MAX_INPUT_IMAGES))
  for (const group of [...turns].reverse()) {
    const ids = group.outputImages.slice(0, cap)
    if (!ids.length) continue
    const images: InputImage[] = []
    for (const id of ids) {
      const dataUrl = await ensureImageCached(id)
      if (dataUrl) images.push({ id, dataUrl })
    }
    // 图被清理掉就继续往前找一轮，而不是当成「这轮没有底图」
    if (images.length) return images
  }
  return []
}

/** 对话历史喂给模型的样式：只给「用户说了什么 / 你怎么理解的」，不给成品提示词，省上下文 */
export function formatTurnHistory(turns: AgentTurnGroup[], maxTurns = 6): string {
  const recent = turns.slice(-maxTurns)
  return recent
    .map((group) => {
      const lines = [`第 ${group.turn.index} 轮`, `用户：${group.turn.userText}`]
      if (group.turn.reply.trim()) lines.push(`你：${group.turn.reply.trim()}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * 系统提示词。
 *
 * 关键约束只有三条：
 * 1. 必须输出 JSON（出图链路要拿到结构化的一组提示词，不是一段聊天）；
 * 2. 带底图时写「怎么改」而不是重画（否则每轮都会把上一版的细节丢掉）；
 * 3. 用户这一轮的话优先级最高（和前面几轮的设定冲突时以这轮为准）。
 */
export function buildAgentTurnSystemPrompt(count: number): string {
  return [
    '你是设计助理。用户在输入框里连着几轮让你改同一版图，你要读懂这一轮想改什么，并写出可直接送进文生图模型的提示词。',
    '只输出一个 JSON 对象，不要围栏、不要解释、不要多余文字：',
    '{"reply": "一句话说明你的理解（30 字以内）", "prompts": ["提示词 1", "提示词 2"]}',
    `prompts 必须是 ${count} 条，每条都要完整、能独立出图：版式、场景、主体、色调、光线，以及图上应有的文字（用「」包裹）。`,
    '这一轮如果带了底图：写「在底图上怎么改、怎么加」，不要重复描述底图里已经确定的产品外形、包装文字、品牌标识。',
    '用户这一轮说的话优先级最高：与前面几轮的设定冲突时，以这一轮为准。',
    '多条之间要在构图或场景上有明显区别，不要只换一两个字。',
    'reply 用中文，只说这次改了什么，不要复述提示词。',
  ].join('\n')
}

export function buildAgentTurnUserMessage(input: {
  turns: AgentTurnGroup[]
  text: string
  count: number
  baseCount: number
  baseTurnIndex?: number
}): string {
  const blocks: string[] = []
  const history = formatTurnHistory(input.turns)
  if (history) blocks.push(`【这张卡已经聊过的轮次】\n${history}`)
  blocks.push(`【本轮要求】\n${input.text}`)
  blocks.push(
    input.baseCount > 0
      ? `【本轮底图】会带 ${input.baseCount} 张图，它们是${input.baseTurnIndex ? `第 ${input.baseTurnIndex} 轮` : '上一版'}的产出。怎么用由上面的要求决定。`
      : '【本轮底图】这次没有底图，从零开始画。',
  )
  blocks.push(`本轮要写 ${input.count} 条提示词。`)
  return blocks.join('\n\n')
}

/**
 * 解析模型返回。
 *
 * 模型不按格式来是常态（多写一句解释、包一层围栏），所以这里只认「里面有 JSON」，
 * 实在找不到就把整段当一条提示词 —— 至少能让这一轮出图，而不是整轮报错作废。
 */
export function parseAgentTurnResponse(text: string, count: number): { reply: string; prompts: string[] } {
  const trimmed = text.trim()
  if (!trimmed) return { reply: '', prompts: [] }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(body.slice(start, end + 1)) as { reply?: unknown; prompts?: unknown }
      const prompts = Array.isArray(data.prompts)
        ? data.prompts
          .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
          .map((item) => item.trim())
        : []
      if (prompts.length) {
        return {
          reply: typeof data.reply === 'string' ? data.reply.trim() : '',
          prompts: prompts.slice(0, Math.max(1, count)),
        }
      }
    } catch {
      // 落到下面的兜底
    }
  }
  return { reply: '', prompts: [trimmed] }
}

export interface AgentCardTurnInput {
  /** 用户这一轮说的话 */
  text: string
  /** 本轮出几张（跟工具栏「数量」走） */
  count: number
  /** 出图参数：入队那一刻定死，中途改参数不影响这一轮 */
  params: TaskParams
  profile: ApiProfile
  directionId?: string
}

export interface AgentCardTurnResult {
  jobId: string
  taskIds: string[]
  reply: string
  turnIndex: number
  promptCount: number
}

/**
 * 跑一轮：读这张卡的对话历史 → 让模型理解并写提示词 → 提交成任务（同一 jobId，所以还是同一张卡）。
 */
export async function runAgentCardTurn(input: AgentCardTurnInput): Promise<AgentCardTurnResult> {
  const text = input.text.trim()
  if (!text) throw new Error('先说一句你想怎么改')

  const sopState = useSopStore.getState()
  const jobId = sopState.agentCardJobId ?? newAgentCardJobId()
  const existing = useStore.getState().tasks
    .filter((task) => task.sopJobId === jobId && !task.deletedAt && !task.sopPlaceholder)
    .sort((a, b) => (a.sopPromptIndex ?? 0) - (b.sopPromptIndex ?? 0))
  const turns = groupAgentTurns(existing)
  const turnIndex = turns.length + 1
  const count = Math.max(1, Math.floor(input.count) || 1)

  const baseImages = await loadLastTurnBaseImages(turns)
  const lastTurnWithImages = [...turns].reverse().find((group) => group.outputImages.length > 0)
  const messages = [
    { role: 'system', content: buildAgentTurnSystemPrompt(count) },
    {
      role: 'user',
      content: buildAgentTurnUserMessage({
        turns,
        text,
        count,
        baseCount: baseImages.length,
        baseTurnIndex: baseImages.length ? lastTurnWithImages?.turn.index : undefined,
      }),
    },
  ]
  // 条数越多输出越长：按条数放大上限，别让最后几条被截断
  const raw = await chat(input.profile, messages, 240, Math.min(8000, 900 * count + 900), 0.7)
  const { reply, prompts } = parseAgentTurnResponse(raw, count)
  if (!prompts.length) throw new Error('模型没有返回可用的提示词')

  const taskIds = await submitSopTasks({
    sopJobId: jobId,
    sopName: existing[0]?.sopName || `Agent · ${text.slice(0, 16)}`,
    systemPromptName: 'Agent 对话',
    directionId: input.directionId,
    prompts,
    // 索引接着「最大编号」往后排，而不是按现有条数：
    // 中间有任务被删过的话，用条数会算出重复编号
    promptIndexOffset: existing.reduce((max, item) => Math.max(max, item.sopPromptIndex ?? 0), 0),
    params: { ...input.params, n: 1 },
    inputImagesPerPrompt: prompts.map(() => baseImages),
    // 只用来还原「复用配置」与详情页显示：输入框原文就是用户这一轮说的话
    inputSnapshot: {
      mode: 'sop',
      prompt: text,
      fixedImageIds: baseImages.map((img) => img.id),
      variableImageIds: [],
    },
    agentTurn: {
      index: turnIndex,
      userText: text,
      reply,
      promptCount: prompts.length,
      baseImageIds: baseImages.map((img) => img.id),
      createdAt: Date.now(),
    },
  })
  if (!taskIds.length) throw new Error('提交失败，没有生成任务')

  // 首轮才需要记下新卡 id；后续轮次沿用同一张卡
  if (!sopState.agentCardJobId) useSopStore.getState().setAgentCardJobId(jobId)

  return { jobId, taskIds, reply, turnIndex, promptCount: prompts.length }
}
