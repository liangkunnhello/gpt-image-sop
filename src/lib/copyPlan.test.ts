import { describe, expect, it } from 'vitest'

import { planCopyAssignment, splitCopyItems } from './copyPlan'

describe('splitCopyItems', () => {
  it('按行拆，去掉项目符号与序号', () => {
    const items = splitCopyItems('- 600 万医疗保障\n2. 住院 0 免赔\n③ 保证续保 20 年')
    expect(items).toEqual(['600 万医疗保障', '住院 0 免赔', '保证续保 20 年'])
  })

  it('一行里的分号也拆开', () => {
    expect(splitCopyItems('首月 1 元；住院 0 免赔; 保证续保')).toEqual(['首月 1 元', '住院 0 免赔', '保证续保'])
  })

  it('重复条目只留一次，空行忽略', () => {
    expect(splitCopyItems('首月 1 元\n\n首月 1 元\n  ')).toEqual(['首月 1 元'])
  })

  it('逗号不拆，避免把一句话切碎', () => {
    expect(splitCopyItems('首月 1 元，次月起 9.9 元')).toEqual(['首月 1 元，次月起 9.9 元'])
  })
})

describe('planCopyAssignment', () => {
  it('卖点够时均摊，不重复', () => {
    const plan = planCopyAssignment('A\nB\nC\nD\nE', 3)
    expect(plan).toEqual([['A', 'B'], ['C', 'D'], ['E']])
    expect(plan.flat().sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('条数与卖点数相同，一条一句', () => {
    expect(planCopyAssignment('A\nB', 2)).toEqual([['A'], ['B']])
  })

  it('卖点不够时，多出来的条目留空，交给版式适配', () => {
    expect(planCopyAssignment('A\nB', 4)).toEqual([['A'], ['B'], [], []])
  })

  it('没有卖点时全部留空，长度仍与条数一致', () => {
    expect(planCopyAssignment('   ', 3)).toEqual([[], [], []])
    expect(planCopyAssignment('A', 0)).toEqual([])
  })
})
