/**
 * 「交付」：把一张任务卡的全部成品图复制到一个按命名规范建好的文件夹里。
 *
 * 与下载的区别：
 * - 目标是用户事先在业务树上配置好的「交付地址」，不需要每次选目录；
 * - 一张卡（同一 sopJobId 的多个任务）只对应一个文件夹，多次交付复用同一个文件夹、同名覆盖；
 * - 进回收站的单张图不参与交付。
 *
 * 这里只做「复制」：应用内数据库始终保留原图，画廊、复用配置、再次后处理都还依赖它。
 * 交付目录被清空或断开，也不会影响应用内的数据。
 */

import type { SopDirectionNode, TaskRecord } from '../types'
import { productIdForDirection } from './applyPostTemplate'
import { base64ToBytes } from './dataUrl'
import { getImageFile } from './dbTauri'
import { getStoredImageRecord } from './imageBlob'
import { resolveDeliveryDir } from './deliveryDir'
import { createSaveFolder, saveFileToDir, useSaveDir, type SaveDir } from './saveFile'
import { buildTaskFolderName } from './taskFolderName'
import { imageSizeFromBytes } from './imageSizeBytes'
import { isTauri } from './platform'
import { pickWebFolderRoot, supportsWebFolder, writeFilesToWebFolder } from './webFolder'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** 交付结果，供详情页与 Toast 展示 */
export interface DeliverResult {
  ok: boolean
  /** 实际写入的文件数 */
  written: number
  /** 这次应该写多少张（整卡交付时是全部可交付图的数量），用来识别「只写了部分」 */
  expected?: number
  /** 交付到的绝对路径（网页版为「根目录名/文件夹名」） */
  location?: string
  /** 文件夹名 */
  folder?: string
  /** 失败原因 */
  error?: string
  /** true 表示三级都没配交付地址，且没有可回退的地址 */
  noTarget?: boolean
  /** 该卡全部图都在回收站里，没有可交付的内容 */
  nothingToDeliver?: boolean
  /**
   * 这次实际写出的文件（imageId → 文件名）。
   *
   * 记到任务上之后，图片进回收站时就能精确删掉交付文件夹里的那一份，
   * 不用事后按命名规则去猜序号。
   */
  files?: Array<{ imageId: string; name: string }>
}

/**
 * 一张卡可交付的成品图。
 *
 * 排除三种：回收站里的、人工改判为不合格的、调用方明确要求排除的（自动质检判不合格）。
 * 回收站里的不交付：交付是「对外的成品」，进回收站意味着用户已经判定它不要了。
 * 自动质检结果只存在内存里，所以由调用方算好集合传进来，这个函数保持纯函数。
 */
export function deliverableOutputImages(
  task: Pick<TaskRecord, 'outputImages' | 'trashedOutputImages' | 'qcVerdicts'>,
  excludeImageIds?: Set<string>,
) {
  const trashed = new Set(task.trashedOutputImages ?? [])
  const overrides = task.qcVerdicts ?? {}
  return (task.outputImages ?? []).filter((id) => (
    id && !trashed.has(id) && overrides[id] !== 'fail' && !excludeImageIds?.has(id)
  ))
}

/** 一张卡的全部任务（同一 sopJobId 归一张卡），未删除的才算 */
export function tasksOfCard(tasks: TaskRecord[], task: Pick<TaskRecord, 'id' | 'sopJobId'>): TaskRecord[] {
  const key = task.sopJobId ?? task.id
  return tasks.filter((item) => !item.deletedAt && (item.sopJobId ?? item.id) === key)
}

export interface DeliverContext {
  tasks: TaskRecord[]
  directions: SopDirectionNode[]
  deliveryDirs: Record<string, string>
  /** 文件夹命名模板（设置里的 taskFolderTemplate） */
  template: string
  custom?: string
  /** 三级都没配交付地址时回退用的地址；没有则返回 noTarget */
  fallbackDir?: string
  /**
   * 第一次给某张卡用某个文件夹名时回调，调用方负责把它记到任务上（`deliverFolder`）。
   *
   * 不在这里直接写库：这个模块要保持纯逻辑，写库与状态同步归 store。
   */
  claimCardFolder?: (cardKey: string, folder: string) => void
}

/** 一张卡的标识：同一 sopJobId 的多条任务算一张卡 */
export function cardKeyOf(task: Pick<TaskRecord, 'id' | 'sopJobId'>): string {
  return task.sopJobId ?? task.id
}

/** 比较两个交付地址是否同一个目录（忽略末尾分隔符与大小写差异） */
function sameDir(a: string | undefined, b: string | undefined): boolean {
  const norm = (value: string | undefined) => (value ?? '').trim().replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 一张卡交付用的文件夹名，规则与下载完全一致。
 *
 * `sizeOverride` 传「成品文件的真实尺寸」：后处理会把成品重画成模板尺寸，
 * 用 task.params.size（请求尺寸）命名会和文件实际尺寸对不上。
 */
export function cardFolderName(task: TaskRecord, context: DeliverContext, sizeOverride?: string): string {
  const { directions, template, custom } = context
  const nameOf = (id: string) => (id ? directions.find((node) => node.id === id)?.name ?? '' : '')
  const name = buildTaskFolderName(template, {
    date: new Date(task.createdAt),
    product: nameOf(productIdForDirection(directions, task.sopDirectionId)),
    direction: nameOf(task.sopDirectionId ?? ''),
    size: sizeOverride?.trim() || task.params?.size,
    sopName: task.sopName,
    // 本次文案排在卖点前：它才是这一批临时换上去的那套字
    copy: task.inputSnapshot?.customCopy,
    pointName: task.sopPointName,
    custom,
  })
  return name || `task-${task.id.slice(0, 8)}`
}

/** 占位结果：base 是按模板算出来的名字，folder 是最终可用的那个 */
export interface CardFolderClaim {
  base: string
  folder: string
  /** true 表示这个名字是这次新占的，调用方应该记到任务上 */
  isNew: boolean
}

/**
 * 定下这张卡最终用哪个交付文件夹名 —— 解决「同一套配置跑两次，两张卡互相覆盖」。
 *
 * 规则：
 * 1. 这张卡已经占过一个名字（任务上有 `deliverFolder`）且仍以当前模板名为前缀 → 直接用，
 *    重交付就是覆盖自己上次那套，不会堆出 -02、-03；
 * 2. 否则从模板名开始找第一个**没有被同一个交付目录下的其他卡占用**的名字：`名字` → `名字-02` → `名字-03`；
 * 3. 交付目录不同的卡不算冲突（各写各的目录，同名也不打架）。
 */
export function resolveCardFolderName(
  task: TaskRecord,
  context: DeliverContext,
  sizeOverride?: string,
): CardFolderClaim {
  const base = cardFolderName(task, context, sizeOverride)
  const key = cardKeyOf(task)
  const group = tasksOfCard(context.tasks, task)
  const own = group.map((item) => item.deliverFolder).find(Boolean)
  if (own && (own === base || own.startsWith(`${base}-`))) return { base, folder: own, isNew: false }

  const targetDir = resolveDeliveryDir(context.deliveryDirs, context.directions, task.sopDirectionId)?.path
    ?? context.fallbackDir
  const used = new Set<string>()
  for (const item of context.tasks) {
    if (item.deletedAt) continue
    if (cardKeyOf(item) === key) continue
    if (!item.deliverFolder) continue
    const itemDir = resolveDeliveryDir(context.deliveryDirs, context.directions, item.sopDirectionId)?.path
      ?? context.fallbackDir
    if (!sameDir(itemDir, targetDir)) continue
    used.add(item.deliverFolder)
  }

  let folder = base
  for (let index = 2; used.has(folder) && index < 100; index += 1) {
    folder = `${base}-${String(index).padStart(2, '0')}`
  }
  return { base, folder, isNew: folder !== own }
}

/**
 * 拼「交付地址 + 卡文件夹名」。
 *
 * 交付地址是用户手选的绝对路径，末尾可能带分隔符；跟着它的写法用同一套分隔符，
 * 免得 Windows 上出现 `D:\交付/卡名` 这种看着别扭的混合路径（虽然系统能认）。
 */
export function joinDeliveryPath(dir: string, folder: string): string {
  const base = dir.trim().replace(/[\\/]+$/, '')
  if (!base) return folder
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${sep}${folder}`
}

/** 一张卡的交付位置：交付地址 + 卡文件夹名，供「打开交付文件夹」使用 */
export interface CardDeliveryLocation {
  /** 交付地址（三级继承解析，或兜底的默认保存地址） */
  dir: string
  /** 卡文件夹名，与交付时用的是同一个函数 */
  folder: string
  /** 卡文件夹完整路径 */
  path: string
  /** 地址来自哪一层；兜底地址为空串 */
  ownerId: string
  /** true 表示用的是兜底的默认保存地址，不是显式配的交付地址 */
  isFallback: boolean
}

/**
 * 解析这张卡交付到哪：交付地址 + 卡文件夹。
 *
 * 文件夹名里的尺寸取这张卡第一张可交付成品的**真实像素**，与交付写文件时一致；
 * 直接拿 `task.params.size` 会算出另一个文件夹名（后处理会改成品尺寸），打开就找不到。
 */
export async function resolveCardDeliveryLocation(
  task: TaskRecord,
  context: DeliverContext,
): Promise<CardDeliveryLocation | null> {
  const resolved = resolveDeliveryDir(context.deliveryDirs, context.directions, task.sopDirectionId)
  const dir = resolved?.path ?? context.fallbackDir?.trim() ?? ''
  if (!dir) return null

  let sizeOverride: string | undefined
  const first = deliverableOutputImages(task)[0]
  if (first) {
    try {
      const entry = await readImageBytes(first)
      if (entry) sizeOverride = realSizeOf(entry.bytes, task)
    } catch {
      // 读不出来就退回请求尺寸，只影响名字里的尺寸段
    }
  }
  const folder = resolveCardFolderName(task, context, sizeOverride).folder
  return {
    dir,
    folder,
    path: joinDeliveryPath(dir, folder),
    ownerId: resolved?.ownerId ?? '',
    isFallback: !resolved,
  }
}

/**
 * 成品文件名：与文件夹同一套命名模板 + 末尾序号。
 *
 * 为什么要带完整模板而不是只写「序号-尺寸」：交付出去的图会脱离应用单独流转，
 * 光看文件名要能认出是哪天、哪个产品/方向、多大、哪份 SOP 出的。
 * 序号放末尾：同一批图按名称排序时先按日期/产品/方向聚在一起，序号只做卡内区分。
 * 序号取提示词序号（`sopPromptIndex`），保证同一张卡里每个任务的文件名天然不撞，
 * 不会被 overwrite 覆盖成一张。
 */
export function deliverImageFileName(
  sequence: number,
  task: TaskRecord,
  context: DeliverContext,
  realSize: string,
  ext: string,
  /** 用这张卡实际占到的文件夹名当文件名前缀（带 -02 时文件名也跟着带，拷出去也分得清） */
  stemOverride?: string,
): string {
  const stem = stemOverride?.trim() || cardFolderName(task, context, realSize) || `task-${task.id.slice(0, 8)}`
  // Windows 单段文件名上限 255，留出扩展名与序号余量；先截模板再拼序号，序号不会被截掉
  const name = `${stem.slice(0, 170)}-${String(sequence).padStart(2, '0')}`
  return `${name}.${ext}`.replace(/[\\/:*?"<>|]/g, '_')
}

/**
 * 这条任务在卡内该占第几号。
 *
 * 优先用 `sopPromptIndex`：它与详情页「第 N 条」一致，且同一张卡的多个任务各不相同，
 * 所以「立即交付」逐个任务写文件时不会互相覆盖。普通任务没有这个字段，
 * 才退回调用方累加的 offset。
 */
function sequenceBase(task: TaskRecord, indexOffset?: number): number {
  return task.sopPromptIndex && task.sopPromptIndex > 0 ? task.sopPromptIndex - 1 : (indexOffset ?? 0)
}

/** 从图片字节读真实尺寸，读不出来才退回请求尺寸 */
function realSizeOf(bytes: Uint8Array, task: TaskRecord): string {
  const size = imageSizeFromBytes(bytes)
  return size ? `${size.width}x${size.height}` : (task.params?.size ?? '')
}

/** 取一张图的可写字节；客户端优先走文件，网页版走 Blob 记录 */
async function readImageBytes(imageId: string): Promise<{ ext: string; bytes: Uint8Array } | null> {
  if (isTauri) {
    const file = await getImageFile(imageId)
    if (!file) return null
    const ext = file.meta.mime?.split('/')[1] ?? 'png'
    return { ext, bytes: file.bytes }
  }
  const record = await getStoredImageRecord(imageId)
  if (!record) return null
  if (record.blob) {
    const ext = record.blob.type.split('/')[1] || 'png'
    return { ext, bytes: new Uint8Array(await record.blob.arrayBuffer()) }
  }
  if (record.dataUrl) {
    const match = record.dataUrl.match(/^data:image\/(\w+);base64,/)
    return { ext: match?.[1] ?? 'png', bytes: base64ToBytes(record.dataUrl.replace(/^data:[^;]+;base64,/, '')) }
  }
  return null
}

/**
 * 把一张任务卡交付到它的交付地址。
 *
 * 同一张卡的多个任务共用文件夹名（cardFolderName 只取卡级信息），
 * 所以每条提示词完成时各交付一次，结果都落在同一个文件夹里。
 * 文件名带提示词序号，不同任务不会互相覆盖；重跑同一张时同名覆盖。
 *
 * `indexOffset`：没有 `sopPromptIndex` 的普通任务，由调用方累加序号用。
 */
export async function deliverTaskCard(
  task: TaskRecord,
  context: DeliverContext,
  options?: { indexOffset?: number; excludeImageIds?: Set<string>; folderOverride?: string },
): Promise<DeliverResult> {
  const images = deliverableOutputImages(task, options?.excludeImageIds)
  if (!images.length) return { ok: false, written: 0, nothingToDeliver: true }

  const resolved = resolveDeliveryDir(context.deliveryDirs, context.directions, task.sopDirectionId)
  const targetDir = resolved?.path ?? context.fallbackDir?.trim()
  if (!targetDir) return { ok: false, written: 0, noTarget: true }

  const seqBase = sequenceBase(task, options?.indexOffset)

  // 网页版：File System Access，需要用户手势，自动交付时由调用方决定是否跳过
  if (!isTauri) {
    if (!supportsWebFolder()) return { ok: false, written: 0, error: '当前浏览器不支持写入文件夹' }
    const root = await pickWebFolderRoot()
    if (!root) return { ok: false, written: 0, error: '已取消选择文件夹' }
    // 文件夹名要在拼文件名之前定下来，先读第一张拿真实尺寸
    let firstSize = ''
    for (const imageId of images) {
      const entry = await readImageBytes(imageId)
      if (!entry) continue
      firstSize = realSizeOf(entry.bytes, task)
      break
    }
    // 同名卡按模板算出的名字会重复，resolveCardFolderName 跳过已被别的卡占用的（-02、-03）
    const claim = resolveCardFolderName(task, context, firstSize)
    const folder = options?.folderOverride ?? claim.folder
    if (!options?.folderOverride && claim.isNew) context.claimCardFolder?.(cardKeyOf(task), folder)
    const files: Array<{ imageId: string; name: string; blob: Blob }> = []
    let read = 0
    for (const imageId of images) {
      const entry = await readImageBytes(imageId)
      if (!entry) continue
      const size = realSizeOf(entry.bytes, task)
      const blob = new Blob([new Uint8Array(entry.bytes)] as BlobPart[], { type: MIME_BY_EXT[entry.ext] ?? 'image/png' })
      const name = deliverImageFileName(seqBase + read + 1, task, context, size, entry.ext, folder)
      files.push({ imageId, name, blob })
      read += 1
    }
    if (!files.length) return { ok: false, written: 0, error: '没有可交付的图片文件' }
    try {
      const actual = await writeFilesToWebFolder(root, folder, files)
      return {
        ok: true,
        written: files.length,
        folder: actual,
        location: `${root.name}/${actual}`,
        files: files.map(({ imageId, name }) => ({ imageId, name })),
      }
    } catch (err) {
      return { ok: false, written: 0, error: err instanceof Error ? err.message : '写入文件夹失败' }
    }
  }

  // 文件夹名要在建目录之前定下来，先读第一张拿真实尺寸
  let firstSize = ''
  for (const imageId of images) {
    const entry = await readImageBytes(imageId)
    if (!entry) continue
    firstSize = realSizeOf(entry.bytes, task)
    break
  }
  // 两张「同名同内容」的卡按模板算出来的名字会一模一样，交付时互相覆盖；
  // resolveCardFolderName 会跳过已被别的卡占用的名字（-02、-03），并把新名字记下来
  const claim = resolveCardFolderName(task, context, firstSize)
  const folder = options?.folderOverride ?? claim.folder
  if (!options?.folderOverride && claim.isNew) context.claimCardFolder?.(cardKeyOf(task), folder)

  let dir: SaveDir
  try {
    dir = await useSaveDir(targetDir)
  } catch (err) {
    return { ok: false, written: 0, error: typeof err === 'string' ? err : `交付地址不可用：${String(err)}` }
  }

  let folderInfo
  try {
    // reuse=true：同一张卡反复交付落在同一个文件夹，不堆 -02、-03
    folderInfo = await createSaveFolder(dir, folder, true)
  } catch (err) {
    return { ok: false, written: 0, error: typeof err === 'string' ? err : '创建交付文件夹失败' }
  }

  let written = 0
  const files: Array<{ imageId: string; name: string }> = []
  for (const imageId of images) {
    const entry = await readImageBytes(imageId)
    if (!entry) continue
    const name = deliverImageFileName(seqBase + written + 1, task, context, realSizeOf(entry.bytes, task), entry.ext, folder)
    try {
      // overwrite=true：重跑时覆盖同名成品，不留「名称 (2)」
      await saveFileToDir(
        dir,
        entry.bytes,
        name,
        undefined,
        folderInfo.name,
        true,
      )
      written += 1
      files.push({ imageId, name })
    } catch (err) {
      console.error('交付写入失败：', err)
    }
  }
  if (!written) return { ok: false, written: 0, folder: folderInfo.name, error: '图片写入失败' }
  return { ok: true, written, folder: folderInfo.name, location: folderInfo.path, files }
}

/**
 * 整张卡交付（跨任务聚合）。
 *
 * 每条提示词完成时会各自交付自己的那几张图；这里用于「立即交付」这类手动入口，
 * 把同卡的所有任务一次性写全，避免用户手动补最后一张。
 */
export async function deliverCardGroup(
  task: TaskRecord,
  context: DeliverContext,
  options?: { excludeImageIds?: Set<string> },
): Promise<DeliverResult> {
  const group = tasksOfCard(context.tasks, task)
  if (!group.length) return { ok: false, written: 0, error: '找不到这张卡的任务' }
  let written = 0
  let cursor = 0
  // 该卡一共该写多少张：写少了要如实报出来，不能只说「已交付 N 张」让人以为全好了
  const expected = group.reduce((sum, item) => sum + deliverableOutputImages(item, options?.excludeImageIds).length, 0)
  let last: DeliverResult = { ok: false, written: 0 }
  let folderOverride: string | undefined
  const files: Array<{ imageId: string; name: string }> = []
  for (const item of group) {
    // 提示词序号自带唯一编号的走自己的，普通任务用累计游标接着排
    const result = await deliverTaskCard(item, context, {
      indexOffset: cursor,
      excludeImageIds: options?.excludeImageIds,
      folderOverride,
    })
    // 同卡各任务共用一个文件夹：第一张定下来后直接传下去，
    // 否则刚占到的名字在 context.tasks 快照里还没有，后面的任务会重新算出另一个
    if (result.folder) folderOverride = result.folder
    if (result.files?.length) files.push(...result.files)
    written += result.written
    cursor += result.written
    last = result
  }
  return { ...last, written, expected, ok: written > 0, files: files.length ? files : undefined }
}

/** 供 UI 显示：这张卡的交付地址解析结果（含继承来源） */
export function resolveCardDeliveryDir(task: TaskRecord, context: DeliverContext) {
  const resolved = resolveDeliveryDir(context.deliveryDirs, context.directions, task.sopDirectionId)
  if (resolved) return resolved
  const fallback = context.fallbackDir?.trim()
  return fallback ? { ownerId: '', path: fallback } : null
}

/** 交付地址下的一个成品文件：删回收站图时按这两个值去删 */
export interface DeliveredFileRef {
  /** 交付地址（绝对路径） */
  dir: string
  /** 相对交付地址的「卡文件夹/文件名」 */
  relative: string
}

/**
 * 这张图在交付文件夹里对应哪个文件。
 *
 * 交付当时记过文件名就直接用（唯一准确的口径）；老数据没记过，按卡的交付顺序
 * 重放一遍推出它的序号，扩展名取图片本体，取不到就把常见几种都列出来
 * （删除时文件不存在会被当成「本来就没有」，不会误删）。
 *
 * 必须在把它标记进回收站**之前**调用：重放序号用的是「当时会交付的那批图」，
 * 已经进回收站的图不参与交付，标记之后再算会少一位。
 */
export async function deliveredFileRefsOf(
  task: TaskRecord,
  imageId: string,
  context: DeliverContext,
): Promise<DeliveredFileRef[]> {
  const dir = resolveDeliveryDir(context.deliveryDirs, context.directions, task.sopDirectionId)?.path
    ?? context.fallbackDir?.trim()
  const folder = (task.deliverFolder ?? cardFolderName(task, context)).trim()
  if (!dir || !folder) return []

  const recorded = task.deliveredFileNames?.[imageId]
  if (recorded) return [{ dir, relative: `${folder}/${recorded}` }]

  const group = tasksOfCard(context.tasks, task)
  let cursor = 0
  let seq = 0
  for (const item of group) {
    // 重放用的是「交付时的可交付列表」：回收站不参与，人工改判不合格的也不交
    const images = deliverableOutputImages({ ...item, trashedOutputImages: undefined })
    const index = images.indexOf(imageId)
    if (index >= 0) {
      seq = sequenceBase(item, cursor) + index + 1
      break
    }
    cursor += images.length
  }
  if (!seq) return []

  // 扩展名从图片本体取；取不到（网页版没缓存、图已被删）就把常见几种都列出来
  let ext = ''
  try {
    ext = (await readImageBytes(imageId))?.ext ?? ''
  } catch {
    ext = ''
  }
  const exts = ext ? [ext] : ['jpg', 'jpeg', 'png', 'webp']
  return exts.map((ext) => ({
    dir,
    relative: `${folder}/${deliverImageFileName(seq, task, context, '', ext, folder)}`,
  }))
}
