/**
 * 滚动容器探测。
 *
 * 画廊模式下只有一个任务卡区域滚动（整页不再滚），Agent 模式仍然是整页滚，
 * 所以列表虚拟化、拖选自动滚动这些逻辑不能写死 window，要向上找真正在滚的那一层。
 */

/** 最近的可滚动祖先；找不到时返回 window（整页滚动的老布局） */
export function scrollRootOf(element: Element | null): HTMLElement | Window {
  let node = element?.parentElement ?? null
  while (node) {
    const style = getComputedStyle(node)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
      return node
    }
    node = node.parentElement
  }
  return window
}

export function isWindowRoot(root: HTMLElement | Window): root is Window {
  return root === window
}

/** 滚动容器的视口范围（client 坐标） */
export function scrollRootRect(root: HTMLElement | Window): { top: number; bottom: number; height: number } {
  if (isWindowRoot(root)) return { top: 0, bottom: window.innerHeight, height: window.innerHeight }
  const rect = root.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, height: root.clientHeight }
}

/** 滚动容器当前的滚动量，用来在「视口坐标」和「内容坐标」之间换算 */
export function scrollOffsetInRoot(root: HTMLElement | Window): { x: number; y: number } {
  return isWindowRoot(root)
    ? { x: window.scrollX, y: window.scrollY }
    : { x: root.scrollLeft, y: root.scrollTop }
}

/** 相对滚动容器顶部的偏移，等价于旧代码里的 -getBoundingClientRect().top */
export function scrollTopInRoot(element: Element, root: HTMLElement | Window): number {
  const top = element.getBoundingClientRect().top
  return isWindowRoot(root) ? -top : root.getBoundingClientRect().top - top
}

export function scrollRootBy(root: HTMLElement | Window, top: number) {
  if (isWindowRoot(root)) window.scrollBy({ top, behavior: 'instant' })
  else root.scrollBy({ top, behavior: 'instant' })
}
