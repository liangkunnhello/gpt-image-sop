import { describe, expect, it } from 'vitest'
import { TRACK_STORE_NAMES } from './trackDb'
import {
  STORE_TRACK_ASSETS,
  STORE_TRACK_IMPORTS,
  STORE_TRACK_LINEAGE,
  STORE_TRACK_SPEND,
} from './idb'

/**
 * trackDb 里刻意没有 import idb.ts 的 STORE_TRACK_* 常量（见那里的注释：
 * idb 被多个测试 mock 过，依赖它的具名导出会让那些测试报错）。
 * 代价是两边各写一份名字，所以这里用测试把两边钉死 ——
 * 任何一边改了名而另一边没跟上，这条用例立刻失败，
 * 而不是等运行时发现「store 不存在」。
 */
describe('trackDb 与 idb 的 store 名必须一致', () => {
  it('四张表的 store 名完全对应', () => {
    expect(TRACK_STORE_NAMES.assets).toBe(STORE_TRACK_ASSETS)
    expect(TRACK_STORE_NAMES.spend).toBe(STORE_TRACK_SPEND)
    expect(TRACK_STORE_NAMES.lineage).toBe(STORE_TRACK_LINEAGE)
    expect(TRACK_STORE_NAMES.imports).toBe(STORE_TRACK_IMPORTS)
  })

  it('四个 store 名互不相同', () => {
    const names = Object.values(TRACK_STORE_NAMES)
    expect(new Set(names).size).toBe(names.length)
  })
})
