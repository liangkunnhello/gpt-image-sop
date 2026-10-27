/**
 * 灵境离线导入：读 `lingjing-mcp/archive` 与 `export` 里的 JSON 文件，不登录、不联网。
 *
 * 相比实时登录那条路，归档的好处是**组合早就解析好了**：
 * `product_direction_map.json` 里 131 个「产品 / 产品-方向」组合已经带着最终生效的水印 id 与
 * NAS 交付地址，不用再对每个组合打一次 `product-config/resolve`（省掉 131 次请求与 1~2 分钟）。
 *
 * 文件按**内容形状**识别，不看文件名：archive 与 export 两套导出都能混着选，
 * 顺序无关，也可以只给其中几个（缺哪块会在 missing 里说明）。
 */

import type { SopDirectionNode } from '../types'
import type { SopPreset } from './sopStore'
import type { PostTemplate } from './postTemplate'
import {
  memoizeLogoResolver,
  mergeTemplates,
  planDirectionTree,
  watermarkToTemplate,
  type LingjingDirection,
  type LingjingGroup,
  type LingjingProduct,
  type LingjingSize,
  type LingjingWatermark,
  type LingjingWatermarkElement,
} from './lingjingImport'

// ===== 归档文件的形状 =====

export type LingjingArchiveKind =
  | 'watermark'
  | 'mapping'
  | 'sizes'
  | 'nas'
  | 'tree'
  | 'groups'
  | 'products'
  | 'directions'
  | 'channels'
  | 'unknown'

export interface ArchiveFileInput {
  name: string
  text: string
}

/** 归档里「已解析生效配置」的一行：产品级 directionId 为 null */
export interface LingjingMapping {
  groupId?: number | null
  groupName?: string
  productId: number
  productName?: string
  directionId?: number | null
  directionName?: string | null
  /** 只有 id / 画布 / 渠道，图层要去 watermark_spec 里按 id 取 */
  watermarks?: Array<{
    id: number
    name?: string
    channelCode?: string
    baseSizeId?: number | null
    canvasWidth?: number
    canvasHeight?: number
  }>
  watermarkIds?: number[]
  nas?: { nasDirectory?: string; outputDir?: string } | null
}

export interface LingjingNasPreset {
  id: number | string
  name?: string
  channelCode?: string
  directoryTemplate?: string
  isDefault?: string | boolean
}

// ===== 文件识别 =====

/** 按内容的形状判断这是什么文件（文件名会改，形状不会） */
export function detectArchiveKind(value: unknown): LingjingArchiveKind {
  if (Array.isArray(value)) {
    const first = value.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined
    if (!first) return 'unknown'
    // tree.json 是嵌套的 分组 → products → directions，一个文件顶三层
    if (Array.isArray(first.products)) return 'tree'
    if ('groupName' in first) return 'groups'
    if ('productName' in first) return 'products'
    if ('directionName' in first) return 'directions'
    return 'unknown'
  }
  if (!value || typeof value !== 'object') return 'unknown'
  const record = value as Record<string, unknown>
  if (Array.isArray(record.mappings)) return 'mapping'
  if (Array.isArray(record.watermarks)) return 'watermark'
  if (Array.isArray(record.presets)) return 'nas'
  if (Array.isArray(record.sizes)) return 'sizes'
  if (Array.isArray(record.channels)) return 'channels'
  return 'unknown'
}

const KIND_LABEL: Record<LingjingArchiveKind, string> = {
  watermark: '水印图层',
  mapping: '产品-方向映射',
  sizes: '尺寸字典',
  nas: 'NAS 交付预设',
  tree: '产品树',
  groups: '分组',
  products: '产品',
  directions: '方向',
  channels: '渠道',
  unknown: '认不出来',
}

export interface LingjingArchive {
  groups: LingjingGroup[]
  products: LingjingProduct[]
  directions: LingjingDirection[]
  /** id → 水印（画布尺寸已归一化到 canvasWidth/Height，图层已解析成数组） */
  watermarks: Map<number, LingjingWatermark>
  sizes: Map<number, LingjingSize>
  mappings: LingjingMapping[]
  nasPresets: LingjingNasPreset[]
  /** 每个文件识别成了什么 */
  files: Array<{ name: string; kind: LingjingArchiveKind }>
  /** 缺了哪几块（能导，但对应功能会少） */
  missing: string[]
}

/** 归一化水印：archive 用 `canvas: {width,height}`，实时接口用 canvasWidth/Height */
function normalizeWatermark(raw: LingjingWatermark & { canvas?: { width?: number; height?: number } }): LingjingWatermark {
  const canvas = raw.canvas ?? {}
  let elements = raw.elements
  if (!elements?.length && typeof raw.elementsJson === 'string') {
    try {
      const parsed = JSON.parse(raw.elementsJson) as LingjingWatermarkElement[]
      if (Array.isArray(parsed) && parsed.length) elements = parsed
    } catch {
      // 单个水印的图层 JSON 坏了不影响整批
    }
  }
  return {
    ...raw,
    canvasWidth: Math.round(Number(raw.canvasWidth) || Number(canvas.width) || 0),
    canvasHeight: Math.round(Number(raw.canvasHeight) || Number(canvas.height) || 0),
    elements,
  }
}

const num = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 把一批文件读成一份归档。
 *
 * 三个必需块：方向树（groups/products/directions 或 product_direction_map 二者之一）、
 * 水印图层（watermark_spec）、尺寸字典（只影响体积上限，缺了也能导）。
 */
export function parseLingjingArchive(files: ArchiveFileInput[]): LingjingArchive {
  const groups: LingjingGroup[] = []
  const products: LingjingProduct[] = []
  const directions: LingjingDirection[] = []
  const watermarks = new Map<number, LingjingWatermark>()
  const sizes = new Map<number, LingjingSize>()
  let mappings: LingjingMapping[] = []
  let nasPresets: LingjingNasPreset[] = []
  const seen: Array<{ name: string; kind: LingjingArchiveKind }> = []

  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(file.text)
    } catch (err) {
      throw new Error(`${file.name} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
    }
    const kind = detectArchiveKind(parsed)
    seen.push({ name: file.name, kind })

    if (kind === 'tree') {
      // tree.json：分组 → products → directions 嵌套结构，顺序即排序
      const treeGroups = parsed as Array<{
        id?: number
        name?: string
        products?: Array<{
          id?: number
          name?: string
          directions?: Array<Record<string, unknown>>
        }>
      }>
      for (const [groupIndex, group] of treeGroups.entries()) {
        const groupId = num(group.id)
        const groupName = String(group.name ?? '').trim()
        if (groupId && groupName) groups.push({ id: groupId, groupName, sortOrder: groupIndex })
        const treeProducts = group.products ?? []
        for (const [productIndex, product] of treeProducts.entries()) {
          const productId = num(product.id)
          const productName = String(product.name ?? '').trim()
          if (!productId || !productName) continue
          products.push({ id: productId, productName, groupId, sortOrder: productIndex })
          const treeDirections = product.directions ?? []
          for (const [directionIndex, direction] of treeDirections.entries()) {
            const directionId = num(direction.id)
            const directionName = String(direction.name ?? '').trim()
            if (!directionId || !directionName) continue
            const copy = String(direction.productCopy ?? '').trim()
            directions.push({
              id: directionId,
              directionName,
              productId,
              sortOrder: directionIndex,
              productCopy: copy || undefined,
            })
          }
        }
      }
    } else if (kind === 'groups') {
      for (const item of parsed as Array<Record<string, unknown>>) {
        const id = num(item.id)
        const name = String(item.groupName ?? '').trim()
        if (!id || !name) continue
        groups.push({ id, groupName: name, sortOrder: num(item.sortOrder) })
      }
    } else if (kind === 'products') {
      for (const item of parsed as Array<Record<string, unknown>>) {
        const id = num(item.id)
        const name = String(item.productName ?? '').trim()
        if (!id || !name) continue
        products.push({ id, productName: name, groupId: num(item.groupId), sortOrder: num(item.sortOrder) })
      }
    } else if (kind === 'directions') {
      for (const item of parsed as Array<Record<string, unknown>>) {
        const id = num(item.id)
        const name = String(item.directionName ?? '').trim()
        if (!id || !name) continue
        const copy = String(item.productCopy ?? '').trim()
        directions.push({
          id,
          directionName: name,
          productId: num(item.productId),
          sortOrder: num(item.sortOrder),
          productCopy: copy || undefined,
        })
      }
    } else if (kind === 'watermark') {
      for (const item of (parsed as { watermarks?: Array<Record<string, unknown>> }).watermarks ?? []) {
        const id = num(item.id)
        if (!id) continue
        watermarks.set(id, normalizeWatermark(item as unknown as LingjingWatermark))
      }
    } else if (kind === 'sizes') {
      for (const item of (parsed as { sizes?: Array<Record<string, unknown>> }).sizes ?? []) {
        const id = num(item.id)
        if (!id) continue
        sizes.set(id, {
          id,
          name: String(item.name ?? ''),
          channelCode: String(item.channelCode ?? ''),
          width: num(item.width),
          height: num(item.height),
          maxFileSizeKb: item.maxFileSizeKb == null ? null : num(item.maxFileSizeKb),
        })
      }
    } else if (kind === 'mapping') {
      const list = (parsed as { mappings?: LingjingMapping[] }).mappings ?? []
      mappings = mappings.length ? [...mappings, ...list] : list
    } else if (kind === 'nas') {
      nasPresets = ((parsed as { presets?: LingjingNasPreset[] }).presets ?? []).slice()
    }
  }

  // 只给了映射文件时，树从映射里反推（131 行里有分组/产品/方向的名字与 id）
  if (!groups.length && !products.length && mappings.length) {
    const groupSeen = new Set<number>()
    const productSeen = new Set<number>()
    for (const item of mappings) {
      if (item.groupId && item.groupName && !groupSeen.has(item.groupId)) {
        groupSeen.add(item.groupId)
        groups.push({ id: item.groupId, groupName: item.groupName, sortOrder: groups.length })
      }
      if (item.productId && item.productName && !productSeen.has(item.productId)) {
        productSeen.add(item.productId)
        products.push({
          id: item.productId,
          productName: item.productName,
          groupId: item.groupId ?? 0,
          sortOrder: products.length,
        })
      }
      if (item.directionId && item.directionName) {
        directions.push({
          id: item.directionId,
          directionName: item.directionName,
          productId: item.productId,
          sortOrder: directions.length,
        })
      }
    }
  }

  const missing: string[] = []
  if (!groups.length || !products.length || !directions.length) missing.push('方向树（产品树 tree.json，或 groups/products/directions.json）')
  if (!mappings.length) missing.push('产品-方向映射（product_direction_map.json）')
  if (!watermarks.size) missing.push('水印图层（watermark_spec.json）')

  // 同时选了 tree.json 和 groups.json 这类重叠文件时去一次重（按 id，后到的覆盖先到的）
  const unique = <T extends { id: number }>(list: T[]): T[] => {
    const map = new Map<number, T>()
    for (const item of list) map.set(item.id, item)
    return [...map.values()]
  }

  return {
    groups: unique(groups),
    products: unique(products),
    directions: unique(directions),
    watermarks,
    sizes,
    mappings,
    nasPresets,
    files: seen,
    missing,
  }
}

// ===== 卖点 / 风格（方向 productCopy 里拆） =====

/**
 * 从方向的 `productCopy` 拆出风格与卖点。
 *
 * 灵境里这段文案是人手写的，格式不统一：一般是「风格统一为 X」一行 + 「文案：…」若干行，
 * 也有直接写一行文案的。所以只认两种明确标记，其余非空行整段当一条卖点，
 * 不硬拆 —— 拆错比不拆更麻烦（卖点会被写进交付文件名）。
 */
export function parseDirectionCopy(directionName: string, productCopy: string): {
  style?: { name: string; content: string }
  points: Array<{ name: string; content: string }>
} {
  const lines = (productCopy || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let style: { name: string; content: string } | undefined
  const points: Array<{ name: string; content: string }> = []
  const rest: string[] = []

  for (const line of lines) {
    const styleHit = line.match(/^风格(?:统一)?\s*(?:为|是|[：:])\s*(.+)$/)
    if (styleHit) {
      const value = styleHit[1].trim()
      if (value) style = { name: `${directionName}·风格`, content: value }
      continue
    }
    const pointHit = line.match(/^(?:主文案|副文案|卖点|文案)\s*[：:]\s*(.+)$/)
    if (pointHit) {
      const value = pointHit[1].trim()
      if (value) points.push({ name: value.slice(0, 12), content: value })
      continue
    }
    rest.push(line)
  }

  // 没有「文案：」标记时，剩下的行整体当一条卖点
  if (!points.length && rest.length) {
    const content = rest.join('\n')
    points.push({ name: content.split('\n')[0].slice(0, 12), content })
  }

  return { style, points }
}

// ===== 整条流程 =====

export interface ArchiveImportOptions {
  existingNodes: SopDirectionNode[]
  existingTemplates: Record<string, PostTemplate[]>
  existingDeliveryDirs: Record<string, string>
  existingPresets: SopPreset[]
  /** logo 贴图地址 → dataURL；拿不到返回 null（该图层跳过） */
  resolveLogo?: (url: string) => Promise<string | null>
  wantTemplates?: boolean
  wantDelivery?: boolean
  wantPresets?: boolean
  onProgress?: (done: number, total: number, label: string) => void
}

export interface ArchiveImportResult {
  nodes: SopDirectionNode[]
  postTemplates: Record<string, PostTemplate[]>
  deliveryDirs: Record<string, string>
  presets: SopPreset[]
  tree: { created: number; reused: number }
  templates: {
    created: number
    updated: number
    logosSkipped: number
    /** 灵境里全部图层都被关掉的「空白水印」，不是错误，单独计数 */
    empty: number
    failed: string[]
    inherited: number
  }
  delivery: { applied: number; inherited: number }
  presetsStats: { created: number; updated: number }
  files: Array<{ name: string; kind: LingjingArchiveKind }>
  missing: string[]
}

const presetId = (ownerId: string, kind: SopPreset['kind'], name: string) => (
  `preset-lingjing-${ownerId}-${kind}-${name}`.replace(/\s+/g, '')
)

/** 水印集合指纹：id + 画布，用来判断某个方向是否和它的产品完全一致（一致就不用另存一套） */
function fingerprint(refs: Array<{ id: number; canvasWidth?: number; canvasHeight?: number }>): string {
  return refs
    .map((item) => `${item.id}@${Math.round(Number(item.canvasWidth) || 0)}x${Math.round(Number(item.canvasHeight) || 0)}`)
    .sort()
    .join(',')
}

/**
 * 跑一遍离线导入：解析归档 → 合并方向树 → 水印转模板 → NAS 交付地址 → 卖点/风格。
 * 全程不写 store，调用方拿到结果后一次性写入。
 */
export async function runLingjingArchiveImport(
  files: ArchiveFileInput[],
  options: ArchiveImportOptions,
): Promise<ArchiveImportResult> {
  const archive = parseLingjingArchive(files)
  if (!archive.groups.length && !archive.products.length && !archive.directions.length) {
    throw new Error('这批文件里认不出方向树，请至少提供 product_direction_map.json 或 products / directions.json')
  }

  const plan = planDirectionTree(options.existingNodes, {
    groups: archive.groups,
    products: archive.products,
    directions: archive.directions,
  })

  const postTemplates = { ...options.existingTemplates }
  const deliveryDirs = { ...options.existingDeliveryDirs }
  const presets = [...options.existingPresets]
  const stats = { created: 0, updated: 0, logosSkipped: 0, empty: 0, failed: [] as string[], inherited: 0 }
  // 331 条水印只有 61 个不同 logo，同一个地址只下一次
  const resolveLogo = memoizeLogoResolver(options.resolveLogo)
  const delivery = { applied: 0, inherited: 0 }
  const presetsStats = { created: 0, updated: 0 }

  // 产品级先跑，方向级才能拿它当基准判断「是不是继承来的、没必要另存」
  const productMappings = archive.mappings.filter((item) => !item.directionId)
  const directionMappings = archive.mappings.filter((item) => item.directionId)
  const productFingerprint = new Map<number, string>()
  const productDir = new Map<number, string>()
  for (const item of productMappings) {
    productFingerprint.set(item.productId, fingerprint(item.watermarks ?? []))
    const dir = (item.nas?.nasDirectory || item.nas?.outputDir || '').trim()
    if (dir) productDir.set(item.productId, dir)
  }

  const total = archive.mappings.length
  let done = 0

  const convertMapping = async (mapping: LingjingMapping, ownerId: string, label: string) => {
    if (options.wantDelivery !== false) {
      const dir = (mapping.nas?.nasDirectory || mapping.nas?.outputDir || '').trim()
      if (dir) {
        const isSameAsProduct = mapping.directionId
          && productDir.get(mapping.productId) === dir
        if (isSameAsProduct) {
          // 和产品级一样：留着继承，别把同一路径抄到每个方向（以后改产品就不同步了）
          delivery.inherited += 1
        } else if (deliveryDirs[ownerId] !== dir) {
          deliveryDirs[ownerId] = dir
          delivery.applied += 1
        }
      }
    }

    if (options.wantTemplates === false) return
    const refs = mapping.watermarks ?? []
    if (!refs.length) return
    if (mapping.directionId && productFingerprint.get(mapping.productId) === fingerprint(refs)) {
      // 方向没覆盖任何水印，用继承就够了
      stats.inherited += 1
      return
    }

    const incoming: PostTemplate[] = []
    for (const ref of refs) {
      const spec = archive.watermarks.get(ref.id)
      if (!spec) {
        stats.failed.push(`${label} · 水印 ${ref.id}：watermark_spec 里找不到这条水印`)
        continue
      }
      const size = ref.baseSizeId != null ? archive.sizes.get(ref.baseSizeId) : undefined
      const conversion = await watermarkToTemplate(
        {
          ...spec,
          // 映射里的画布 / 渠道是这次生效的，优先于字典；
          // 名字反着来：水印定义（spec）才是全名，映射里只是摘要，缺了才用映射的
          canvasWidth: Number(ref.canvasWidth) || spec.canvasWidth,
          canvasHeight: Number(ref.canvasHeight) || spec.canvasHeight,
          channelCode: ref.channelCode || spec.channelCode,
          name: spec.name || ref.name || '',
        },
        { resolveLogo, sizeLimitKb: size?.maxFileSizeKb ?? null },
      )
      if (conversion.logosSkipped) stats.logosSkipped += conversion.logosSkipped
      if (conversion.template) incoming.push(conversion.template)
      else if (conversion.reason === '图层在灵境里全部是关闭状态') stats.empty += 1
      else if (conversion.reason) stats.failed.push(`${label} · ${ref.name ?? ref.id}：${conversion.reason}`)
    }

    if (incoming.length) {
      const merged = mergeTemplates(postTemplates[ownerId] ?? [], incoming)
      postTemplates[ownerId] = merged.templates
      stats.created += merged.created
      stats.updated += merged.updated
    }
  }

  for (const mapping of productMappings) {
    const ownerId = plan.productIds.get(mapping.productId)
    if (ownerId) {
      await convertMapping(mapping, ownerId, `产品：${mapping.productName ?? mapping.productId}`)
    }
    done += 1
    options.onProgress?.(done, total, `产品：${mapping.productName ?? mapping.productId}`)
  }
  for (const mapping of directionMappings) {
    const ownerId = mapping.directionId ? plan.directionIds.get(mapping.directionId) : undefined
    if (ownerId) {
      await convertMapping(mapping, ownerId, `方向：${mapping.directionName ?? mapping.directionId}`)
    }
    done += 1
    options.onProgress?.(done, total, `方向：${mapping.directionName ?? mapping.directionId}`)
  }

  // 卖点 / 风格挂在方向上（比产品级准：灵境的方向文案就是这一层写的）
  if (options.wantPresets) {
    for (const direction of archive.directions) {
      const ownerId = plan.directionIds.get(direction.id)
      if (!ownerId || !direction.productCopy) continue
      const parsed = parseDirectionCopy(direction.directionName, direction.productCopy)
      const entries: Array<{ kind: SopPreset['kind']; name: string; content: string }> = []
      if (parsed.style) entries.push({ kind: 'style', name: parsed.style.name, content: parsed.style.content })
      for (const point of parsed.points) entries.push({ kind: 'point', name: point.name, content: point.content })
      for (const entry of entries) {
        const hit = presets.find((item) => (
          item.productId === ownerId && item.kind === entry.kind && item.name === entry.name
        ))
        if (hit) {
          if (hit.content !== entry.content) {
            presets[presets.indexOf(hit)] = { ...hit, content: entry.content, updatedAt: Date.now() }
            presetsStats.updated += 1
          }
        } else {
          presets.push({
            id: presetId(ownerId, entry.kind, entry.name),
            productId: ownerId,
            kind: entry.kind,
            name: entry.name,
            content: entry.content,
            updatedAt: Date.now(),
          })
          presetsStats.created += 1
        }
      }
    }
  }

  return {
    nodes: plan.nodes,
    postTemplates,
    deliveryDirs,
    presets,
    tree: { created: plan.created, reused: plan.reused },
    templates: stats,
    delivery,
    presetsStats,
    files: archive.files,
    missing: archive.missing,
  }
}

/** 文件识别结果的一句话说明，导入前给用户确认用 */
export function describeArchiveFiles(files: Array<{ name: string; kind: LingjingArchiveKind }>): string {
  return files.map((item) => `${item.name} → ${KIND_LABEL[item.kind]}`).join('；')
}
