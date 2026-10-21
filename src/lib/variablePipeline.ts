/**
 * 变量模式流水线：与 SOP 模式并行的一条链路，区别只在「怎么拿到提示词」。
 *
 * SOP 模式：参考图 + 系统提示词 → 一整份 SOP → 让模型按 SOP 写 N 条提示词。
 * 变量模式：参考图 + 变量提示词 → 提示词骨架 + 多组变量选项
 *          → 后端按最远点采样选变量组合 → 逐个填词成具体提示词。
 *
 * 后半段（占位卡、出图、任务落库）与 SOP 完全复用 submitSopTasks，
 * 所以任务卡、详情页、筛选、下载都不用另做一套。
 */

import type { ApiProfile, VariableDimension, VariablePrompt, VariableStrategy } from '../types'
import { createSopPlaceholder, removeSopPlaceholder, submitSopTasks, updateTaskInStore, useStore } from '../store'
import { useSopStore } from './sopStore'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import { apiFetch } from './platform'
import { productIdForDirection } from './applyPostTemplate'
import { buildAvoidHint, pickAvoidTemplate } from './postReserve'
import { dedupePrompts, normalizeCopy } from './copyDedupe'
import { planStrategyFills } from './variableSample'
import { shrinkToDataUrl, SOP_TEXT_MODEL } from './sopPipeline'

/** 与 SOP 反推用同一个文本模型 */
const MODEL_MAX_SIDE = 1024
const MANY_IMAGE_THRESHOLD = 16

/** 一轮纯文本/多模态对话，与 sopPipeline 的 chat 保持同样的调用约定 */
async function chat(profile: ApiProfile, messages: unknown[], timeoutSeconds = 300): Promise<string> {
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
        model: profile.sopTextModel || SOP_TEXT_MODEL,
        messages,
        // 提取策略要求结构稳定、可复现，温度压低
        temperature: 0.2,
        max_tokens: 4000,
        stream: false,
        // 质检/提取类模型默认走思考模式会吃掉 token，这里显式关掉
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

/**
 * 变量提示词为空时的兜底：直接用内置的提取策略。
 * 用户没建变量提示词也能跑，界面上的「变量提示词」选择器会显示「内置策略」。
 *
 * 这里刻意不写「输出 Markdown / 固定回复格式」那一套：变量模式要的是 JSON，
 * 两套格式要求并存会让模型按 Markdown 吐，解析直接失败（卡片转圈后消失）。
 * 输出格式统一由 OUTPUT_RULES 负责。
 */
export const BUILTIN_VARIABLE_PROMPT: VariablePrompt = {
  id: '__builtin_variable__',
  productId: '',
  name: '内置提取策略',
  content: [
    '从参考图片中提炼可迁移的视觉生成方法。回答“为什么这样构图、可以如何复用和变化”，不要只复述画面内容。',
    '始终使用简体中文。提示词、变量名和必要的英文模型关键词保持原样。',
    '',
    '## 分析流程',
    '- 逐图识别主体、语义符号、承载结构、融合关系、构图、材质、光影、背景和重复元素。',
    '- 将共享同一视觉机制的图片归为一个策略；不要机械一图对应一个策略。',
    '- 区分“核心策略”和“可变项”：策略描述稳定的生成逻辑，可变项提供可批量替换的内容。',
    '- 优先提炼结构关系，例如负形融合、嵌套防护、中心核心与外围阵列、符号叠加、状态环和材质隐喻。',
    '- 为每个策略编写一段可直接用于图生图或参考图生图的通用提示词。',
    '- 不预设参考图之外的固定颜色。默认要求颜色、材质、明暗和氛围参考输入图。',
    '- 默认排除文字、水印、免责声明和无关内容，除非用户明确要求保留。',
    '- 策略数量以“视觉机制是否真正不同”为准。单图通常提炼 1-3 个策略；多图可以合并同类项，也可以从共性中扩展新方向，但必须明确哪些是直接观察、哪些是合理扩展。',
    '',
    '## 提示词要求',
    '- 使用 {{变量名}} 表示可替换内容。',
    '- 可变项中的变量名也必须使用双大括号，例如 {{核心圆盘}}，不得写成“核心圆盘”。',
    '- 提示词中出现的每个变量，都必须在“可变项”中以完全相同的名称出现，并提供可替换选项。',
    '- 可变项中不得出现提示词未使用的变量；需要增加变量时，先在提示词正文中使用同名变量。',
    '- 将视觉关系写成动作：包围、嵌套、镂空、融合、承托、阵列、连接、映射。',
    '- 避免只有风格形容词而没有空间和结构约束。',
    '- 参考图已有颜色时，写“参考输入图的配色体系”，不要擅自限定蓝色、绿色等具体颜色。',
    '- 需要完整外围结构时，明确“完整闭合、连续可见、不能开口或裁切”。',
    '- 需要避免内容重复时，提供对象池、策略池或近期去重变量，而不是要求模型自行随机。',
    '- 不把广告文案、免责声明或投保条件当成视觉策略。',
    '- 每个策略至少给三组可变项，每组至少三个可替换选项。',
  ].join('\n'),
  updatedAt: 0,
}

/** 输出格式约定：模型必须吐 JSON，避免 Markdown 解析歧义 */
const OUTPUT_RULES = [
  '',
  '## 输出格式（优先级最高，与上文任何格式要求冲突时一律以本节为准）',
  '只输出一个 JSON 数组，不要任何解释、不要 Markdown 代码块、不要前后缀文字。',
  '即使上面的提取策略里写了「按 markdown 逐条输出」「可变项：」之类的格式要求，也一律改用下面的 JSON。',
  '数组每一项是一个策略对象，字段固定为：',
  '{"name":"策略名称","evidence":"对应图1、图3","skeleton":"含 {{变量名}} 的完整提示词","dimensions":[{"name":"变量名","options":["选项A","选项B","选项C"]}],"value":"一句话说明适用价值"}',
  '所有 dimensions 里的 name 必须在 skeleton 里以完全相同的 {{name}} 出现，且 skeleton 里出现的每个变量都要在 dimensions 里出现。',
].join('\n')

/**
 * 卖点放进骨架时的硬规则。
 *
 * 变量模式和 SOP 模式的差别在这里：SOP 是模型逐条写提示词，卖点由模型抄进去；
 * 变量模式的提示词由骨架填词得到，卖点必须提前写死在 skeleton 里，
 * 而且绝对不能变成变量选项——否则每填一次词卖点就换一套，图上的文字全乱。
 */
const COPY_RULES = [
  '【卖点进骨架的硬规则】',
  '- 卖点文案必须逐字写进 skeleton 的文字位（用「」包裹），不得改写、缩写、扩写、合并或新增；卖点与提取策略冲突时，一律以卖点为准。',
  '- 卖点绝不能做成变量：dimensions 的 name 和 options 里都不许出现卖点原文或其改写，否则每填一次词图上文字就变了。',
  '- 同一句卖点在一张图上只能出现一次：一句进了主标题，就不许再出现在副标题、角标、贴片等其他文字位，也不许换个说法或拆成两行重写。',
  '- 文字位数量按卖点条数来定：有几条卖点就排几个文字位，不要设计固定数量的装饰性文字位，更不要用重复的卖点把版面填满。',
  '- 所有策略用的是同一份卖点，因此所有填词结果图上文字逐张一致，各图的差别只体现在变量带来的场景、结构、机位与配色上。',
].join('\n')

/** 拼「参考图 + 变量提示词」这一轮的提示词；单独抽出来便于测试 */
export function buildVariableExtractMessages({
  variablePromptText,
  copyText = '',
  styleText = '',
  ignoreCompliance = true,
  avoidCta = true,
  avoidHint = '',
  imageCount = 1,
}: {
  variablePromptText: string
  copyText?: string
  styleText?: string
  ignoreCompliance?: boolean
  avoidCta?: boolean
  /** 后处理预留区说明：出图后要叠 Logo / 警示语，骨架里的主体与文字要避开 */
  avoidHint?: string
  imageCount?: number
}): { system: string; user: string } {
  const copy = copyText.trim()
  const system = [
    variablePromptText.trim() || BUILTIN_VARIABLE_PROMPT.content,
    copy ? COPY_RULES : '',
    ignoreCompliance
      ? '参考图上的品牌 logo、水印、免责声明、风险提示、「请见条款及投保须知」「本素材纯属广告创意」这类合规小字，一律不要提取，也不要写进任何变量选项。'
      : '',
    avoidCta
      ? '参考图里的按钮、悬浮球、进度条、返回箭头、开关等「仿系统界面 / 可点击」的设计元素，一律不要写进策略；提示词里要明确列为禁忌：不画按钮、不画手指点击示意、不加指向性箭头，也不写「立即领取」「点击查看」「滑动解锁」这类引导点击的文案。'
      : '',
    avoidHint.trim()
      ? '【画面预留区】出图后会在固定位置叠加 Logo / 警示语，skeleton 里要写清主体、主要文字和关键视觉安排在预留区之外，并明确说明这些区域留白或保持干净背景。'
      : '',
    OUTPUT_RULES,
  ].filter(Boolean).join('\n')

  const user = [
    `根据下面 ${imageCount} 张参考图，按上面的提取策略产出策略与可变项。`,
    copy ? `\n【卖点文案（图上文字必须逐字照抄，不得改写）】\n${copy}` : '',
    copy ? '注意：卖点只决定图上文字，要逐字写进 skeleton 的文字位；不要把卖点当成视觉策略，也不要把它放进变量选项。' : '',
    styleText.trim() ? `\n【风格】\n${styleText.trim()}` : '',
    avoidHint.trim() ? `\n${avoidHint.trim()}` : '',
    '\n现在只输出 JSON 数组。',
  ].filter(Boolean).join('\n')

  return { system, user }
}

/**
 * 一轮「参考图 + 变量提示词」调用：返回策略列表。
 * 模型可能带 ```json 包裹或前后废话，这里统一剥到第一个 [ 到最后一个 ]。
 */
export async function extractStrategies(
  profile: ApiProfile,
  params: {
    variablePromptText: string
    imageDataUrls: string[]
    copyText?: string
    styleText?: string
    ignoreCompliance?: boolean
    avoidCta?: boolean
    avoidHint?: string
  },
): Promise<{ strategies: VariableStrategy[]; raw: string }> {
  const maxSide = params.imageDataUrls.length > MANY_IMAGE_THRESHOLD ? 768 : MODEL_MAX_SIDE
  const images = await Promise.all(params.imageDataUrls.map((url) => shrinkToDataUrl(url, maxSide)))
  const messages = buildVariableExtractMessages({
    variablePromptText: params.variablePromptText,
    copyText: params.copyText,
    styleText: params.styleText,
    ignoreCompliance: params.ignoreCompliance,
    avoidCta: params.avoidCta,
    avoidHint: params.avoidHint,
    imageCount: images.length,
  })
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: messages.user }]
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })

  const raw = await chat(profile, [
    { role: 'system', content: messages.system },
    { role: 'user', content },
  ])
  const strategies = parseStrategies(raw)
  if (!strategies.length) throw new Error('模型没有返回可用的策略')
  return { strategies, raw }
}

/** 解析策略 JSON；字段缺失或变量名对不上时按骨架里的变量名补齐/裁剪 */
export function parseStrategies(raw: string): VariableStrategy[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) {
    // 用户自建的变量提示词常带「按 markdown 逐条输出」的要求，模型会照着吐 Markdown，
    // 这里兜一层 Markdown 解析，别让整批任务因为一个格式就跑不出来
    return parseMarkdownStrategies(raw)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return parseMarkdownStrategies(raw)
  }
  if (!Array.isArray(parsed)) return parseMarkdownStrategies(raw)

  const out: VariableStrategy[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const skeleton = String(row.skeleton ?? '').trim()
    if (!skeleton) continue

    // 骨架里没有的变量丢掉，骨架里有但模型漏给的补空，后面采样会自动跳过
    const dimensions: VariableDimension[] = []
    for (const entry of Array.isArray(row.dimensions) ? row.dimensions : []) {
      if (!entry || typeof entry !== 'object') continue
      const dim = entry as Record<string, unknown>
      const name = String(dim.name ?? '').trim()
      if (!name) continue
      const options = (Array.isArray(dim.options) ? dim.options : [])
        .map((option) => String(option ?? '').trim())
        .filter(Boolean)
      if (!options.length) continue
      dimensions.push({ name, options: Array.from(new Set(options)) })
    }

    out.push({
      name: String(row.name ?? '').trim() || `策略 ${out.length + 1}`,
      evidence: String(row.evidence ?? '').trim(),
      skeleton,
      dimensions: alignDimensions(skeleton, dimensions),
      value: String(row.value ?? '').trim(),
    })
  }
  return out
}

/**
 * 让 dimensions 与骨架里的 {{变量}} 严格对齐：
 * 骨架没用的变量删掉，骨架用到但模型没给选项的补成单选项（采样会自动跳过，填词保留占位提醒）。
 */
function alignDimensions(skeleton: string, dimensions: VariableDimension[]): VariableDimension[] {
  const used: string[] = []
  for (const match of skeleton.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const name = match[1].trim()
    if (name && !used.includes(name)) used.push(name)
  }
  return used.map((name) => dimensions.find((dim) => dim.name === name) ?? { name, options: [] })
}

/**
 * Markdown 格式兜底解析。
 *
 * 用户自建的变量提示词经常照抄「1. 策略名 / 一段提示词 / 可变项：/ 变量：A / B / C」这套，
 * 模型就会按 Markdown 吐而不是 JSON。这里把这种结构读出来，总比整批失败好。
 */
export function parseMarkdownStrategies(raw: string): VariableStrategy[] {
  const text = raw.replace(/```[a-z]*\n?/gi, '').trim()
  if (!text) return []

  // 按「1. 策略名」「## 1. 策略名」「**1. 策略名**」切块
  const blocks: Array<{ name: string; body: string }> = []
  const head = /^[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*)?(\d{1,2})[.、)][ \t]*(?:\*\*)?[ \t]*(.+?)[ \t]*(?:\*\*)?$/gm
  const matches = Array.from(text.matchAll(head))
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    const start = (match.index ?? 0) + match[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length
    blocks.push({ name: match[2].replace(/[:：]\s*$/, '').trim(), body: text.slice(start, end) })
  }
  if (!blocks.length) return []

  const out: VariableStrategy[] = []
  for (const block of blocks) {
    // 「可变项：」之后是变量定义，之前是策略描述与骨架
    const cut = block.body.search(/^\s*(?:可变项|变量)\s*[:：]/m)
    const beforeRaw = cut >= 0 ? block.body.slice(0, cut) : block.body
    const afterRaw = cut >= 0 ? block.body.slice(cut) : ''

    // 骨架：取最长的一段正文，且必须含 {{变量}} 才算
    const paragraphs = beforeRaw
      .split(/\r?\n\s*\r?\n/)
      .map((item) => item.replace(/^\s*(?:-\s*)?\*\*?提示词\*\*?[:：]\s*/i, '').trim())
      .filter(Boolean)
    const skeleton = paragraphs
      .filter((item) => /\{\{[^{}]+\}\}/.test(item))
      .sort((a, b) => b.length - a.length)[0]
    if (!skeleton) continue

    // 变量行：「- {{圆盘}}：A / B / C」「核心圆盘：A、B、C」
    const dimensions: VariableDimension[] = []
    for (const line of afterRaw.split(/\r?\n/)) {
      const match = line.match(/^[ \t]*(?:[-*+][ \t]*)?\{\{\s*([^{}]+?)\s*\}\}[ \t]*[:：][ \t]*(.+)$/)
        ?? line.match(/^[ \t]*(?:[-*+][ \t]*)?([^:：{}\n]{1,20})[ \t]*[:：][ \t]*(.+)$/)
      if (!match) continue
      const name = match[1].trim()
      const options = match[2]
        .split(/[/／、,，]| \| /)
        .map((item) => item.replace(/^\s*(?:选项)?[\dA-Za-z一二三四五六七八九十]*\s*[.、)]?\s*/, '').trim())
        .filter(Boolean)
      if (!name || !options.length) continue
      dimensions.push({ name, options: Array.from(new Set(options)) })
    }

    out.push({
      name: block.name || `策略 ${out.length + 1}`,
      evidence: (block.body.match(/对应图[\d、,，和白至到\s]+/) ?? [''])[0].trim(),
      skeleton: skeleton.replace(/\s*\n\s*/g, ' ').trim(),
      dimensions: alignDimensions(skeleton, dimensions),
      value: '',
    })
  }
  return out
}

/**
 * 校验卖点有没有真的写进骨架。
 *
 * 变量模式下卖点只写一次（在 skeleton 里），填词阶段不再有机会补；
 * 模型如果擅自把卖点省掉、改写，或偷偷做成变量，整批图就全丢卖点。
 * 这里用 normalizeCopy 做确定性比对（忽略空白与标点差异），不依赖模型自觉。
 *
 * 注意：这是**提示**而不是**闸门**。模型把长卖点拆成两行、加个连接词都是正常行为，
 * 严格比对必然误判，所以只返回问题清单交给调用方提示用户，不在这里拦死。
 */
export function checkCopyInSkeleton(
  strategies: VariableStrategy[],
  copyText: string,
): { ok: boolean; missing: string[]; leaked: string[] } {
  const copy = copyText.trim()
  if (!copy) return { ok: true, missing: [], leaked: [] }

  // 卖点按行拆；逗号不拆，避免把一句文案切碎
  const items = copy
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.、)]|[①-⑳])\s*/, '').trim())
    .filter(Boolean)
  if (!items.length) return { ok: true, missing: [], leaked: [] }

  // 文件头这类极短的不可判定，跳过，免得误报
  const checkable = items.filter((item) => normalizeCopy(item).length >= 4)
  const skeletonText = normalizeCopy(strategies.map((item) => item.skeleton).join('\n'))
  // 轻微拆行（把一句拆成两段）也算写了：退一步按「去掉首尾后再包含」再比一次
  const missing = checkable.filter((item) => {
    const key = normalizeCopy(item)
    if (skeletonText.includes(key)) return false
    const head = key.slice(0, Math.max(4, Math.floor(key.length * 0.7)))
    return !skeletonText.includes(head)
  })

  // 卖点被做成变量选项时，每填一次词图上的文字就换一套，必须提醒
  const leaked: string[] = []
  for (const strategy of strategies) {
    const optionText = normalizeCopy(strategy.dimensions.flatMap((dim) => dim.options).join('\n'))
    for (const item of checkable) {
      const key = normalizeCopy(item)
      if (key && optionText.includes(key)) leaked.push(item)
    }
  }

  return { ok: !missing.length && !leaked.length, missing, leaked: Array.from(new Set(leaked)) }
}

/** 把策略列表回写成 Markdown，存进任务里供详情页回看 */
export function strategiesToText(strategies: VariableStrategy[]): string {
  return strategies.map((strategy, index) => [
    `## ${index + 1}. ${strategy.name}`,
    strategy.evidence ? `对应${strategy.evidence}。` : '',
    '',
    strategy.skeleton,
    '',
    '可变项：',
    ...strategy.dimensions.map((dim) => `- {{${dim.name}}}：${dim.options.join(' / ')}`),
    strategy.value ? `\n${strategy.value}` : '',
  ].filter(Boolean).join('\n')).join('\n\n---\n\n')
}

// ===== 后台队列：与 SOP 并行，互不占位 =====

export interface VariableJobRequest {
  label: string
  imageDataUrls: string[]
  imageIds?: string[]
  /** 变量提示词正文（提取策略）；空则用内置策略 */
  variablePromptText: string
  /** 变量提示词名称，详情页展示用 */
  variablePromptName: string
  /** 卖点原文：图上文字的唯一来源，同时写进提示词阶段 */
  copyText?: string
  /** 风格正文 */
  styleText?: string
  /** 每张卡要几条提示词 */
  fillsPerCard: number
  directionId?: string
  ignoreCompliance?: boolean
  avoidCta?: boolean
  /** 内部用：占位卡已经转成错误卡时不再弹卖点提示 */
  quietCopyCheck?: boolean
}

const QUEUE_LIMIT = 10

const queue: VariableJobRequest[] = []
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

async function runJob(job: VariableJobRequest) {
  const state = useStore.getState()
  const settings = state.settings
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0]
  if (!profile) throw new Error('没有可用的接口配置')

  const sopState = useSopStore.getState()
  const avoidHint = sopState.avoidOverlay === false
    ? ''
    : buildAvoidHint(pickAvoidTemplate(
      sopState.postTemplates[productIdForDirection(sopState.directions, job.directionId)] ?? [],
      state.params.size,
      job.imageDataUrls,
    ))

  const sopJobId = `var-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const placeholderId = createSopPlaceholder(sopJobId, job.label, job.directionId)

  try {
    const { strategies } = await extractStrategies(profile, {
      variablePromptText: job.variablePromptText,
      imageDataUrls: job.imageDataUrls,
      copyText: job.copyText,
      styleText: job.styleText,
      ignoreCompliance: job.ignoreCompliance !== false,
      avoidCta: job.avoidCta !== false,
      avoidHint,
    })

    const { fills, notes } = planStrategyFills(strategies, job.fillsPerCard)
    if (!fills.length) throw new Error(`${job.label} 没有得到可用的变量组合`)

    // 卖点校验只做提示：模型拆行、加连接词都是正常行为，严格比对会误判，
    // 不能因为这里报错就把整批图丢掉。有疑问就提醒，图照出。
    const copyCheck = checkCopyInSkeleton(strategies, job.copyText ?? '')
    if (!copyCheck.ok && !job.quietCopyCheck) {
      const parts: string[] = []
      if (copyCheck.leaked.length) parts.push(`卖点被做成了变量（图上文字会每张不同）：${copyCheck.leaked.slice(0, 2).join('、')}`)
      if (copyCheck.missing.length) parts.push(`骨架里可能漏了卖点：${copyCheck.missing.slice(0, 2).join('、')}`)
      useStore.getState().showToast(`${job.label} ${parts.join('；')}，请留意出图文字`, 'error')
    }

    // 采样只保证变量组合不同；清洗掉同图内重复文案后仍可能撞车，这里按最终文本再兜一层
    const seen = new Set<string>()
    const picked: Array<{ prompt: string; fill: typeof fills[number] }> = []
    for (const fill of fills) {
      const cleaned = dedupePrompts([fill.prompt]).prompts[0]
      if (!cleaned || seen.has(cleaned)) continue
      seen.add(cleaned)
      picked.push({ prompt: cleaned, fill })
    }
    if (!picked.length) throw new Error(`${job.label} 填词后没有剩余内容`)

    const specText = [
      strategiesToText(strategies),
      avoidHint ? `\n---\n\n${avoidHint}` : '',
      notes.length ? `\n---\n\n${notes.join('\n')}` : '',
    ].filter(Boolean).join('\n')

    await removeSopPlaceholder(placeholderId)
    void submitSopTasks({
      sopJobId,
      sopName: strategies[0]?.name || job.label,
      systemPromptName: job.variablePromptName,
      sopText: specText,
      directionId: job.directionId,
      referenceImageIds: job.imageIds,
      prompts: picked.map((item) => item.prompt),
      variable: {
        promptName: job.variablePromptName,
        specText,
        fills: picked.map((item) => ({
          skeleton: item.fill.strategyName,
          assignments: item.fill.assignments,
        })),
      },
    })
  } catch (err) {
    // 不能删卡：删掉就只剩「转圈后卡片消失」这一个现象，用户完全看不到原因。
    // 把占位卡转成错误卡，报错原因留在卡上，可点开看、可重试。
    const message = err instanceof Error ? err.message : String(err)
    updateTaskInStore(placeholderId, {
      status: 'error',
      error: message,
      prompt: `${job.label} · 变量模式失败`,
      finishedAt: Date.now(),
      // 清掉占位标记，否则详情页会把它当临时占位过滤掉
      sopPlaceholder: false,
    })
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
          useStore.getState().showToast('变量模式生图已全部提交', 'success')
          return
        }
        refreshProgress(job.label)
        pump()
      })
  }
}

/** 把变量模式任务卡推入后台队列，立即返回 */
export function enqueueVariableJobs(jobs: VariableJobRequest[]) {
  if (!jobs.length) return
  totalCount += jobs.length
  queue.push(...jobs)
  refreshProgress(jobs[0].label)
  pump()
}
