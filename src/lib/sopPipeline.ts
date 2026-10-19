import type { ApiProfile } from '../types'
import { submitSopTasks, useStore } from '../store'
import { useSopStore } from './sopStore'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'

/** 生成 SOP 与提示词所用的文本模型 */
export const SOP_TEXT_MODEL = 'deepseek-v4.1-flash'

/** 送模型前统一缩到长边 1024，参考图再多也不会撑爆请求体 */
const MODEL_MAX_SIDE = 1024
/** 超过这个张数时进一步降到 768，优先保证请求能发出去 */
const MANY_IMAGE_THRESHOLD = 16

/** 浏览器端缩图，返回 jpeg data URL */
export function shrinkToDataUrl(dataUrl: string, max: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.86))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/** 一轮纯文本/多模态对话，返回助手消息正文 */
async function chat(profile: ApiProfile, messages: unknown[], timeoutSeconds = 240): Promise<string> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const url = buildApiUrl(profile.baseUrl, 'chat/completions', proxyConfig, useApiProxy)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  try {
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
      cache: 'no-store',
      body: JSON.stringify({
        model: SOP_TEXT_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 4000,
        stream: false,
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}：${await getApiErrorMessage(res)}`)
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = String(json.choices?.[0]?.message?.content ?? '').trim()
    if (!content) throw new Error('模型返回了空内容')
    return content
  } finally {
    clearTimeout(timer)
  }
}

/** 把列表尽量平均分成 groups 组，先分的组多分余数 */
export function splitEven<T>(items: T[], groups: number): T[][] {
  const size = Math.max(1, Math.min(groups, items.length || 1))
  const base = Math.floor(items.length / size)
  const extra = items.length % size
  const out: T[][] = []
  let cursor = 0
  for (let i = 0; i < size; i += 1) {
    const take = base + (i < extra ? 1 : 0)
    out.push(items.slice(cursor, cursor + take))
    cursor += take
  }
  return out
}

const SOP_SYSTEM = [
  '你是广告设计团队的资深生图指导。用户会给你若干张参考图，你要从这些图里反推出一套可复用的「生图 SOP」。',
  'SOP 要能被另一个模型直接照着写出多条提示词，所以必须具体、可执行：写清版式结构、画面元素、文字层级、配色倾向、镜头与光线、必须出现和必须避免的东西。',
  '只描述你从参考图里真实观察到的规律，不要编造参考图里没有的品牌、价格或功效。',
  '输出 Markdown，包含以下小节：## SOP 名称、## 适用场景、## 版式结构、## 画面元素、## 文字规范、## 配色与光线、## 必守与禁忌。',
  '不要输出任何解释性开场白。',
].join('\n')

/** 第一步：参考图 + 系统提示词 → 生图 SOP */
export async function generateSop(
  profile: ApiProfile,
  systemPrompt: string,
  imageDataUrls: string[],
): Promise<string> {
  const maxSide = imageDataUrls.length > MANY_IMAGE_THRESHOLD ? 768 : MODEL_MAX_SIDE
  const images = await Promise.all(imageDataUrls.map((url) => shrinkToDataUrl(url, maxSide)))
  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        '根据下面这些参考图，反推一套生图 SOP。',
        systemPrompt.trim() ? `\n【系统提示词】\n${systemPrompt.trim()}` : '',
        `\n共 ${images.length} 张参考图，请提炼它们的共同规律。`,
      ].join('\n'),
    },
  ]
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })

  return chat(profile, [
    { role: 'system', content: SOP_SYSTEM },
    { role: 'user', content },
  ])
}

const PROMPT_SYSTEM = [
  '你是广告生图提示词工程师。用户会给你一份生图 SOP，你要严格按这份 SOP 写出指定数量的具体提示词。',
  '每条提示词必须能独立送进文生图模型，包含完整的画面描述：版式、场景、人物、色调、光线、以及图上应有的全部文字（用「」包裹）。',
  '多条之间要在场景、机位、人物、色调上做出区分，不能只是换几个词。',
  '只输出编号列表，一行一条，不要任何解释、不要小标题、不要代码块。',
].join('\n')

/** 第二步：SOP → 多条具体提示词 */
export async function generatePrompts(
  profile: ApiProfile,
  sopText: string,
  count: number,
): Promise<string[]> {
  const raw = await chat(profile, [
    { role: 'system', content: PROMPT_SYSTEM },
    {
      role: 'user',
      content: `【生图 SOP】\n${sopText.trim()}\n\n按这份 SOP 写 ${count} 条提示词，每条之间在场景和构图上要有明显区别。`,
    },
  ])
  return parseNumberedList(raw)
}

/** 解析编号列表；解析不到编号时退回按空行切分 */
export function parseNumberedList(text: string): string[] {
  const body = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
  const numbered: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s*[.、)．]\s*(.+)$/)
    if (match) numbered.push(match[1].trim())
  }
  if (numbered.length) return numbered.filter(Boolean)
  return body.split(/\r?\n\s*\r?\n/).map((item) => item.trim()).filter(Boolean)
}

/** SOP 标题取「## SOP 名称」那一行，取不到就用方向名兜底 */
export function sopTitleOf(sopText: string, fallback: string): string {
  const match = sopText.match(/##\s*SOP\s*名称\s*\n+\s*(.+)/)
  return match ? match[1].trim().slice(0, 40) : fallback
}

// ===== 后台队列：点击后立即返回，界面不锁 =====

export interface SopJobRequest {
  label: string
  imageDataUrls: string[]
  systemPromptText: string
  promptsPerGroup: number
  directionId?: string
}

/** 同时在跑的任务卡数量 */
const QUEUE_LIMIT = 10

const queue: SopJobRequest[] = []
let runningCount = 0
let totalCount = 0
let doneCount = 0

function refreshProgress(label: string) {
  useSopStore.getState().setProgress({
    queued: queue.length,
    running: runningCount,
    done: doneCount,
    total: totalCount,
    label,
  })
}

async function runJob(job: SopJobRequest) {
  const state = useStore.getState()
  const settings = state.settings
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  if (!profile) throw new Error('没有可用的接口配置')

  const sop = await generateSop(profile, job.systemPromptText, job.imageDataUrls)
  const prompts = await generatePrompts(profile, sop, job.promptsPerGroup)
  if (!prompts.length) throw new Error(`${job.label} 没有得到提示词`)

  // 出图任务由 submitSopTasks 内部再限并发，这里不等待，避免占住队列
  void submitSopTasks({
    sopJobId: `sop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sopName: sopTitleOf(sop, job.label),
    systemPromptName: job.systemPromptText.split('\n')[0].slice(0, 24) || '系统提示词',
    sopText: sop,
    directionId: job.directionId,
    prompts,
  })
}

function pump() {
  while (runningCount < QUEUE_LIMIT && queue.length) {
    const job = queue.shift()
    if (!job) return
    runningCount += 1
    refreshProgress(job.label)
    void runJob(job)
      .catch((err) => {
        useStore.getState().showToast(`${job.label}：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
      .finally(() => {
        runningCount -= 1
        doneCount += 1
        if (!queue.length && runningCount === 0) {
          totalCount = 0
          doneCount = 0
          useSopStore.getState().setProgress(null)
          useStore.getState().showToast('SOP 生图已全部提交', 'success')
          return
        }
        refreshProgress(job.label)
        pump()
      })
  }
}

/** 把任务卡推入后台队列，立即返回 */
export function enqueueSopJobs(jobs: SopJobRequest[]) {
  if (!jobs.length) return
  totalCount += jobs.length
  queue.push(...jobs)
  refreshProgress(jobs[0].label)
  pump()
}
