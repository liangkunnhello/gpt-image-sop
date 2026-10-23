import { describe, expect, it } from 'vitest'

import { buildVariations, buildVariationTable, MAX_VARIATIONS } from './promptVariation'

describe('buildVariations', () => {
  it('按条数生成，条数不对时收敛到合法范围', () => {
    expect(buildVariations(0)).toHaveLength(0)
    expect(buildVariations(3)).toHaveLength(3)
    expect(buildVariations(30)).toHaveLength(30)
    expect(buildVariations(999)).toHaveLength(MAX_VARIATIONS)
    expect(buildVariations(-5)).toHaveLength(0)
  })

  it('界面允许的 30 条里，四项组合互不重复', () => {
    const combos = buildVariations(30).map(
      (item) => `${item.scene}|${item.angle}|${item.subject}|${item.tone}`,
    )
    expect(new Set(combos).size).toBe(30)
  })

  it('每个维度自身在各自周期内均匀铺开，不出现连续重复', () => {
    // 12 个场景、6 个机位、7 个主体、6 个色调：步长与长度互质，走满一轮才会回到起点
    const scenes = buildVariations(12).map((item) => item.scene)
    expect(new Set(scenes).size).toBe(12)
    const angles = buildVariations(6).map((item) => item.angle)
    expect(new Set(angles).size).toBe(6)
    const subjects = buildVariations(7).map((item) => item.subject)
    expect(new Set(subjects).size).toBe(7)
    const tones = buildVariations(6).map((item) => item.tone)
    expect(new Set(tones).size).toBe(6)

    const list = buildVariations(30)
    for (let i = 1; i < list.length; i += 1) {
      expect(list[i].scene).not.toBe(list[i - 1].scene)
      expect(list[i].tone).not.toBe(list[i - 1].tone)
    }
  })
})

describe('buildVariationTable', () => {
  it('逐条列出分配结果，并写明不得互换', () => {
    const table = buildVariationTable(buildVariations(3))
    expect(table).toContain('【每条的画面差异（已经分配好，必须照此执行）】')
    expect(table).toContain('第 1 条：场景＝')
    expect(table).toContain('第 3 条：场景＝')
    expect(table).not.toContain('第 4 条')
    expect(table).toContain('不得与其它行互换')
    expect(table).toContain('版式结构、文字层级和图上文字全部保持不变')
  })

  it('没有条目时不返回任何内容，调用方不会拼出空表格', () => {
    expect(buildVariationTable([])).toBe('')
  })
})
