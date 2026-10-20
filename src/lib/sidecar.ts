/**
 * 本地后端基址。
 *
 * 后端（批次生图 / 质检 / 重复度 / 图库）已经挂在 Vite dev server 上，见 server/vite-plugin.mjs，
 * 所以同源访问留空即可，不用再单独启动 7799，也不会有跨域。
 *
 * 如果哪天要把后端独立部署，设 VITE_SIDECAR_URL 就行，例如 http://127.0.0.1:7799。
 */
export const SIDECAR = (import.meta.env.VITE_SIDECAR_URL ?? '').replace(/\/+$/, '')

export function sidecarUrl(path: string) {
  return `${SIDECAR}${path}`
}
