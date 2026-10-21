/**
 * 网页端也能按任务卡建文件夹保存。
 *
 * 浏览器没有任意路径写入权限，只有 Chromium 系（Chrome / Edge / WebView2）支持
 * File System Access API：用户在点击后选一次目录，之后可以在这个目录里建子文件夹写文件。
 * 不支持时（Firefox / Safari）返回 null，调用方退回原来的单张下载。
 */

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'write' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

export function supportsWebFolder(): boolean {
  if (typeof window === 'undefined') return false
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

/** 弹出目录选择框；用户取消时返回 null。必须在点击事件里紧接着调用，否则会丢掉用户手势 */
export async function pickWebFolderRoot(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) return null
  try {
    return await picker.call(window, { mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

/** 在根目录下找一个不存在的文件夹名：重名时依次用 -02、-03 */
async function createUniqueFolder(root: FileSystemDirectoryHandle, base: string): Promise<FileSystemDirectoryHandle> {
  for (let n = 1; n <= 999; n += 1) {
    const name = n === 1 ? base : `${base}-${String(n).padStart(2, '0')}`
    try {
      await root.getDirectoryHandle(name)
    } catch {
      return await root.getDirectoryHandle(name, { create: true })
    }
  }
  throw new Error('同名文件夹过多')
}

/** 把一组文件写进 root 下的新文件夹，返回实际使用的文件夹名 */
export async function writeFilesToWebFolder(
  root: FileSystemDirectoryHandle,
  folderName: string,
  files: Array<{ name: string; blob: Blob }>,
): Promise<string> {
  const folder = await createUniqueFolder(root, folderName)
  for (const file of files) {
    const handle = await folder.getFileHandle(file.name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(file.blob)
    await writable.close()
  }
  return folder.name
}
