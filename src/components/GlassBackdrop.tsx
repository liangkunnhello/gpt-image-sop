import { useEffect, useState } from 'react'
import LiquidGlass from 'liquid-glass-react'

import { prefersDark } from '../lib/appearance'
import { useStore } from '../store'

interface Props {
  /** 跟随宿主的圆角，贴边的容器传 0 */
  cornerRadius?: number
  /** 折射强度：越大边缘的「厚玻璃」越明显 */
  displacementScale?: number
  blurAmount?: number
  saturation?: number
  /** 面板类容器保持 0，否则整块内容会跟着鼠标漂 */
  elasticity?: number
  className?: string
}

/**
 * 液态玻璃背板：只负责画，不包内容。
 *
 * liquid-glass-react 的外层自带 `transform: translate(-50%,-50%)`，
 * 直接把内容包进去会让所有 fixed 后代相对它定位（弹窗、提示都会错位）。
 * 所以这里做成绝对定位的兄弟层，宿主自己加 `relative isolate`，
 * 背板用 -z-10 落在背景之上、内容之下。
 */
export default function GlassBackdrop({
  cornerRadius = 16,
  displacementScale = 44,
  blurAmount = 0.06,
  saturation = 165,
  elasticity = 0,
  className = '',
}: Props) {
  const appearance = useStore((s) => s.settings.appearance)
  const [dark, setDark] = useState(prefersDark)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  if (appearance !== 'glass') return null

  return (
    <span
      aria-hidden
      data-glass-backdrop
      className={`pointer-events-none absolute inset-0 -z-10 block overflow-hidden ${className}`}
      style={{ borderRadius: cornerRadius ? `${cornerRadius}px` : undefined }}
    >
      <LiquidGlass
        cornerRadius={cornerRadius}
        padding="0"
        displacementScale={displacementScale}
        blurAmount={blurAmount}
        saturation={saturation}
        aberrationIntensity={1.2}
        elasticity={elasticity}
        overLight={!dark}
        style={{ position: 'absolute', top: '50%', left: '50%', width: '100%', height: '100%' }}
      >
        <span />
      </LiquidGlass>
    </span>
  )
}
