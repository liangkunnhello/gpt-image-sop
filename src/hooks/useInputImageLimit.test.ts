import { describe, expect, it } from 'vitest'

import { resolveInputImageLimit } from '../hooks/useInputImageLimit'
import { MAX_INPUT_IMAGES } from '../types'

const base = { sopMode: false, variableMode: false, plainImageMode: 'merge' as const, n: 1 }

describe('参考图数量上限', () => {
  it('融图 + 数量 1：所有图塞一个请求，仍限 16 张', () => {
    expect(resolveInputImageLimit(base)).toBe(MAX_INPUT_IMAGES)
  })

  it('批量模式不限数量', () => {
    expect(resolveInputImageLimit({ ...base, plainImageMode: 'batch' })).toBe(Number.POSITIVE_INFINITY)
  })

  it('融图但数量大于 1 时不限，图会被分组', () => {
    expect(resolveInputImageLimit({ ...base, n: 4 })).toBe(Number.POSITIVE_INFINITY)
    expect(resolveInputImageLimit({ ...base, n: 100 })).toBe(Number.POSITIVE_INFINITY)
  })

  it('SOP / 变量模式保持 16 张', () => {
    expect(resolveInputImageLimit({ ...base, sopMode: true, plainImageMode: 'batch' })).toBe(MAX_INPUT_IMAGES)
    expect(resolveInputImageLimit({ ...base, variableMode: true, n: 8 })).toBe(MAX_INPUT_IMAGES)
  })

  it('数量还没填时按 1 处理，不会误放开', () => {
    expect(resolveInputImageLimit({ ...base, n: 0 })).toBe(MAX_INPUT_IMAGES)
  })
})
