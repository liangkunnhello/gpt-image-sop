import { call } from './dbTauri'
import { isTauri } from './platform'
import { buildTaskFolderName, type TaskCopySource } from './taskFolderName'
import type { TaskRecord } from '../types'
import type { SopDirectionNode } from '../types'

/** 后处理成品的文件名：序号 + 分辨率，重跑时同名覆盖 */
export function finishedFileName(index: number, size: string | undefined, format: string | undefined): string {
  const ext = format === 'webp' ? 'webp' : format === 'png' ? 'png' : 'jpg'
  const label = (size ?? '').trim() || 'auto'
  return `${String(index + 1).padStart(2, '0')}-${label}.${ext}`.replace(/[\\/:*?"<>|]/g, '_')
}

function nameOf(directions: SopDirectionNode[], id: string | undefined): string {
  if (!id) return ''
  return directions.find((node) => node.id === id)?.name ?? ''
}

/**
 * 一个任务卡一个文件夹。
 * 文件夹名沿用设置里的「任务文件夹命名」模板，和导出用的是同一套规则。
 */
export function finishedFolderName(
  task: Pick<TaskRecord, 'id' | 'createdAt' | 'params' | 'sopName' | 'sopPointName' | 'sopDirectionId'> & TaskCopySource,
  directions: SopDirectionNode[],
  template: string,
  custom: string | undefined,
  productId: string | undefined,
): string {
  const name = buildTaskFolderName(template, {
    date: new Date(task.createdAt),
    product: nameOf(directions, productId),
    direction: nameOf(directions, task.sopDirectionId),
    size: task.params?.size,
    sopName: task.sopName,
    copy: task.inputSnapshot?.customCopy,
    pointName: task.sopPointName,
    custom,
  })
  // 极端情况下模板全是空值，退回任务 id，至少不会写进 finished 根目录
  return name || `task-${task.id.slice(0, 8)}`
}

/**
 * 把成品写进 <数据目录>/finished/<任务文件夹>/<文件名>，返回绝对路径。
 * 走 Rust 直写：打包版没有本地 Node 服务，原来那条 /api/save-finished 一直静默失败。
 */
export async function writeFinishedImage(
  folder: string,
  fileName: string,
  dataUrl: string,
): Promise<string | null> {
  if (!isTauri) return null
  try {
    return await call<string>('finished_write', { folder, name: fileName, payload: dataUrl })
  } catch (err) {
    console.error('写出成品图失败：', err)
    return null
  }
}
