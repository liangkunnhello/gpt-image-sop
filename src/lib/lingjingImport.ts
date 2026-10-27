/**
 * 灵境配置导入：登录拿会话 → 拉 分组/产品/方向 + 配置目录 → 逐组合解析生效水印
 * → 转成本机的「方向树」与「后处理模板」。
 *
 * 依据 `lingjing-mcp/docs` 的三份规范：
 * - 认证：POST /login（rememberMe 必须 false），拿 JSESSIONID，之后直接带 cookie；
 * - 水印（= 后处理）取自 `product-config/catalog` / `resolve`，**不是** `/aimaterial/watermark/all`；
 * - 某个「产品-方向」真正生效的水印要用 `resolve` 算（它处理了继承与覆盖），
 *   自己 filter 那 331 条会算错。
 *
 * 这里只做数据搬运与格式转换，怎么写进 store 由调用方决定（导入弹窗最后一次性写入）。
 */

import type { SopDirectionNode } from '../types'
import type { PostElement, PostTemplate } from './postTemplate'

// ===== 灵境侧的数据形状 =====

export interface LingjingGroup {
  id: number
  groupName: string
  sortOrder?: number
}

export interface LingjingProduct {
  id: number
  productName: string
  groupId: number
  sortOrder?: number
}

export interface LingjingDirection {
  id: number
  directionName: string
  productId: number
  sortOrder?: number
}

export interface LingjingSize {
  id: number
  name?: string
  channelCode?: string
  width: number
  height: number
  maxFileSizeKb?: number | null
}

/** 水印图层：text 与 image 两套字段，不要共用一套读法 */
export interface LingjingWatermarkElement {
  type: 'text' | 'image'
  id?: string
  content?: string
  anchor?: string
  x?: number
  y?: number
  width?: number
  height?: number
  opacity?: number
  /** text 专用 */
  fontSize?: number
  fontWeight?: string
  fontColor?: string
  strokeColor?: string
  strokeWidth?: number
  textAlign?: string
  aspectRatio?: number
}

export interface LingjingWatermark {
  id: number
  name: string
  channelCode?: string
  baseSizeId?: number
  canvasWidth?: number
  canvasHeight?: number
  enabled?: string | boolean
  elements?: LingjingWatermarkElement[]
  /**
   * catalog 里的原始字段：图层是 JSON 字符串（resolve 的 effective 才给解析好的数组）。
   * 两边都可能拿到水印，所以这里也认它。
   */
  elementsJson?: string
}

export interface LingjingCatalog {
  size?: LingjingSize[]
  watermark?: LingjingWatermark[]
}

// ===== 接口调用 =====

export const DEFAULT_LINGJING_BASE = 'https://junbo-cy.jetmobo.com'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface LingjingSession {
  baseUrl: string
  fetchImpl: FetchLike
}

function normalizeBase(baseUrl: string): string {
  const trimmed = (baseUrl || DEFAULT_LINGJING_BASE).trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** 统一取 `{code, msg, data}` 里的 data；code!=0 一律当失败抛出（登录超时要能一眼看出来） */
async function readEnvelope<T>(res: Response): Promise<T> {
  const text = await res.text()
  let json: { code?: number; msg?: string; data?: T } | null = null
  try {
    json = JSON.parse(text) as { code?: number; msg?: string; data?: T }
  } catch {
    throw new Error(`返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
  }
  if (typeof json.code === 'number' && json.code !== 0) {
    const msg = json.msg || `code ${json.code}`
    if (msg.includes('登录')) throw new Error(`灵境会话失效：${msg}`)
    throw new Error(msg)
  }
  return json.data as T
}

/**
 * 登录并返回可直接复用的会话。
 *
 * 凭证只在这一次请求里用，不落盘、不进提示词。
 * `credentials: 'include'` 是为了让浏览器把云端的 JSESSIONID 存下来并随后的请求带上。
 */
export async function lingjingLogin(input: {
  baseUrl?: string
  username: string
  password: string
  fetchImpl?: FetchLike
}): Promise<LingjingSession> {
  const baseUrl = normalizeBase(input.baseUrl ?? DEFAULT_LINGJING_BASE)
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init))

  const body = new URLSearchParams({
    username: input.username.trim(),
    password: input.password,
    // 传 true 后端直接 502，规范里写明必须 false
    rememberMe: 'false',
  })

  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (err) {
    // 浏览器跨域失败只会抛 TypeError，这里换成能看懂的提示
    throw new Error(`连不上灵境（${baseUrl}）：${err instanceof Error ? err.message : String(err)}。可能是跨域被拦或网络不通`)
  }
  if (!res.ok) throw new Error(`登录失败：HTTP ${res.status}`)
  await readEnvelope<string>(res)
  return { baseUrl, fetchImpl }
}

async function getJson<T>(session: LingjingSession, path: string): Promise<T> {
  const res = await session.fetchImpl(`${session.baseUrl}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`${path} 失败：HTTP ${res.status}`)
  return readEnvelope<T>(res)
}

export async function fetchLingjingTree(session: LingjingSession) {
  const [groups, products, directions] = await Promise.all([
    getJson<LingjingGroup[]>(session, '/aiimg/group/all'),
    getJson<LingjingProduct[]>(session, '/aiimg/product/all'),
    getJson<LingjingDirection[]>(session, '/aiimg/direction/all'),
  ])
  return { groups: groups ?? [], products: products ?? [], directions: directions ?? [] }
}

export async function fetchLingjingCatalog(session: LingjingSession): Promise<LingjingCatalog> {
  const data = await getJson<LingjingCatalog>(session, '/aiimg/product-config/catalog')
  return data ?? {}
}

export interface ResolvedWatermarks {
  watermarks: LingjingWatermark[]
  /** NAS 交付目录，暂未导入，留作以后用 */
  nasDirectory?: string
}

/** 解析某个组合真正生效的水印（directionId 不传 = 产品级） */
export async function resolveLingjingWatermarks(
  session: LingjingSession,
  productId: number,
  directionId?: number,
): Promise<ResolvedWatermarks> {
  const query = `productId=${productId}${directionId ? `&directionId=${directionId}` : ''}`
  const data = await getJson<{
    effective?: { watermarks?: LingjingWatermark[] }
    resolvedOutput?: { nasDirectory?: string }
  }>(session, `/aiimg/product-config/resolve?${query}`)
  return {
    watermarks: data?.effective?.watermarks ?? [],
    nasDirectory: data?.resolvedOutput?.nasDirectory,
  }
}

/**
 * 把远程图片转成 dataURL。
 *
 * 必须走 fetch 而不是 `<img>` + canvas：远程图直接画进 canvas 会把画布标记为「被污染」，
 * `toDataURL` 会直接抛错，整套模板套用就失败了。fetch 拿不到（没开 CORS）就返回 null，
 * 调用方跳过该图层 —— 文字层还能用，总比整套模板废掉好。
 */
export async function downloadImageAsDataUrl(url: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  if (!url) return null
  try {
    const res = await fetchImpl(url, { credentials: 'omit' })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

// ===== 方向树 =====
const nodeId = (kind: string) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export interface TreeImportPlan {
  nodes: SopDirectionNode[]
  /** 灵境 id → 本机节点 id，后面挂模板要用 */
  groupIds: Map<number, string>
  productIds: Map<number, string>
  directionIds: Map<number, string>
  created: number
  reused: number
}

/**
 * 把灵境的三层目录并进本机业务树：**同级同名就复用**，没有才新建。
 *
 * 只看未删除的节点；回收站里同名的当作不存在，导入会建新的
 * （否则导进来的东西挂在一个看不见的节点下，用户会以为导入失败）。
 */
export function planDirectionTree(
  existing: SopDirectionNode[],
  lingjing: { groups: LingjingGroup[]; products: LingjingProduct[]; directions: LingjingDirection[] },
): TreeImportPlan {
  const alive = existing.filter((node) => !node.deletedAt)
  const nodes = [...existing]
  const byParentName = new Map<string, SopDirectionNode>()
  for (const node of alive) {
    byParentName.set(`${node.parentId ?? ''}::${node.kind}::${node.name.trim()}`, node)
  }

  let created = 0
  let reused = 0
  const ensure = (
    parentId: string | null,
    name: string,
    kind: SopDirectionNode['kind'],
  ): string => {
    const clean = (name ?? '').trim()
    if (!clean) return ''
    const key = `${parentId ?? ''}::${kind}::${clean}`
    const hit = byParentName.get(key)
    if (hit) {
      reused += 1
      return hit.id
    }
    const node: SopDirectionNode = { id: nodeId(kind), parentId, name: clean, kind }
    nodes.push(node)
    byParentName.set(key, node)
    created += 1
    return node.id
  }

  const groupIds = new Map<number, string>()
  const productIds = new Map<number, string>()
  const directionIds = new Map<number, string>()

  const sortByOrder = <T extends { sortOrder?: number; id: number }>(list: T[]) => (
    [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id)
  )

  for (const group of sortByOrder(lingjing.groups)) {
    groupIds.set(group.id, ensure(null, group.groupName, 'category'))
  }
  for (const product of sortByOrder(lingjing.products)) {
    const parent = groupIds.get(product.groupId) ?? null
    productIds.set(product.id, ensure(parent, product.productName, 'product'))
  }
  for (const direction of sortByOrder(lingjing.directions)) {
    const parent = productIds.get(direction.productId) ?? null
    // 产品没导进来（脏数据）时挂到顶层，至少不丢
    directionIds.set(direction.id, ensure(parent, direction.directionName, 'direction'))
  }

  return { nodes, groupIds, productIds, directionIds, created, reused }
}

// ===== 水印 → 后处理模板 =====

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** 取 0~1 的比例值；脏数据里的 undefined / NaN 一律当 0 */
function ratio(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? clamp01(num) : 0
}

export interface WatermarkConvertOptions {
  /** 把 logo 图片地址转成可直接用于 canvas 的 dataURL；拿不到就返回 null（该图层跳过） */
  resolveLogo?: (url: string) => Promise<string | null>
  /** baseSizeId → 体积上限（KB），灵境的尺寸字典里有 */
  sizeLimitKb?: number | null
}

export interface WatermarkConversion {
  template: PostTemplate | null
  /** 因取不到图片而跳过的 logo 图层数 */
  logosSkipped: number
  /** 整条都转不了时的原因 */
  reason?: string
}

/**
 * 一条灵境水印 → 一套后处理模板。
 *
 * 坐标：灵境 x/y 是**图层框的左上角**（归一化），我们画文字时 x/y 也是左上角，
 * 但文字按 `align` 对齐到 x，所以右对齐要取框的右边缘、居中取中间，否则会整体左移一截。
 * 贴图（logo）直接用归一化宽度，和我们的 `width`（相对画布宽度）语义一致。
 */
export async function watermarkToTemplate(
  watermark: LingjingWatermark,
  options: WatermarkConvertOptions = {},
): Promise<WatermarkConversion> {
  const width = Math.round(Number(watermark.canvasWidth) || 0)
  const height = Math.round(Number(watermark.canvasHeight) || 0)
  if (!(width > 0 && height > 0)) return { template: null, logosSkipped: 0, reason: '缺少画布尺寸' }
  const elements = watermark.elements ?? []
  if (!elements.length) return { template: null, logosSkipped: 0, reason: '没有图层' }

  const converted: PostElement[] = []
  let logosSkipped = 0
  for (const [index, el] of elements.entries()) {
    // 灵境里「关掉的图层」用 opacity=0 表示，导过来只会是一层看不见的东西，直接丢
    if (el.opacity != null && Number(el.opacity) <= 0) continue
    const id = `post-${watermark.id}-${index}`
    if (el.type === 'text') {
      const align = el.textAlign === 'center' ? 'center' : el.textAlign === 'right' ? 'right' : 'left'
      const boxX = ratio(el.x)
      const boxWidth = ratio(el.width)
      const x = align === 'right' ? boxX + boxWidth : align === 'center' ? boxX + boxWidth / 2 : boxX
      converted.push({
        id,
        kind: 'text',
        x: clamp01(x),
        y: ratio(el.y),
        fontSize: Math.max(8, Math.round(Number(el.fontSize) || 24)),
        color: el.fontColor || '#ffffff',
        strokeColor: el.strokeColor || '#000000',
        strokeWidth: Math.max(0, Number(el.strokeWidth) || 0),
        fontWeight: String(el.fontWeight).toLowerCase() === 'bold' ? 700 : 400,
        align,
        text: el.content ?? '',
        width: 0,
        opacity: el.opacity == null ? 1 : ratio(el.opacity),
        label: '水印文字',
      })
      continue
    }

    // 贴图：远程地址直接画会污染 canvas（toDataURL 抛错），必须先转成 dataURL
    const url = el.content ?? ''
    const dataUrl = url && options.resolveLogo ? await options.resolveLogo(url) : null
    if (!dataUrl) {
      logosSkipped += 1
      continue
    }
    const logoWidth = ratio(el.width)
    const logoHeight = ratio(el.height)
    converted.push({
      id,
      kind: 'logo',
      x: ratio(el.x),
      y: ratio(el.y),
      fontSize: 0,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 0,
      fontWeight: 400,
      align: 'left',
      text: dataUrl,
      width: logoWidth > 0 ? logoWidth : 0.1,
      opacity: el.opacity == null ? 1 : ratio(el.opacity),
      label: '水印 Logo',
      // 预留区计算用的高宽比：灵境给的是相对画布的比例，按画布换算回真实像素比
      aspect: logoWidth > 0 && logoHeight > 0 ? (logoHeight * height) / (logoWidth * width) : undefined,
    })
  }

  if (!converted.length) return { template: null, logosSkipped, reason: '图层都转不了（logo 取不到图片）' }

  return {
    logosSkipped,
    template: {
      id: `tpl-lingjing-${watermark.id}`,
      label: (watermark.name || `水印 ${watermark.id}`).trim(),
      width,
      height,
      channel: watermark.channelCode || undefined,
      enabled: watermark.enabled == null ? true : !(watermark.enabled === '0' || watermark.enabled === false),
      isDefault: false,
      avoidOverlay: true,
      maxFileKb: options.sizeLimitKb ?? null,
      elements: converted,
    },
  }
}

export interface TemplateMergeResult {
  templates: PostTemplate[]
  created: number
  updated: number
}

/**
 * 把导入的模板并进某个节点的列表：**同名更新**，没见过的追加。
 *
 * 同名同尺寸才覆盖；同名但尺寸不同（灵境里同渠道横竖版可能同名）时追加一套，
 * 否则两套排版会被塞进一个模板里。
 */
export function mergeTemplates(current: PostTemplate[], incoming: PostTemplate[]): TemplateMergeResult {
  const next = [...current]
  let created = 0
  let updated = 0
  for (const template of incoming) {
    const index = next.findIndex((item) => (
      item.label.trim() === template.label.trim()
      && item.width === template.width
      && item.height === template.height
      && (item.channel ?? '') === (template.channel ?? '')
    ))
    if (index >= 0) {
      // 更新内容但保留本地 id：别的配置（比如默认项）可能还指着它
      next[index] = { ...template, id: next[index].id }
      updated += 1
    } else {
      next.push(template)
      created += 1
    }
  }
  return { templates: next, created, updated }
}

// ===== 整条流程 =====

export interface LingjingImportOptions {
  baseUrl?: string
  username: string
  password: string
  existingNodes: SopDirectionNode[]
  existingTemplates: Record<string, PostTemplate[]>
  fetchImpl?: FetchLike
  resolveLogo?: (url: string) => Promise<string | null>
  /** 进度回调：已解析组合数 / 总数 */
  onProgress?: (done: number, total: number, label: string) => void
  shouldCancel?: () => boolean
  /** 逐组合并发数：灵境侧 resolve 比较重，别太猛 */
  concurrency?: number
}

export interface LingjingImportResult {
  nodes: SopDirectionNode[]
  postTemplates: Record<string, PostTemplate[]>
  tree: { created: number; reused: number }
  templates: { created: number; updated: number; logosSkipped: number; failed: string[] }
  /** 因为被取消而没跑完的组合数 */
  canceled: boolean
}

/** 跑一遍导入：登录 → 目录 → 逐组合 resolve → 转换 → 合并。全程不写 store。 */
export async function runLingjingImport(options: LingjingImportOptions): Promise<LingjingImportResult> {
  const session = await lingjingLogin({
    baseUrl: options.baseUrl,
    username: options.username,
    password: options.password,
    fetchImpl: options.fetchImpl,
  })
  const [tree, catalog] = await Promise.all([
    fetchLingjingTree(session),
    fetchLingjingCatalog(session),
  ])

  const plan = planDirectionTree(options.existingNodes, tree)

  const sizes = new Map<number, LingjingSize>()
  for (const size of catalog.size ?? []) sizes.set(size.id, size)

  /**
   * catalog 里的水印是「另一种形状」：图层在 `elementsJson` 字符串里。
   * resolve 的 effective 已经给了解析好的 elements，但个别组合的条目可能只有 id，
   * 所以按 id 建一份兜底，缺图层时从这里补。
   */
  const watermarkFallback = new Map<number, LingjingWatermark>()
  for (const item of catalog.watermark ?? []) {
    if (item.elements?.length) {
      watermarkFallback.set(item.id, item)
      continue
    }
    if (typeof item.elementsJson !== 'string') continue
    try {
      const parsed = JSON.parse(item.elementsJson) as LingjingWatermarkElement[]
      if (Array.isArray(parsed) && parsed.length) watermarkFallback.set(item.id, { ...item, elements: parsed })
    } catch {
      // 单个水印的 JSON 坏了不影响整批导入
    }
  }

  // 产品级 + 方向级每个组合各解一次；产品级是为了「方向没配水印」时的兜底
  const combos: Array<{ ownerId: string; productId: number; directionId?: number; label: string }> = []
  for (const product of tree.products) {
    const ownerId = plan.productIds.get(product.id)
    if (ownerId) combos.push({ ownerId, productId: product.id, label: `产品：${product.productName}` })
  }
  for (const direction of tree.directions) {
    const ownerId = plan.directionIds.get(direction.id)
    if (ownerId) {
      combos.push({
        ownerId,
        productId: direction.productId,
        directionId: direction.id,
        label: `方向：${direction.directionName}`,
      })
    }
  }

  const templates = { ...options.existingTemplates }
  const stats = { created: 0, updated: 0, logosSkipped: 0, failed: [] as string[] }
  let done = 0
  let canceled = false

  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 4))
  const queue = [...combos]
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const combo = queue.shift()
      if (!combo) return
      if (options.shouldCancel?.()) {
        canceled = true
        return
      }
      try {
        const resolved = await resolveLingjingWatermarks(session, combo.productId, combo.directionId)
        const incoming: PostTemplate[] = []
        for (const watermark of resolved.watermarks) {
          const canvasWidth = Number(watermark.canvasWidth) || 0
          const canvasHeight = Number(watermark.canvasHeight) || 0
          const size = watermark.baseSizeId != null ? sizes.get(watermark.baseSizeId) : undefined
          // 图层缺失时从 catalog 兜底拿（resolve 偶尔只给 id / 名称）
          const source = watermark.elements?.length ? watermark : (watermarkFallback.get(watermark.id) ?? watermark)
          const conversion = await watermarkToTemplate(
            {
              ...source,
              ...watermark,
              elements: source.elements,
              // resolve 偶尔不带画布尺寸，用尺寸字典补
              canvasWidth: canvasWidth || source.canvasWidth || size?.width,
              canvasHeight: canvasHeight || source.canvasHeight || size?.height,
            },
            { resolveLogo: options.resolveLogo, sizeLimitKb: size?.maxFileSizeKb ?? null },
          )
          if (conversion.logosSkipped) stats.logosSkipped += conversion.logosSkipped
          if (conversion.template) incoming.push(conversion.template)
          else if (conversion.reason) stats.failed.push(`${combo.label} · ${watermark.name}：${conversion.reason}`)
        }
        if (incoming.length) {
          const merged = mergeTemplates(templates[combo.ownerId] ?? [], incoming)
          templates[combo.ownerId] = merged.templates
          stats.created += merged.created
          stats.updated += merged.updated
        }
      } catch (err) {
        stats.failed.push(`${combo.label}：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        done += 1
        options.onProgress?.(done, combos.length, combo.label)
      }
    }
  })
  await Promise.all(workers)

  return {
    nodes: plan.nodes,
    postTemplates: templates,
    tree: { created: plan.created, reused: plan.reused },
    templates: stats,
    canceled,
  }
}
