const SIDECAR = 'http://127.0.0.1:7799'

export interface BackupPayload {
  prompt: string
  size: string
  model?: string
  quality?: string
  title?: string
  product?: string
  /** base64 data URL 列表 */
  images: string[]
}

/**
 * 每出一张图就顺手写一份到桌面客户端的 data.db。
 * 浏览器（含内置预览面板）的存储随时可能丢，data.db 是兜底。
 * 本地服务没开时静默跳过，不影响出图。
 */
export async function backupTaskToClient(payload: BackupPayload): Promise<void> {
  for (const dataUrl of payload.images) {
    try {
      await fetch(`${SIDECAR}/api/save-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, dataUrl }),
        signal: AbortSignal.timeout(30000),
      })
    } catch {
      // 服务没开就算了
    }
  }
}
