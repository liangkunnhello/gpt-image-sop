/**
 * 灯箱的导航列表。
 *
 * 为什么要「钉住」：图被移入回收站后，详情页会把它从画廊里隐藏 —— 如果灯箱的列表跟着变，
 * 当前那张直接从中消失，画面就会退出或跳到别处，用户按一下删除就「被踢出去」了。
 *
 * 图片本体在回收站期间仍留在库里（可还原），所以让灯箱继续显示这张是安全的；
 * 关掉灯箱再回来，画廊里就已经看不到它了。
 *
 * @param pinned  打开灯箱那一刻的列表（打开期间不变）
 * @param current 当前看的图
 * @param latest  上层最新的列表
 * @param active  灯箱是否还开着
 */
export function pinnedNavList(
  pinned: string[],
  current: string | null,
  latest: string[],
  active: boolean,
): string[] {
  if (!active || !current) return latest
  // 当前的图不在钉住的列表里（换了入口、列表被别处替换过），用最新的
  if (!pinned.includes(current)) return latest
  return pinned
}

/**
 * 按删除键之后，下一步该看哪张。
 *
 * - 删的不是当前这张：不动
 * - 删的是当前这张：优先往后（下一张），已经是最后一张就往前（上一张）
 * - 整组只剩这一张：停留在这张（继续显示，等用户自己关掉）
 */
export function nextIndexAfterDelete(list: string[], current: string): number {
  const index = list.indexOf(current)
  if (index < 0) return -1
  if (list.length <= 1) return index
  if (index < list.length - 1) return index + 1
  return index - 1
}
