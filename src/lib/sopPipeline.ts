import type { ApiProfile } from '../types'
import { createSopPlaceholder, removeSopPlaceholder, submitSopTasks, useStore } from '../store'
import { useSopStore } from './sopStore'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'
import { productIdForDirection } from './applyPostTemplate'
import { buildAvoidHint, pickAvoidTemplate } from './postReserve'
import { dedupePrompts } from './copyDedupe'

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
        // 优先用配置里指定的反推/写提示词模型
        model: profile.sopTextModel || SOP_TEXT_MODEL,
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

/** 反推 SOP 的系统提示词；单独导出便于测试哪些规则被写进去了 */
export function buildSopSystemPrompt(ignoreCompliance: boolean, useImageSellingPoints: boolean, avoidCta = false) {
  return [
    '你是广告设计团队的资深生图指导。用户会给你若干张参考图，你要从这些图里反推出一套可复用的「生图 SOP」。',
    'SOP 要能被另一个模型直接照着写出多条提示词，所以必须具体、可执行：写清版式结构、画面元素、文字层级、配色倾向、镜头与光线、必须出现和必须避免的东西。',
    '只描述你从参考图里真实观察到的规律，不要编造参考图里没有的品牌、价格或功效。',
    ignoreCompliance
      ? '参考图上的品牌 logo、水印、免责声明、风险提示、「请见条款及投保须知」「本素材纯属广告创意」这类合规小字，一律不要写进 SOP，也不要要求在生成的图上出现。'
      : '',
    useImageSellingPoints
      ? ''
      : '不要从参考图上提取或复用卖点文案。SOP 的文字规范只描述文字的层级、字号与排布方式，具体文案以用户提供的卖点为准。',
    avoidCta
      ? '参考图里的按钮、悬浮球、进度条、返回箭头、开关、卡片跳转等「仿系统界面 / 可点击」的设计元素，一律不要写进 SOP；SOP 里要明确列为禁忌：不画按钮、不画手指点击示意、不加指向性的箭头或手势，也不写「立即领取」「点击查看」「滑动解锁」「下载App」这类引导点击的文案。'
      : '',
    '文字规范要按卖点条数来定版面：先看这份卖点有几条，再直接按这个数量设计文字区的结构、比例和排布，让文字位数与卖点条数一致。不要让模型先套一个固定版式、再往里填文案，也不要给文字区预留固定数量的空文字位。',
    '卖点条数少的时候，靠重新布局来适配，而不是留空位或用装饰物补位：文字块按实际条数重新分配位置与面积，主视觉相应放大、占掉原本属于文字的区域；禁止用装饰色块、留白块、空框、占位图形去填补「少了一句文字」空出来的位置，那样版面会变得松散、堆砌、很难看。',
    '输出 Markdown，包含以下小节：## SOP 名称、## 适用场景、## 版式结构、## 画面元素、## 文字规范、## 配色与光线、## 必守与禁忌。',
    '不要输出任何解释性开场白。',
  ].filter(Boolean).join('\n')
}

/** 第一步：参考图 + 系统提示词 → 生图 SOP */
export interface RewriteResult {
  /** 模型给的新名称，解析不到时为空串 */
  name: string
  content: string
}

/**
 * 让模型按一句话要求同时改写「名称 + 正文」，用于卖点 / 风格 / 系统提示词的「AI 修改」。
 * 输出约定：第一行是名称，空一行，之后是正文。
 */
export async function rewriteText(
  profile: ApiProfile,
  original: string,
  instruction: string,
  currentName = '',
): Promise<RewriteResult> {
  const system = [
    '你是资深广告文案编辑。用户会给你一段原文（可能带现有名称）和一条修改要求，你要按要求同时改写名称和正文。',
    '输出格式必须严格是：第一行只写新的名称（不超过 16 个字，不要写「标题：」这类前缀）；第二行空一行；从第三行开始是新的正文。',
    '不要输出任何解释、不要加引号、不要用小标题、不要用代码块包裹。',
    '除非修改要求明确要求增删，否则保留原文的结构、关键信息和语气。',
  ].join('\n')
  const user = [
    currentName.trim() ? `【现有名称】\n${currentName.trim()}` : '',
    `【原文】\n${original.trim()}`,
    `【修改要求】\n${instruction.trim()}`,
  ].filter(Boolean).join('\n\n')

  const raw = await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])

  // 必须出现「名称 + 空行 + 正文」才算解析成功，否则整段当正文，名称交给调用方兜底
  const cut = raw.indexOf('\n\n')
  if (cut < 0) return { name: '', content: raw.trim() }
  const nameLine = raw.slice(0, cut).trim()
    .replace(/^(标题|名称)[:：]\s*/, '')
    .replace(/^#+\s*/, '')
    .replace(/^[「『"']|[」』"']$/g, '')
    .trim()
  const content = raw.slice(cut).trim()
  if (!content) return { name: '', content: raw.trim() }
  return { name: nameLine, content }
}

export async function generateSop(
  profile: ApiProfile,
  /** 系统提示词 + 卖点 + 风格合成的一份文档 */
  systemPrompt: string,
  imageDataUrls: string[],
  ignoreCompliance = true,
  useImageSellingPoints = false,
  /** 卖点原文：有就要求原样抄进 SOP 的文字规范 */
  copyText = '',
  /** 避免按钮等引导点击的仿系统界面设计 */
  avoidCta = false,
): Promise<string> {
  const maxSide = imageDataUrls.length > MANY_IMAGE_THRESHOLD ? 768 : MODEL_MAX_SIDE
  const images = await Promise.all(imageDataUrls.map((url) => shrinkToDataUrl(url, maxSide)))
  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        '根据下面这些参考图，反推一套生图 SOP。',
        systemPrompt.trim() ? `\n【用户给定的要求与文案】\n${systemPrompt.trim()}` : '',
        copyText.trim()
          ? '\n注意：「文案」那一段是要印在图上、必须逐字使用的文字，请原样抄进 SOP 的文字规范里，不要改写或省略。'
          : '',
        `\n共 ${images.length} 张参考图，请提炼它们的共同规律。`,
      ].filter(Boolean).join('\n'),
    },
  ]
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })

  return chat(profile, [
    { role: 'system', content: buildSopSystemPrompt(ignoreCompliance, useImageSellingPoints, avoidCta) },
    { role: 'user', content },
  ])
}

function promptSystem(ignoreCompliance: boolean, avoidHint = '', hasCopy = false, avoidCta = false) {
  return [
    '你是广告生图提示词工程师。用户会给你一份生图 SOP，你要严格按这份 SOP 写出指定数量的具体提示词。',
    '每条提示词必须能独立送进文生图模型，包含完整的画面描述：版式、场景、人物、色调、光线、以及图上应有的文字（用「」包裹）。',
    avoidHint
      ? '如果给出了【画面预留区】，每条提示词都要写清主体、主要文字和关键视觉安排在预留区之外，并明确说明这些区域留白或保持干净背景。'
      : '',
    hasCopy
      ? '【文案唯一来源】用户会单独给出「卖点文案」。每张图都要把这份卖点用全，图上出现的所有文字必须逐字照抄这份卖点，不得改写、缩写、扩写、合并或新增；SOP、参考图里的文案与它冲突时一律以卖点文案为准。'
      : '',
    hasCopy
      ? '【卖点在各图之间保持一致】所有提示词用的都是同一份卖点：每张图都要把这份卖点完整地用一遍，不能这张图只用前两条、那张图只用后两条，也不许某张图漏掉某一句。各图之间的差别只体现在场景、机位、人物、配色和版式上，文字内容逐张一致。'
      : '',
    hasCopy
      ? '【同一张图里不许重复卖点】同一句卖点在一张图上只能出现一次：主标题用掉一句，其他文字位就放别的卖点，不要重复、不要换个说法再写一遍、不要拆成两行重复。文字位比卖点多时，把版面重新排一遍让文字位和卖点条数对上，绝对不能拿同一句卖点去填满版面。'
      : '',
    hasCopy
      ? '【版式随卖点条数走】每条提示词先数清楚这份卖点有几条，再按这个数量直接设计版面，而不是先套一个固定版式再删多余槽位：3 条卖点就设计三块文字区（主标题 + 副标题 + 角标），1 条就只设一块大标题区、让它占满原本的标题带，2 条就主副两行分层。文字区的位置、比例、对齐方式都随条数重新分配，主视觉相应放大或收缩。'
      : '',
    hasCopy
      ? '【不许用装饰物补空位】卖点少时多出来的面积，交给画面本身去占据——主体放大、场景延伸、留出干净的负空间，而不是塞装饰色块、空白框、占位图形去「填满」原来的文字位数量。版面靠重新布局达到平衡，不靠往里加东西。'
      : '',
    ignoreCompliance
      ? '不要写品牌 logo、免责声明、风险提示、警示语、合规说明，也不要写「请见条款及投保须知」「本素材纯属广告创意」这类附加小字。'
      : '',
    avoidCta
      ? '画面里不要出现按钮、悬浮球、进度条、返回箭头、开关等仿系统界面的可点击控件，也不要写「立即领取」「点击查看」「滑动解锁」「下载App」这类引导点击的文案，不要画手指点击示意或指向性箭头。'
      : '',
    '多条之间要在场景、机位、人物、色调上做出区分，不能只是换几个词。',
    '只输出编号列表，一行一条，不要任何解释、不要小标题、不要代码块。',
  ].filter(Boolean).join('\n')
}

export interface PromptMessagesInput {
  sopText: string
  count: number
  ignoreCompliance?: boolean
  /** 后处理预留区说明：Logo、警示语这些固定位置要避开 */
  avoidHint?: string
  /** 卖点原文：单独再喂一次，避免 SOP 摘要时把文案改写或丢掉 */
  copyText?: string
  /** 避免按钮等引导点击的仿系统界面设计 */
  avoidCta?: boolean
}

/** 拼「SOP → 提示词」这一轮的两条消息；单独抽出来方便测试文案优先级有没有写进去 */
export function buildPromptMessages({
  sopText,
  count,
  ignoreCompliance = true,
  avoidHint = '',
  copyText = '',
  avoidCta = false,
}: PromptMessagesInput): { system: string; user: string } {
  const copy = copyText.trim()
  const tail = ignoreCompliance
    ? '\n如果 SOP 里提到 logo、免责声明、警示语、合规小字，一律忽略，不要写进任何一条提示词。'
    : ''
  const reserve = avoidHint.trim() ? `\n\n${avoidHint.trim()}` : ''
  const copyBlock = copy ? `\n\n【卖点文案（图上文字必须逐字照抄，不得改写）】\n${copy}` : ''
  const copyTail = copy
    ? '\n注意：每条提示词用的都是同一份卖点，各张图的卖点完全一致。同一张图里，一份卖点从头到尾只用一遍：一句进了主标题，就不许再出现在副标题、角标、贴片等其他文字位上，也不许换个说法或拆成两行重写。文字区数量按卖点条数设计：先数条数，再按这个数量重新分配文字区的位置和比例，不要套固定版式后删槽位，更不要用装饰色块、空框或留白块去补空出来的位置。'
    : ''
  return {
    system: promptSystem(ignoreCompliance, avoidHint, Boolean(copy), avoidCta),
    user: `【生图 SOP】\n${sopText.trim()}${copyBlock}\n\n按这份 SOP 写 ${count} 条提示词，每条之间在场景和构图上要有明显区别。${tail}${copyTail}${reserve}`,
  }
}

/** 第二步：SOP → 多条具体提示词 */
export async function generatePrompts(
  profile: ApiProfile,
  sopText: string,
  count: number,
  ignoreCompliance = true,
  avoidHint = '',
  copyText = '',
  avoidCta = false,
): Promise<string[]> {
  const messages = buildPromptMessages({ sopText, count, ignoreCompliance, avoidHint, copyText, avoidCta })
  const raw = await chat(profile, [
    { role: 'system', content: messages.system },
    { role: 'user', content: messages.user },
  ])
  const prompts = parseNumberedList(raw)
  // 规则层要求「同一张图里每种卖点只出现一次」，但模型可能写重；
  // 这里做确定性兜底：同一句卖点在一张图里重复出现时，只保留第一次。
  return copyText.trim() ? dedupePrompts(prompts).prompts : prompts
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
  imageIds?: string[]
  /** 系统提示词 + 卖点 + 风格合成的一份 Markdown */
  systemPromptText: string
  /** 卖点原文：写提示词阶段要再单独喂一次，保证图上文字逐字来自这里 */
  copyText?: string
  promptsPerGroup: number
  directionId?: string
  ignoreCompliance?: boolean
  useImageSellingPoints?: boolean
  /** 避免按钮、悬浮球这类引导点击的仿系统界面设计，默认开启 */
  avoidCta?: boolean
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

  // 后处理预留区：出图后要在固定位置叠 Logo / 警示语，写提示词时就让模型避开
  const sopState = useSopStore.getState()
  const avoidHint = sopState.avoidOverlay === false
    ? ''
    : buildAvoidHint(pickAvoidTemplate(
      sopState.postTemplates[productIdForDirection(sopState.directions, job.directionId)] ?? [],
      state.params.size,
      job.imageDataUrls,
    ))

  const sopJobId = `sop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  // 先占位，用户点完发送立刻能看到这张卡
  const placeholderId = createSopPlaceholder(sopJobId, job.label, job.directionId)

  try {
    const sop = await generateSop(
      profile,
      job.systemPromptText,
      job.imageDataUrls,
      job.ignoreCompliance !== false,
      job.useImageSellingPoints === true,
      job.copyText ?? '',
      job.avoidCta !== false,
    )
    const prompts = await generatePrompts(
      profile,
      sop,
      job.promptsPerGroup,
      job.ignoreCompliance !== false,
      avoidHint,
      job.copyText ?? '',
      job.avoidCta !== false,
    )
    if (!prompts.length) throw new Error(`${job.label} 没有得到提示词`)

    await removeSopPlaceholder(placeholderId)
    // 出图任务由 submitSopTasks 内部再限并发，这里不等待，避免占住队列
    void submitSopTasks({
      sopJobId,
      sopName: sopTitleOf(sop, job.label),
      systemPromptName: job.systemPromptText.split('\n')[0].slice(0, 24) || '系统提示词',
      sopText: sop,
      directionId: job.directionId,
      referenceImageIds: job.imageIds,
      prompts,
    })
  } catch (err) {
    await removeSopPlaceholder(placeholderId)
    throw err
  }
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
