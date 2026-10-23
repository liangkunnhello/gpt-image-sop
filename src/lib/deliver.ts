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
}

/**
 * 一张卡里真正要交付的成品图 id。
 *
 * 回收站里的单张图不交付：交付是「对外的成品」，
 * 而进回收站意味着用户已经判定它不要了。
 */
export function deliverableOutputImages(task: Pick<TaskRecord, 'outputImages' | 'trashedOutputImages'>): string[] {
  const trashed = new Set(task.trashedOutputImages ?? [])
  return (task.outputImages ?? []).filter((id) => id && !trashed.has(id))
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
}

/** 一张卡交付用的文件夹名，规则与下载完全一致 */
export function cardFolderName(task: TaskRecord, context: DeliverContext): string {
  const { directions, template, custom } = context
  const nameOf = (id: string) => (id ? directions.find((node) => node.id === id)?.name ?? '' : '')
  const name = buildTaskFolderName(template, {
    date: new Date(task.createdAt),
    product: nameOf(productIdForDirection(directions, task.sopDirectionId)),
    direction: nameOf(task.sopDirectionId ?? ''),
    size: task.params?.size,
    sopName: task.sopName,
    custom,
  })
  return name || `task-${task.id.slice(0, 8)}`
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

/** 成品文件名：序号-分辨率，与「再次后处理」落盘一致，重跑同名覆盖 */
function outputFileName(index: number, task: TaskRecord, ext: string): string {
  const label = (task.params?.size ?? '').trim().replace(/[×*]/g, 'x') || 'auto'
  return `${String(index + 1).padStart(2, '0')}-${label}.${ext}`.replace(/[\\/:*?"<>|]/g, '_')
}

/**
 * 把一张任务卡交付到它的交付地址。
 *
 * 同一张卡的多个任务共用文件夹名（cardFolderName 只取卡级信息），
 * 所以每条提示词完成时各交付一次，结果都落在同一个文件夹里，同名覆盖。
 */
export async function deliverTaskCard(task: TaskRecord, context: DeliverContext): Promise<DeliverResult> {
  const images = deliverableOutputImages(task)
  if (!images.length) return { ok: false, written: 0, nothingToDeliver: true }

  const resolved = resolveDeliveryDir(context.deliveryDirs, context.directions, task.sopDirectionId)
  const targetDir = resolved?.path ?? context.fallbackDir?.trim()
  if (!targetDir) return { ok: false, written: 0, noTarget: true }

  const folder = cardFolderName(task, context)

  // 网页版：File System Access，需要用户手势，自动交付时由调用方决定是否跳过
  if (!isTauri) {
    if (!supportsWebFolder()) return { ok: false, written: 0, error: '当前浏览器不支持写入文件夹' }
    const root = await pickWebFolderRoot()
    if (!root) return { ok: false, written: 0, error: '已取消选择文件夹' }
    const files: Array<{ name: string; blob: Blob }> = []
    let read = 0
    for (const [index, imageId] of images.entries()) {
      const entry = await readImageBytes(imageId)
      if (!entry) continue
      const blob = new Blob([new Uint8Array(entry.bytes)] as BlobPart[], { type: MIME_BY_EXT[entry.ext] ?? 'image/png' })
      files.push({ name: outputFileName(read, task, entry.ext), blob })
      read += 1
    }
    if (!files.length) return { ok: false, written: 0, error: '没有可交付的图片文件' }
    try {
      const actual = await writeFilesToWebFolder(root, folder, files)
      return { ok: true, written: files.length, folder: actual, location: `${root.name}/${actual}` }
    } catch (err) {
      return { ok: false, written: 0, error: err instanceof Error ? err.message : '写入文件夹失败' }
    }
  }

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
  for (const imageId of images) {
    const entry = await readImageBytes(imageId)
    if (!entry) continue
    try {
      // overwrite=true：重跑时覆盖同名成品，不留「名称 (2)」
      await saveFileToDir(dir, entry.bytes, outputFileName(written, task, entry.ext), undefined, folderInfo.name, true)
      written += 1
    } catch (err) {
      console.error('交付写入失败：', err)
    }
  }
  if (!written) return { ok: false, written: 0, folder: folderInfo.name, error: '图片写入失败' }
  return { ok: true, written, folder: folderInfo.name, location: folderInfo.path }
}

/**
 * 整张卡交付（跨任务聚合）。
 *
 * 每条提示词完成时会各自交付自己的那几张图；这里用于「立即交付」这类手动入口，
 * 把同卡的所有任务一次性写全，避免用户手动补最后一张。
 */
export async function deliverCardGroup(task: TaskRecord, context: DeliverContext): Promise<DeliverResult> {
  const group = tasksOfCard(context.tasks, task)
  if (!group.length) return { ok: false, written: 0, error: '找不到这张卡的任务' }
  let written = 0
  let last: DeliverResult = { ok: false, written: 0 }
  for (const item of group) {
    const result = await deliverTaskCard(item, context)
    written += result.written
    last = result
  }
  return { ...last, written, ok: written > 0 }
}

/** 供 UI 显示：这张卡的交付地址解析结果（含继承来源） */
export function resolveCardDeliveryDir(task: TaskRecord, context: DeliverContext) {
  const resolved = resolveDeliveryDir(context.deliveryDirs, context.directions, task.sopDirectionId)
  if (resolved) return resolved
  const fallback = context.fallbackDir?.trim()
  return fallback ? { ownerId: '', path: fallback } : null
}
