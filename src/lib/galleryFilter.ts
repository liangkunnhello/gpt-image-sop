/**
 * 详情页画廊的「按质检标签筛选」。
 *
 * 一版几十张图时，靠肉眼翻着找不合格/重复的太慢，这里按标签算下标，
 * 筛选后仍返回**原始下标**：图片编号、选中态、灯箱翻页都还按原来的顺序走，不会错位。
 */

export type GalleryFilter = 'all' | 'pass' | 'unsure' | 'fail' | 'dup'

export interface GalleryFilterCounts {
  pass: number
  unsure: number
  fail: number
  dup: number
}

/** 某张图的质检结论；没人检查过返回 null */
export type VerdictOf = (imageId: string) => { verdict: 'pass' | 'fail' | 'unsure' } | null
/** 某张图的重复度（0~1）；算不出来返回 0 */
export type DuplicateOf = (imageId: string) => number

/** 每个标签下各有多少张。没有质检结论的图不计入任何标签 */
export function galleryFilterCounts(
  imageIds: string[],
  verdictOf: VerdictOf,
  duplicateOf: DuplicateOf,
  limit: number,
): GalleryFilterCounts {
  const counts: GalleryFilterCounts = { pass: 0, unsure: 0, fail: 0, dup: 0 }
  for (const id of imageIds) {
    if (!id) continue
    const verdict = verdictOf(id)?.verdict
    if (verdict === 'pass') counts.pass += 1
    else if (verdict === 'unsure') counts.unsure += 1
    else if (verdict === 'fail') counts.fail += 1
    if (duplicateOf(id) > limit) counts.dup += 1
  }
  return counts
}

/** 筛选后要展示的下标（升序，保持原顺序）。'all' 时全部返回 */
export function filterGalleryIndexes(
  imageIds: string[],
  filter: GalleryFilter,
  verdictOf: VerdictOf,
  duplicateOf: DuplicateOf,
  limit: number,
): number[] {
  const all = imageIds.map((id, index) => ({ id, index }))
  if (filter === 'all') return all.map((item) => item.index)
  return all
    .filter(({ id }) => {
      if (!id) return false
      if (filter === 'dup') return duplicateOf(id) > limit
      return verdictOf(id)?.verdict === filter
    })
    .map((item) => item.index)
}
