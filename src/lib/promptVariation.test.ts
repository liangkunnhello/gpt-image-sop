import { describe, expect, it } from 'vitest'

import {
  ANGLE_CANDIDATES,
  SCENE_CANDIDATES,
  SUBJECT_CANDIDATES,
  TONE_CANDIDATES,
  variationCandidates,
} from './promptVariation'

describe('变量候选池', () => {
  it('四个维度都有足够的候选，够一批用量', () => {
    expect(SCENE_CANDIDATES.length).toBeGreaterThanOrEqual(8)
    expect(ANGLE_CANDIDATES.length).toBeGreaterThanOrEqual(4)
    expect(SUBJECT_CANDIDATES.length).toBeGreaterThanOrEqual(4)
    expect(TONE_CANDIDATES.length).toBeGreaterThanOrEqual(4)
  })

  it('每个维度内部不重复', () => {
    for (const list of [SCENE_CANDIDATES, ANGLE_CANDIDATES, SUBJECT_CANDIDATES, TONE_CANDIDATES]) {
      expect(new Set(list).size).toBe(list.length)
    }
  })
})

describe('variationCandidates', () => {
  it('按四个维度成段给出，并明确要求取舍', () => {
    const text = variationCandidates()
    expect(text).toContain('【可用的变量候选（请取舍，不要照抄）】')
    for (const label of ['场景：', '机位：', '主体：', '色调：']) {
      expect(text).toContain(label)
    }
    expect(text).toContain(SCENE_CANDIDATES[0])
    expect(text).toContain(TONE_CANDIDATES[0])
  })

  it('不再提供「第几条用哪组」的硬分配', () => {
    const text = variationCandidates()
    expect(text).not.toContain('第 1 条')
    expect(text).not.toContain('第 2 条')
  })
})
