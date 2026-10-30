/**
 * 左栏宽度的存取。
 *
 * 方向名常常很长（「3D插画-京东硬广」这种），固定 224px 一定被截断，
 * 所以宽度做成可拖。这是纯界面偏好，放 localStorage 就够了，不进数据模型。
 */

const STORAGE_KEY = 'gpt-image-sop:sidebar-width'

/** 下限保证还能放下「全部任务 + 数字」一行 */
export const SIDEBAR_MIN_WIDTH = 180
/** 上限留得宽一些：名字长的时候能一路拖到看得全 */
export const SIDEBAR_MAX_WIDTH = 460
export const SIDEBAR_DEFAULT_WIDTH = 224

export function clampSidebarWidth(value: number) {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)))
}

/** 读上次拖出来的宽度；没有或读坏了就用默认值 */
export function readSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH
  try {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH
  } catch {
    // 隐私模式 / 配额满时 localStorage 会抛，界面不该因此打不开
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export function saveSidebarWidth(width: number) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // 存不进去也不影响本次使用
  }
}
