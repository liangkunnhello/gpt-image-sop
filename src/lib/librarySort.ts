/**
 * 提示词库的显示顺序：最新的排最上面。
 *
 * 「最新」按 `updatedAt` 算 —— 新建和刚保存过的那条都会跳到顶部，
 * 刚改完想再看一眼时不用往下翻。
 *
 * 不用创建时间：库里的大部分条目是当年一次性导入的，创建时间几乎一样，
 * 按它排等于没排；而且用户心智里「最新改的」就是「最新的」。
 */

export interface SortableByUpdatedAt {
  updatedAt?: number
}

/**
 * 按更新时间倒序，返回新数组（不改入参）。
 * 时间相同或缺失时保持原有相对顺序：稳定排序才能避免列表在重渲染时乱跳。
 */
export function newestFirst<T extends SortableByUpdatedAt>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff = (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0)
      return diff !== 0 ? diff : a.index - b.index
    })
    .map((entry) => entry.item)
}
