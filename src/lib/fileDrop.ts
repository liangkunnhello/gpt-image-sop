/** 拖放文本文件（.md 等）到编辑器时的共用判断 */

export const TEXT_FILE_PATTERN = /\.(md|markdown|txt)$/i

/** 本次拖拽里是否带着文件（纯文字拖拽不要拦，否则选区拖不动） */
export function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types).includes('Files')
}

/** 取第一个可导入的文本文件 */
export function firstTextFile(files: FileList | null | undefined): File | null {
  if (!files?.length) return null
  return Array.from(files).find((file) => TEXT_FILE_PATTERN.test(file.name)) ?? null
}
