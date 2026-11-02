/**
 * 文件夹质检：把一个目录里的图片读出来，直接送质检模型。
 *
 * 交付目录常常在网盘 / 共享上（`\\192.168.x.x\...`），这些图不在数据库里，
 * 也没有任务卡，所以不能走「任务卡质检」那条路 —— 这里单独读取文件本身。
 *
 * 客户端读盘走 Rust 的 `read_dir_images`（只读、限张数与单张体积）；
 * 网页版没有本地文件系统权限，退到「选择文件夹」让浏览器读 File 对象。
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './platform'

export interface FolderImage {
  name: string
  dataUrl: string
  bytes: number
}

/** 与 Rust 侧的 DIR_IMAGE_EXTS 保持一致 */
export const FOLDER_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'] as const

export function isImageFileName(name: string): boolean {
  const index = name.lastIndexOf('.')
  if (index <= 0) return false
  const ext = name.slice(index + 1).toLowerCase()
  return (FOLDER_IMAGE_EXTS as readonly string[]).includes(ext)
}

/**
 * 像不像一个目录路径：盘符（`D:\x`）、UNC（`\\server\share`）、POSIX 绝对路径。
 * 只用于给出「这看起来不是路径」的即时提示，真正的校验在 Rust 侧。
 */
export function isFolderPathLike(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  if (text.startsWith('\\\\')) return /\S/.test(text.slice(2))
  if (/^[a-zA-Z]:[\\/]/.test(text)) return text.length > 3
  return text.startsWith('/') && text.length > 1
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 客户端：读一个绝对路径（含 UNC 网络共享）下的图片 */
export async function readFolderImages(path: string, limit?: number): Promise<FolderImage[]> {
  if (!isTauri) throw new Error('网页版没有本地目录权限，请用「选择文件夹」')
  const images = await invoke<Array<{ name: string; data_url: string; bytes: number }>>('read_dir_images', {
    path,
    limit,
  })
  return images.map((item) => ({ name: item.name, dataUrl: item.data_url, bytes: item.bytes }))
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    reader.readAsDataURL(file)
  })
}

/**
 * 网页版兜底：用户用「选择文件夹」挑一个目录，浏览器给出里面的 File 列表。
 * 只保留图片、按文件名排序，最多 limit 张。
 */
export async function folderImagesFromFiles(files: File[], limit = 200): Promise<FolderImage[]> {
  const picked = files
    .filter((file) => isImageFileName(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .slice(0, limit)
  const images: FolderImage[] = []
  for (const file of picked) {
    images.push({ name: file.name, dataUrl: await fileToDataUrl(file), bytes: file.size })
  }
  return images
}

/** 汇总质检结论：过 / 不过 / 待人工 / 出错 */
export function summarizeVerdicts(verdicts: string[]): { pass: number; fail: number; unsure: number; error: number } {
  const summary = { pass: 0, fail: 0, unsure: 0, error: 0 }
  for (const verdict of verdicts) {
    if (verdict === 'pass') summary.pass += 1
    else if (verdict === 'fail') summary.fail += 1
    else if (verdict === 'unsure') summary.unsure += 1
    else summary.error += 1
  }
  return summary
}
