import type { AppearanceTheme } from '../types'

/** 设置页与快捷切换共用的选项文案 */
export const APPEARANCE_OPTIONS: Array<{ value: AppearanceTheme; label: string; hint: string }> = [
  { value: 'default', label: '默认', hint: '纯色面板，和现在一致' },
  { value: 'glass', label: '玻璃', hint: '液态玻璃面板，背后有流动的光晕' },
]

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === 'default' || value === 'glass'
}

/**
 * 把主题写到根节点，CSS 与个别组件都从这里读，
 * 不用每个组件各传一遍 prop。
 */
export function applyAppearance(theme: AppearanceTheme) {
  const root = document.documentElement
  if (theme === 'glass') root.dataset.appearance = 'glass'
  else delete root.dataset.appearance
}

/** 项目用 Tailwind 的 media 暗色模式，没有手动开关，这里跟它保持一致 */
export function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
