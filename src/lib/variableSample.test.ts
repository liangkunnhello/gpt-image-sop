import { describe, expect, it } from 'vitest'

import type { VariableStrategy } from '../types'
import {
  buildComboPool,
  effectiveDimensions,
  farthestPointSample,
  fillSkeleton,
  planFills,
  planStrategyFills,
  skeletonVariables,
} from './variableSample'

const strategy = (
  skeleton: string,
  dimensions: VariableStrategy['dimensions'],
  name = '中心核心与外围阵列',
): VariableStrategy => ({
  name,
  evidence: '图1',
  skeleton,
  dimensions,
  value: '适合批量做同一结构的不同变体',
})

describe('skeletonVariables', () => {
  it('按首次出现顺序去重，允许带空格', () => {
    expect(skeletonVariables('{{承载结构}}里放{{ 主体 }}，再回到{{承载结构}}'))
      .toEqual(['承载结构', '主体'])
  })

  it('没有占位符时返回空数组', () => {
    expect(skeletonVariables('纯文字提示词')).toEqual([])
  })
})

describe('fillSkeleton', () => {
  it('逐个替换成取值', () => {
    expect(fillSkeleton('{{A}}套{{B}}', { A: '圆盘', B: '羽翼' })).toBe('圆盘套羽翼')
  })

  it('没给取值的占位符原样保留，便于发现漏填', () => {
    expect(fillSkeleton('{{A}}套{{B}}', { A: '圆盘' })).toBe('圆盘套{{B}}')
  })
})

describe('buildComboPool', () => {
  it('空间不大时全枚举，数量等于各维选项数之积', () => {
    const pool = buildComboPool([
      { name: 'A', options: ['a1', 'a2'] },
      { name: 'B', options: ['b1', 'b2', 'b3'] },
    ])
    expect(pool).toHaveLength(6)
    expect(new Set(pool.map((c) => c.join(','))).size).toBe(6)
  })

  it('空间太大时截到上限，且不产生重复点', () => {
    const dims = Array.from({ length: 6 }, (_, i) => ({
      name: `D${i}`,
      options: Array.from({ length: 10 }, (_, j) => `v${j}`),
    }))
    const pool = buildComboPool(dims, 300)
    expect(pool.length).toBeLessThanOrEqual(300)
    expect(new Set(pool.map((c) => c.join(','))).size).toBe(pool.length)
  })
})

describe('effectiveDimensions', () => {
  it('只有一个选项的维度不参与采样', () => {
    const dims = effectiveDimensions([
      { name: 'A', options: ['唯一'] },
      { name: 'B', options: ['x', 'y'] },
    ])
    expect(dims.map((d) => d.name)).toEqual(['B'])
  })
})

describe('farthestPointSample', () => {
  it('选出的点两两之间保持距离，不会挤在同一角', () => {
    // 2x2 网格取 2 个点，必须是两个不同的点
    const points = [[0, 0], [0, 1], [1, 0], [1, 1]]
    const picked = farthestPointSample(points, 2)
    expect(picked).toHaveLength(2)
    expect(new Set(picked).size).toBe(2)
    const [a, b] = picked.map((i) => points[i])
    const diff = a.reduce((acc, value, idx) => acc + (value === b[idx] ? 0 : 1), 0)
    expect(diff).toBeGreaterThanOrEqual(1)
  })

  it('要的张数超过池子大小时最多给满池子，不重复', () => {
    const points = [[0], [1], [2]]
    const picked = farthestPointSample(points, 10)
    expect(picked).toHaveLength(3)
    expect(new Set(picked).size).toBe(3)
  })

  it('同样的输入永远给同样的结果', () => {
    const dims = [
      { name: 'A', options: ['a1', 'a2', 'a3'] },
      { name: 'B', options: ['b1', 'b2', 'b3'] },
      { name: 'C', options: ['c1', 'c2'] },
    ]
    const pool = buildComboPool(dims)
    expect(farthestPointSample(pool, 4)).toEqual(farthestPointSample(pool, 4))
  })

  it('单维度 3 选项取 3 个时正好覆盖全部取值', () => {
    const pool = buildComboPool([{ name: 'A', options: ['a1', 'a2', 'a3'] }])
    const picks = farthestPointSample(pool, 3).map((i) => pool[i][0])
    expect(new Set(picks)).toEqual(new Set([0, 1, 2]))
  })

  it('张数为 0 时返回空', () => {
    expect(farthestPointSample([[0]], 0)).toEqual([])
  })
})

describe('planFills', () => {
  it('2x3 维度取 6 张时覆盖全部 6 种组合', () => {
    const plan = planFills(strategy('{{A}}和{{B}}', [
      { name: 'A', options: ['a1', 'a2'] },
      { name: 'B', options: ['b1', 'b2', 'b3'] },
    ]), 6)
    expect(plan.fills).toHaveLength(6)
    expect(new Set(plan.fills.map((fill) => fill.prompt)).size).toBe(6)
  })

  it('张数超过组合数时如实截断，并说明原因', () => {
    const plan = planFills(strategy('{{A}}', [{ name: 'A', options: ['a1', 'a2'] }]), 5)
    expect(plan.fills).toHaveLength(2)
    expect(plan.note).toContain('只有 2 种不同结果')
  })

  it('单选项变量不参与采样，但仍会被填进提示词', () => {
    const plan = planFills(strategy('{{固定}}的{{变}}', [
      { name: '固定', options: ['唯一值'] },
      { name: '变', options: ['x', 'y'] },
    ]), 2)
    expect(plan.fills).toHaveLength(2)
    for (const fill of plan.fills) {
      expect(fill.prompt).toContain('唯一值')
      expect(fill.assignments['固定']).toBe('唯一值')
    }
  })

  it('填词后不留占位符', () => {
    const plan = planFills(strategy('{{A}}包住{{B}}', [
      { name: 'A', options: ['圆盘', '方框'] },
      { name: 'B', options: ['核心', '种子'] },
    ]), 3)
    for (const fill of plan.fills) expect(fill.prompt).not.toContain('{{')
  })
})

describe('planStrategyFills', () => {
  const two = [
    strategy('{{A}}', [{ name: 'A', options: ['a1', 'a2', 'a3'] }], '策略甲'),
    strategy('{{B}}', [{ name: 'B', options: ['b1', 'b2', 'b3'] }], '策略乙'),
  ]

  it('张数按策略平摊，余数给前面的策略', () => {
    const { fills } = planStrategyFills(two, 4)
    expect(fills).toHaveLength(4)
    expect(fills.filter((f) => f.strategyName === '策略甲')).toHaveLength(2)
    expect(fills.filter((f) => f.strategyName === '策略乙')).toHaveLength(2)
  })

  it('张数比策略数多不出余数时，奇数张给前面的策略多一张', () => {
    const { fills } = planStrategyFills(two, 3)
    expect(fills).toHaveLength(3)
    expect(fills.filter((f) => f.strategyName === '策略甲')).toHaveLength(2)
    expect(fills.filter((f) => f.strategyName === '策略乙')).toHaveLength(1)
  })

  it('最终提示词不重复', () => {
    const { fills } = planStrategyFills(two, 6)
    expect(new Set(fills.map((f) => f.prompt)).size).toBe(fills.length)
  })

  it('没有策略或张数为 0 时返回空', () => {
    expect(planStrategyFills([], 5).fills).toEqual([])
    expect(planStrategyFills(two, 0).fills).toEqual([])
  })
})
