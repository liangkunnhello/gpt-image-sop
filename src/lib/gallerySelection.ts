/**
 * 详情页画廊的多选状态：照文件管理器那套（Windows 资源管理器 / macOS 访达）走。
 *
 * - 单击           → 只选这一张（清掉其它）
 * - Ctrl / ⌘ + 单击 → 加选 / 取消加选
 * - Shift + 单击    → 从「上一次点的那张」连选到这张
 * - 空白处拖动      → 框选（把矩形碰到的都选中；按住 Ctrl 时是叠加）
 *
 * 为什么抽成纯函数：这些规则组合起来最容易出边界问题（连选方向、框选与已有的叠加、
 * 列表被筛选变了之后锚点失效），放在组件里只能靠手点，写了也没法回归。
 */

export interface SelectionState {
  /** 已选中的项 id，用数组是为了保持顺序稳定（批量操作按界面顺序执行） */
  ids: string[]
  /**
   * 连选的锚点：最后一次「不按 Shift」点中的那一项。
   * Shift 连选以它为起点；没有锚点时退回选中列表的第一个。
   */
  anchorId: string | null
}

export interface ClickModifiers {
  /** Ctrl（Windows）或 ⌘（macOS）：加选 / 取消 */
  toggle?: boolean
  /** Shift：连选一段 */
  range?: boolean
}

export const EMPTY_SELECTION: SelectionState = { ids: [], anchorId: null }

/**
 * 单击某一项。
 *
 * @param order 当前界面上的完整顺序（框选/连选都按这个顺序算）
 * @param id    点中的那一项
 */
export function clickSelect(
  state: SelectionState,
  order: string[],
  id: string,
  modifiers: ClickModifiers = {},
): SelectionState {
  if (!id || !order.includes(id)) return state

  // Ctrl：在已有集合上加减，锚点跟着走（再加选别的项时 Shift 应该从它开始）
  if (modifiers.toggle) {
    const has = state.ids.includes(id)
    return {
      ids: has ? state.ids.filter((item) => item !== id) : [...state.ids, id],
      anchorId: has ? (state.anchorId === id ? null : state.anchorId) : id,
    }
  }

  // Shift：从锚点连选到这一项。方向无所谓，中间的都要
  if (modifiers.range) {
    const anchor = state.anchorId && order.includes(state.anchorId)
      ? state.anchorId
      : state.ids.length
        ? state.ids[state.ids.length - 1]
        : id
    const from = order.indexOf(anchor)
    const to = order.indexOf(id)
    if (from < 0 || to < 0) return { ids: [id], anchorId: id }
    const start = Math.min(from, to)
    const end = Math.max(from, to)
    return { ids: order.slice(start, end + 1), anchorId: anchor }
  }

  // 普通单击：只留这一张
  return { ids: [id], anchorId: id }
}

/**
 * 框选：把矩形碰到的项全选中。
 *
 * @param baseIds 框选前已选的项（按住 Ctrl 时传当前选择，否则传空数组）
 */
export function boxSelect(
  baseIds: string[],
  hitIds: string[],
  anchorId: string | null = null,
): SelectionState {
  const merged: string[] = []
  for (const id of baseIds) {
    if (!merged.includes(id)) merged.push(id)
  }
  for (const id of hitIds) {
    if (!merged.includes(id)) merged.push(id)
  }
  return {
    ids: merged,
    // 框选后 Shift 的锚点：沿用原来的，没有就用最后一个碰到的
    anchorId: anchorId ?? (hitIds.length ? hitIds[hitIds.length - 1] : null),
  }
}

/** 某项是否选中 */
export function isSelected(state: SelectionState, id: string): boolean {
  return state.ids.includes(id)
}

/**
 * 列表变化后收敛选择。
 *
 * 换筛选条件、图被移入回收站之后，已选里的 id 可能已经不存在了 ——
 * 留着会变成「看不见的选中项」，批量操作会作用到用户以为没选的东西上。
 */
export function pruneSelection(state: SelectionState, order: string[]): SelectionState {
  const keep = state.ids.filter((id) => order.includes(id))
  const anchor = state.anchorId && order.includes(state.anchorId) ? state.anchorId : null
  if (keep.length === state.ids.length && anchor === state.anchorId) return state
  return { ids: keep, anchorId: anchor }
}

/** 全选 / 取消全选（Ctrl+A 与「全选」按钮用） */
export function selectAll(order: string[]): SelectionState {
  if (!order.length) return EMPTY_SELECTION
  return { ids: [...order], anchorId: order[0] }
}

/**
 * 多选时的「当前这张」：右侧参数、工具条看着它。
 *
 * 多选后没有唯一的「当前」，但界面总得有个主展示 —— 取最后选中的那一张，
 * 和文件管理器预览窗格的行为一致（后点的算主）。
 */
export function primarySelectedId(state: SelectionState): string {
  return state.ids.length ? state.ids[state.ids.length - 1] : ''
}

/** 框选用的矩形与项矩形是否有交集（像素坐标，left/top/width/height） */
export interface SelectionRect {
  left: number
  top: number
  width: number
  height: number
}

export function rectIntersects(a: SelectionRect, b: SelectionRect): boolean {
  // 零面积不算碰到：刚按下还没拖动时不该选中任何东西
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top
}

/** 两个像素坐标点 → 规范化的矩形（往哪个方向拖都成立） */
export function rectFromPoints(x1: number, y1: number, x2: number, y2: number): SelectionRect {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}
