import type { InputImage } from '../types'

/**
 * 本次生成用到的参考图里，有哪些是「从台账发送到画廊」带过来的。
 *
 * 台账里的图有明确出处（生成它的那张任务卡）。拿去画廊当参考图再生成时，
 * 新卡应该挂在那张卡下面，否则血缘链在「拿去参考」这一步就断了。
 *
 * 返回去重后的父卡 id（同一次生成可能带了好几张同源的图）；
 * 外来素材没有任务卡，映射里根本没有它的 key，自然被跳过。
 */
export function lineageParentsOf(
  images: InputImage[],
  parentsByImageId: Record<string, string>,
): string[] {
  const out = new Set<string>()
  for (const img of images) {
    const parent = parentsByImageId[img.id]
    if (parent) out.add(parent)
  }
  return [...out]
}
