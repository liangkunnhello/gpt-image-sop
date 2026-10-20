import { isTauri } from './platform'

const SIDECAR = 'http://127.0.0.1:7799'

export interface OpenFolderResult {
  ok: boolean
  path?: string
  error?: string
  /** true 表示只是网页版，没有本地目录可开 */
  webOnly?: boolean
}

/**
 * 打开成品图所在文件夹。
 * 优先让本地服务去开（它知道客户端数据目录，网页版也能用）；
 * 本地服务没起时，客户端里退回打开应用数据目录；纯网页版则返回提示。
 */
export async function openImagesFolder(): Promise<OpenFolderResult> {
  try {
    const res = await fetch(`${SIDECAR}/api/open-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'images' }),
      signal: AbortSignal.timeout(4000),
    })
    const json = await res.json() as { ok?: boolean; path?: string; error?: string }
    if (json?.ok) return { ok: true, path: json.path }
    if (json?.path) return { ok: false, path: json.path, error: json.error || '打开失败' }
  } catch {
    // 本地服务没开，继续往下试
  }

  if (isTauri) {
    try {
      const { openStorageDir } = await import('./dbTauri')
      await openStorageDir()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ok: false, webOnly: true, error: '网页版图片存在浏览器里，没有本地文件夹' }
}
