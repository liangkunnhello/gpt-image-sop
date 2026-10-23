/**
 * 配置交付地址时的目录选择与打开。
 *
 * 与 saveFile 那条链路分开：这里只「选一个位置存进设置」或「打开一个已存的位置」，
 * 不涉及写入。真正的写入仍由 deliver.ts 走 save_dir_use（会再校验一次越界与可写）。
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './platform'

/** 弹出目录选择框，返回所选绝对路径；用户取消返回 null */
export async function pickDirectoryPath(): Promise<string | null> {
  if (!isTauri) throw new Error('网页版没有本地目录可选择')
  return await invoke<string | null>('pick_directory')
}

/** 在资源管理器中打开一个目录 */
export async function openDirectoryPath(path: string): Promise<void> {
  if (!isTauri) throw new Error('网页版没有本地目录可打开')
  await invoke('open_directory', { path })
}
