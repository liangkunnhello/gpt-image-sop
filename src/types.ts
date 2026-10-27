// ===== 设置 =====

export type ApiMode = 'images' | 'responses'
export const REASONING_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number]
export type AppMode = 'gallery' | 'agent'
export type AgentApiConfigMode = 'off' | 'native' | 'hybrid'
export const ZIP_DOWNLOAD_ROUTE_VALUES = [
  'task-selection',
  'favorite-collection-selection',
  'image-context-menu-all',
  'task-detail-all',
  'task-detail-partial',
  'agent-round-all',
] as const
export type ZipDownloadRoute = typeof ZIP_DOWNLOAD_ROUTE_VALUES[number]
export const DEFAULT_ZIP_DOWNLOAD_ROUTES: ZipDownloadRoute[] = ['task-selection', 'favorite-collection-selection']
export type BuiltInApiProvider = 'openai' | 'sb2api-async' | 'fal'
export type ApiProvider = BuiltInApiProvider | string
export type CustomProviderTemplate = 'http-image'
export const DEFAULT_STREAM_PARTIAL_IMAGES = 1
export const DEFAULT_AGENT_MAX_TOOL_ROUNDS = 15
/** 接口允许的参考图数量上限（普通模式融图会把图塞进同一个请求） */
export const MAX_INPUT_IMAGES = 16
/**
 * SOP / 变量模式的参考图上限：不限。
 *
 * 这两种模式的图只用来反推 SOP / 提取变量，不进生图接口，所以不受 MAX_INPUT_IMAGES 约束。
 * 拖入阶段不再有任何数量上限，反推时也不再按 16 张自动分卡（见 splitReferenceGroups）。
 */
export const MAX_SOP_INPUT_IMAGES = Number.POSITIVE_INFINITY

export type CustomProviderRequestMethod = 'GET' | 'POST'
export type CustomProviderContentType = 'json' | 'multipart'
export type CustomProviderFileSource = 'inputImages' | 'mask'

export interface CustomProviderFileMapping {
  field: string
  source: CustomProviderFileSource
  array?: boolean
}

export interface CustomProviderResultMapping {
  imageUrlPaths?: string[]
  b64JsonPaths?: string[]
}

export interface CustomProviderSubmitMapping {
  path: string
  method?: CustomProviderRequestMethod
  contentType?: CustomProviderContentType
  query?: Record<string, string>
  body?: Record<string, unknown>
  files?: CustomProviderFileMapping[]
  taskIdPath?: string
  result?: CustomProviderResultMapping
}

export interface CustomProviderPollMapping {
  path: string
  method?: CustomProviderRequestMethod
  query?: Record<string, string>
  intervalSeconds?: number
  statusPath: string
  successValues: string[]
  failureValues: string[]
  errorPath?: string
  result: CustomProviderResultMapping
}

export interface CustomProviderDefinition {
  id: string
  name: string
  template?: CustomProviderTemplate
  submit: CustomProviderSubmitMapping
  editSubmit?: CustomProviderSubmitMapping
  poll?: CustomProviderPollMapping
}

export interface ApiProfile {
  id: string
  /** 当前部署指定的默认预置配置。 */
  isDefault?: boolean
  name: string
  /** 预置配置的 Markdown 说明。 */
  description?: string
  provider: ApiProvider
  baseUrl: string
  apiKey: string
  /** 模型 ID 列表，多个模型以 `, ` 分隔 */
  model: string
  /** 首页选中的模型；不在列表中时回退到第一个 */
  selectedModel?: string
  imageGenerationModel?: string
  /** SOP 模式反推 SOP 与写提示词所用的文本模型；留空使用内置默认 */
  sopTextModel?: string
  timeout: number
  apiMode: ApiMode
  reasoningEffort?: ReasoningEffort
  codexCli: boolean
  apiProxy: boolean
  responseFormatB64Json?: boolean
  streamImages?: boolean
  streamPartialImages?: number
  transparentBackgroundMethod: 'api' | 'local'
  providerDrafts?: Partial<Record<ApiProvider, Partial<Pick<ApiProfile, 'baseUrl' | 'model' | 'imageGenerationModel' | 'apiMode' | 'reasoningEffort' | 'codexCli' | 'apiProxy' | 'responseFormatB64Json' | 'streamImages' | 'streamPartialImages' | 'transparentBackgroundMethod'>>>>
}

export interface PresetAgentConfig {
  apiConfigMode?: AgentApiConfigMode
  textProfileId?: string
  imageProfileId?: string
}

export interface PresetConfig {
  customProviders: CustomProviderDefinition[]
  profiles: ApiProfile[]
  agent?: PresetAgentConfig
}

/** 参考图预览中“编辑图片”按钮的默认行为 */
export type ReferenceImageEditAction = 'ask' | 'sketch' | 'mask'

/** 仅客户端：下载和导出时每次询问保存位置，还是直接保存到默认保存地址 */
export type SaveLocationMode = 'ask' | 'default'

/** 重试任务时新建任务，还是覆盖原任务 */
export type RetryMode = 'new' | 'overwriteFailed' | 'overwriteAll'

/** 字体选择：default 表示使用部署默认（VITE_DEFAULT_UI_FONT / VITE_DEFAULT_MONO_FONT）；builtin 为内置字体，加载来源由 VITE_BUILTIN_FONT_SOURCE 决定 */
export type FontMode = 'default' | 'builtin' | 'system' | 'custom'

/** 打开画板的请求：baseImageSrc 为空时是空白画板，replaceImageId 表示完成后替换该参考图 */
export interface SketchBoardRequest {
  baseImageSrc: string | null
  replaceImageId?: string
}

/** 正在进行的批量提交进度 */
export interface BatchProgress {
  total: number
  started: number
  finished: number
}

/** 批量提交模式：排队逐条执行，或按并发数同时执行 */
export type BatchPromptMode = 'queue' | 'concurrent'

export interface AppSettings {
  /** 旧版单配置字段：保留用于导入/查询参数兼容，实际请求以 active profile 为准 */
  baseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  apiProxy: boolean
  streamImages?: boolean
  streamPartialImages?: number
  customProviders: CustomProviderDefinition[]
  providerOrder?: string[]
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  retryMode: RetryMode
  /**
   * 发送前做文字校对：卖点是否逐字写进提示词、有没有画面文案、有没有违规词。
   * 关掉就不查（也能省掉一次模型调用）。
   */
  promptProofread: boolean
  allowPromptRewrite: boolean
  taskCompletionNotification: boolean
  /** 启动时检查 GitHub 上的新版本 */
  autoCheckUpdate: boolean
  /** 仅客户端：把警告和错误写入日志文件 */
  writeLogFile: boolean
  enterSubmit: boolean
  uiFont: FontMode
  /** uiFont 为 custom 时使用的本机字体名称 */
  uiFontName: string
  monoFont: FontMode
  /** monoFont 为 custom 时使用的本机字体名称 */
  monoFontName: string
  /** 偏好设置：是否在首页提供多提示词批量提交 */
  showBatchPrompt: boolean
  /** 多提示词批量提交，提示词之间空两行分隔 */
  batchPromptEnabled: boolean
  batchPromptMode: BatchPromptMode
  /** 并发模式下是否限制并发数（默认开启），关闭时全部同时提交 */
  batchPromptConcurrencyLimited: boolean
  batchPromptConcurrency: number
  referenceImageEditAction: ReferenceImageEditAction
  zipDownloadRoutes: ZipDownloadRoute[]
  /** 仅客户端：默认保存地址本身由 Rust 侧保存，不在设置中 */
  saveLocationMode: SaveLocationMode
  /** 仅客户端：任务卡图片保存到同名文件夹时的命名模板 */
  taskFolderTemplate: string
  /** 模板里 {custom} 的取值 */
  taskFolderCustom: string
  /**
   * 生图完成后自动把成品图交付到「业务线 / 产品 / 方向」上配置的交付地址。
   * 三级都没配时回退到默认保存地址；默认关闭。
   */
  autoDeliver: boolean
  agentScrollToBottomAfterSubmit: boolean
  agentMaxToolRounds: number
  agentWebSearch: boolean
  agentMathFormattingPrompt: boolean
  agentApiConfigMode: AgentApiConfigMode
  agentTextProfileId?: string | null
  agentImageProfileId?: string | null
  profiles: ApiProfile[]
  activeProfileId: string
}

// ===== 任务参数 =====

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
  transparent_output: boolean
  /**
   * 出图后是否套用后处理模板（叠 Logo / 文案）。
   * 只在本机生效，不会进接口请求；老任务没有这个字段，按「开启」处理。
   */
  post_process?: boolean
  /**
   * 输出文件大小上限（KB）。空/null 表示不限。
   * 生成完成后在本地按画质逼近这个体积（仅 JPEG / WebP，PNG 无损压不下去）。
   */
  max_file_kb?: number | null
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
  transparent_output: false,
  post_process: true,
  max_file_kb: null,
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** data URL，用于预览 */
  dataUrl: string
}

/** 参考图上的评论标注，x / y 为相对原图宽高的比例（0~1） */
export interface ImageComment {
  x: number
  y: number
  text: string
}

export interface MaskDraft {
  targetImageId: string
  maskDataUrl: string
  updatedAt: number
}

export interface AgentInputDraft {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  updatedAt?: number
}

// ===== 任务记录 =====

export type TaskStatus = 'running' | 'done' | 'error'

/**
 * 普通模式的发图方式：
 * - batch：每张变量图各发一次请求
 * - merge：融图，一次请求带上整组图
 *
 * 定义放在 types.ts（而不是 lib/plainImagePlan.ts）是因为 TaskRecord 的快照要引用它，
 * 而 plainImagePlan.ts 已经 import 本文件，反向引用会形成循环。原处仅做再导出。
 */
export type PlainImageMode = 'merge' | 'batch'

/**
 * 发送瞬间的输入框状态快照。
 *
 * 「复用配置」的本意是把输入框恢复成当时发送前的样子，但任务卡落库时
 * 只保留了合并后的 inputImageIds，分不清哪几张是固定图、哪几张是参考图 / 变量图，
 * 也不知道当时是融图还是批量。这里把发送前的分池与模式单独记一份。
 *
 * 只记录「恢复输入框需要」的东西，不记选择器状态（系统提示词 / 卖点 / 风格的选择
 * 已经在 task.sopSystemPrompt、task.variablePromptName 等字段里另存）。
 */
export interface TaskInputSnapshot {
  /** 发送前所处的模式：普通（融图/批量）/ SOP / 变量 */
  mode: 'plain' | 'sop' | 'variable'
  /** 普通模式：发送前输入框里的提示词原文（不含提交时拼上的卖点 / 风格前缀） */
  prompt?: string
  /** 普通模式的发图方式 */
  plainImageMode?: PlainImageMode
  /** 固定图区的图片 id（普通模式融图 / 变量模式图生图） */
  fixedImageIds?: string[]
  /**
   * 变量图区的图片 id。
   * 普通模式下就是输入框里的参考图（planPlainRequests 的 variableImages），
   * 变量模式下是整池变量图 —— 旧字段 variableImageId 只记了本条用到的那一张，
   * 复用时会丢掉池里其他图，所以整池在这里补全。
   */
  variableImageIds?: string[]
}

export interface TaskRecord {
  id: string
  prompt: string
  params: TaskParams
  /** 生成时使用的 Provider 类型 */
  apiProvider?: ApiProvider
  /** 生成时使用的 API 配置 ID */
  apiProfileId?: string
  /** 生成时使用的 Provider 名称 */
  apiProfileName?: string
  /** 生成时使用的 API 模式 */
  apiMode?: ApiMode
  /** 生成时使用的模型 ID */
  apiModel?: string
  /** fal.ai 队列请求 ID，用于连接断开后的结果恢复 */
  falRequestId?: string
  /** fal.ai 队列 endpoint，用于连接断开后的状态和结果查询 */
  falEndpoint?: string
  /** fal.ai 任务连接断开后是否等待自动恢复 */
  falRecoverable?: boolean
  /** 自定义异步服务商任务 ID，用于重启后继续查询结果 */
  customTaskId?: string
  /** 自定义异步任务是否等待自动恢复 */
  customRecoverable?: boolean
  /** API 返回的实际生效参数，用于标记与请求值不一致的情况 */
  actualParams?: Partial<TaskParams>
  /** 输出图片对应的实际生效参数，key 为 outputImages 中的图片 id */
  actualParamsByImage?: Record<string, Partial<TaskParams>>
  /** 输出图片对应的 API 改写提示词，key 为 outputImages 中的图片 id */
  revisedPromptByImage?: Record<string, string>
  /** 是否启用透明背景后处理 */
  transparentOutput?: boolean
  /** 实际发送给 API 的透明背景辅助提示词 */
  transparentPrompt?: string
  /** 透明背景后处理前的原始输出图片 id，顺序对应 outputImages */
  transparentOriginalImages?: string[]
  /**
   * AI 直出、尚未套后处理模板的图片 id，顺序对应 outputImages。
   * 「再次后处理」用它重新套模板，不需要重新生图；早期任务没有这个字段，无法重跑。
   */
  sourceImages?: string[]
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  /** 并发多图中失败的输出槽位，requestIndex 为从 0 开始的请求序号 */
  outputErrors?: Array<{ requestIndex: number; error: string }>
  /** 流式生成的中间步骤图片 id 列表，仅失败时保留供排查/下载 */
  streamPartialImageIds?: string[]
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 发生解析错误时的原始响应 JSON */
  rawResponsePayload?: string
  status: TaskStatus
  error: string | null
  createdAt: number
  /** 本次生成开始时间，重试时不改变原始创建时间 */
  startedAt?: number
  finishedAt: number | null
  /**
   * 详情页最近一次被打开的时间。
   * 为空或早于 finishedAt 表示结果还没看过，任务卡与归属节点会显示未读红点。
   */
  detailViewedAt?: number
  /** 总耗时毫秒 */
  elapsed: number | null
  /** 是否收藏 */
  isFavorite?: boolean
  /** 所属收藏夹 ID 列表 */
  favoriteCollectionIds?: string[]
  /** 来源模式：画廊 / Agent */
  sourceMode?: AppMode
  /** Agent 对话 ID */
  agentConversationId?: string
  /** Agent 轮次 ID */
  agentRoundId?: string
  /** Agent 消息 ID */
  agentMessageId?: string
  /** Agent 图像工具调用 ID */
  agentToolCallId?: string
  /** Agent 批量图像工具调用 ID */
  agentBatchCallId?: string
  /** Agent 批量图像工具中的稳定条目 ID */
  agentBatchItemId?: string
  /** Agent 图像工具实际动作 */
  agentToolAction?: 'generate' | 'edit' | 'auto' | string
  /** SOP 模式：所属任务卡标识，同一份 SOP 生成的多个任务共享它 */
  sopJobId?: string
  /** SOP 模式：任务卡名称，取自生成的 SOP 标题 */
  sopName?: string
  /** SOP 模式：该条提示词在 SOP 中的序号（从 1 开始） */
  sopPromptIndex?: number
  /** SOP 模式：使用的系统提示词名称，详情页展示用 */
  sopSystemPrompt?: string
  /** SOP 模式：直接用 SOP 库里的某份 SOP 出图时，记录它的名称（跳过反推） */
  sopLibraryName?: string
  /** SOP 模式：这次生成依据的 SOP 全文（Markdown），同一 sopJobId 的各任务内容相同 */
  sopText?: string
  /**
   * 提交时选中的卖点名。
   *
   * 存快照而不是交付时再解析：卖点是「按方向记上一次使用」的，
   * 之后换了卖点再交付旧卡，名字就会写成别的卖点，文件跟内容对不上。
   * 命名模板 {point} 取的就是它。
   */
  sopPointName?: string
  /** 归属的「产品-方向」节点 id，用于左侧栏筛选；空表示未归属 */
  sopDirectionId?: string
  /**
   * 投放渠道（ai-original / gdt / toutiao / baidu / vendor）。
   * 与业务归属是两个独立维度：同一方向下可以有多个渠道的卡片，筛选取交集。
   */
  channel?: string
  /** SOP 模式：反推 SOP 期间插入的占位卡，拿到提示词后会被删除 */
  sopPlaceholder?: boolean
  /** SOP 模式：本轮使用的参考图 id，复用配置时回填输入框 */
  sopReferenceImageIds?: string[]
  /** 变量模式：本条提示词由「骨架 + 变量」填词产出，分组仍复用 sopJobId */
  variableMode?: boolean
  /**
   * 派发来源：这批成品是从哪张卡的 AI 原图派出来的。
   * 有值说明这张卡不是生成的，而是「同一张原图套了这个产品的水印 / Logo」，
   * 详情页据此提示来源，避免被当成一次独立生成。
   */
  dispatchFromTaskId?: string
  /** 变量模式：填词用的骨架，保留 {{变量}} 原文便于回看差异 */
  variableSkeleton?: string
  /** 变量模式：本次填入的「变量名 → 选项」 */
  variableAssignments?: Record<string, string>
  /**
   * 变量模式图生图：本条提示词用到的变量图 id。
   * 固定图在 inputImageIds 里（每条都带），这里只记「这一条换了哪张」，详情页可回看。
   */
  variableImageId?: string
  /**
   * 变量模式图生图：本批的固定图 id（同一 sopJobId 下所有任务都一样）。
   * 复用配置时用来把固定图回填到「固定图」区，避免和变量图混在一起。
   */
  variableFixedImageIds?: string[]
  /** 变量模式：使用的变量提示词名称，详情页展示用 */
  variablePromptName?: string
  /** 变量模式：该策略的完整提取结果（Markdown），详情页回看策略用 */
  variableSpecText?: string
  /**
   * 发送瞬间的输入框状态快照，供「复用配置」把输入框恢复成发送前的样子。
   * 老任务没有这个字段，复用时会退回按 inputImageIds 推断的旧逻辑。
   */
  inputSnapshot?: TaskInputSnapshot
  /**
   * 伪删除标记：有值表示已进回收站，不再出现在画廊/计数里。
   * 图片不清、任务记录保留，只有回收站里「清空」才真正删除。
   */
  deletedAt?: number
  /** 与 deletedAt 配套：同一批删除共用一个标识，便于整批恢复 */
  trashBatchId?: string
  /**
   * 已进「图片回收站」的成品图 id。
   *
   * 单独一个数组而不是从 outputImages 里摘掉：transparentOriginalImages 等字段是按
   * outputImages 的下标对齐的，真的删元素会让这些映射整体错位。
   * 被列在这里的图：不参与交付、不在画廊展示，但原图仍在，可从回收站还原。
   */
  trashedOutputImages?: string[]
  /**
   * 人工改判的质检结论（imageId → pass / fail）。
   *
   * 自动质检结果只存在内存里（刷新就没了），交付过滤要稳定就不能只靠它，
   * 所以人工改判跟着任务落库；没有改判的图仍然以自动结论为准。
   */
  qcVerdicts?: Record<string, 'pass' | 'fail'>
  /**
   * 这张卡已经占用的交付文件夹名（首次交付时写入，同卡各任务相同）。
   *
   * 同一套配置跑两次会得到两张内容完全一样的卡，按命名模板算出来的文件夹名也一样，
   * 交付时就会互相覆盖。把第一次交付用的名字记下来，后来的卡就能看到并改用 `-02`、`-03`；
   * 重交付同一张卡时也靠它认出「这是我自己上次那个文件夹」，不会越交越多。
   */
  deliverFolder?: string
}

// ===== SOP 模式 =====

/** 产品-方向树节点：category 大类 / product 产品 / direction 方向 */
export interface SopDirectionNode {
  id: string
  parentId: string | null
  name: string
  kind: 'category' | 'product' | 'direction'
  /**
   * 伪删除标记：有值表示已进回收站。
   * 连子孙一起删时，整棵子树共用同一个 trashBatchId，恢复时一起回来。
   */
  deletedAt?: number
  /** 同一批删除共用一个标识 */
  trashBatchId?: string
  /** 删除前的父级，恢复时原样挂回去（父级若已不在，则挂回顶层或产品的第一个方向） */
  trashParentId?: string | null
}

/** 挂在「方向」节点下的系统提示词，同一方向可有多条 */
export interface SopSystemPrompt {
  id: string
  /** 所属产品：同一产品下的所有方向共用这份列表 */
  productId: string
  /** 旧数据遗留字段，仅用于迁移时定位产品 */
  directionId?: string
  name: string
  content: string
  updatedAt: number
}

/**
 * 存下来的生图 SOP（与系统提示词同构、同粒度）。
 *
 * 系统提示词只说明「要什么」，SOP 是「具体怎么做」：版式、变量池、互斥规则、
 * 文字规范全在里面。选中一份直接用，跳过每次拖参考图反推那一步。
 */
export interface SavedSop {
  id: string
  /** 所属产品：同一产品下的所有方向共用这份列表 */
  productId: string
  name: string
  /** SOP 全文（Markdown） */
  content: string
  updatedAt: number
}

/** 一张任务卡的元数据，运行时按 sopJobId 从任务聚合，不单独持久化 */
export interface SopJobMeta {
  id: string
  name: string
  directionId: string
  systemPromptName: string
  sopText: string
  promptCount: number
  createdAt: number
}

// ===== 变量模式 =====

/** 一条变量提示词：只描述「提取策略」，不含具体卖点与风格 */
export interface VariablePrompt {
  id: string
  /** 所属产品：与系统提示词同粒度，同一产品下所有方向共用 */
  productId: string
  name: string
  content: string
  updatedAt: number
}

/** 骨架里的一个变量维度，与选项一一对应 */
export interface VariableDimension {
  /** 变量名，去掉 {{}} 后的原文，例如「承载结构」 */
  name: string
  /** 该维度可替换的选项，至少 2 个才有采样意义 */
  options: string[]
}

/** 从参考图提取出的一条策略：骨架 + 变量维度 */
export interface VariableStrategy {
  /** 策略名称 */
  name: string
  /** 证据来源，例如「图1、图3」 */
  evidence: string
  /** 一段完整可用提示词，变量处写成 {{变量名}} */
  skeleton: string
  /** 与骨架里出现的变量逐字对应 */
  dimensions: VariableDimension[]
  /** 适用价值 / 差异化说明 */
  value: string
}

/** 一轮填词的结果 */
export interface VariableFill {
  strategyName: string
  /** 逐维度取值 */
  assignments: Record<string, string>
  /** 填词后的完整提示词 */
  prompt: string
}

export interface FavoriteCollection {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

// ===== Agent 模式 =====

export type AgentMessageRole = 'user' | 'assistant'
export type AgentRoundStatus = 'running' | 'done' | 'error'

export interface AgentMessage {
  id: string
  role: AgentMessageRole
  content: string
  roundId: string
  inputImageIds?: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  outputTaskIds?: string[]
  createdAt: number
}

export interface AgentRound {
  id: string
  index: number
  parentRoundId?: string | null
  userMessageId: string
  assistantMessageId?: string
  prompt: string
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  outputTaskIds: string[]
  responseId?: string
  responseOutput?: ResponsesOutputItem[]
  status: AgentRoundStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
}

export interface AgentConversation {
  id: string
  title: string
  activeRoundId?: string | null
  createdAt: number
  updatedAt: number
  rounds: AgentRound[]
  messages: AgentMessage[]
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 图片来源：用户上传 / API 生成 / 遮罩 */
  source?: 'upload' | 'generated' | 'mask'
  /** 原图宽度 */
  width?: number
  /** 原图高度 */
  height?: number
}

export interface StoredImageThumbnail {
  id: string
  /** 列表缩略图，用于避免卡片页解码完整 4K 原图 */
  thumbnailDataUrl: string
  /** 原图宽度 */
  width?: number
  /** 原图高度 */
  height?: number
  /** 缩略图生成参数版本 */
  thumbnailVersion?: number
}

// ===== API 响应 =====

export interface ImageResponseItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
}

export interface ImageApiResponse {
  data: ImageResponseItem[]
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  n?: number
}

export interface ResponsesInputContentItem {
  type?: string
  text?: string
  image_url?: string
  file_id?: string
  file_url?: string
  file_data?: string
  filename?: string
  detail?: string
}

export interface ResponsesOutputItem {
  id?: string
  type?: string
  status?: string
  action?: string | Record<string, unknown>
  /** function_call: unique call id for sending back function_call_output */
  call_id?: string
  /** function_call: function name */
  name?: string
  /** function_call: JSON-encoded arguments string */
  arguments?: string
  /** function_call_output: JSON/text string or Responses input content */
  output?: string | ResponsesInputContentItem[]
  annotations?: Array<{
    type?: string
    start_index?: number
    end_index?: number
    url?: string
    title?: string
  }>
  content?: Array<{
    type?: string
    text?: string
    refusal?: string
    annotations?: Array<{
      type?: string
      start_index?: number
      end_index?: number
      url?: string
      title?: string
    }>
  }>
  result?: string | null | {
    b64_json?: string
    base64?: string
    image?: string
    data?: string
  }
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  revised_prompt?: string
}

export interface ResponsesApiResponse {
  id?: string
  output?: ResponsesOutputItem[]
  tools?: Array<{
    type?: string
    size?: string
    quality?: string
    output_format?: string
    output_compression?: number
    moderation?: string
    n?: number
  }>
}

export interface FalImageFile {
  url?: string
  content_type?: string
  file_name?: string
  width?: number
  height?: number
  b64_json?: string
  base64?: string
  data?: string
}

export interface FalApiResponse {
  images?: FalImageFile[]
  image?: FalImageFile | string
  url?: string
  seed?: number
}

// ===== 导出数据 =====

/** ZIP manifest.json 格式 */
export interface ExportData {
  version: number
  exportedAt: string
  /** 提示词库：方向树、系统提示词、卖点、风格、后处理模板 */
  sopLibrary?: import('./lib/sopStore').SopLibraryExport
  backupPart?: {
    id: string
    index: number
    total: number
  }
  settings?: Omit<AppSettings, 'customProviders'> & { customProviders?: CustomProviderDefinition[] }
  tasks?: TaskRecord[]
  favoriteCollections?: FavoriteCollection[]
  defaultFavoriteCollectionId?: string | null
  agentConversations?: AgentConversation[]
  /** imageId → 图片信息 */
  imageFiles?: Record<string, {
    path: string
    createdAt?: number
    source?: 'upload' | 'generated' | 'mask'
    width?: number
    height?: number
  }>
  /** imageId → 缩略图信息 */
  thumbnailFiles?: Record<string, {
    path: string
    width?: number
    height?: number
    thumbnailVersion?: number
  }>
}
