import { describe, expect, it } from 'vitest'
import {
  buildVariableImageHint,
  planVariableImageAssignments,
  variableImageOverflow,
  withVariableImageHint,
} from './variableImages'

const img = (id: string) => ({ id, dataUrl: `data:${id}` })

describe('变量图分配', () => {
  it('固定图每条都带，变量图按条轮换', () => {
    const plan = planVariableImageAssignments([img('f1'), img('f2')], [img('v1'), img('v2'), img('v3')], 5)
    expect(plan.assignments).toHaveLength(5)
    for (const item of plan.assignments) {
      expect(item.images.slice(0, 2).map((i) => i.id)).toEqual(['f1', 'f2'])
    }
    expect(plan.assignments.map((item) => item.variableImage?.id)).toEqual(['v1', 'v2', 'v3', 'v1', 'v2'])
  })

  it('没有固定图时每条只带一张变量图', () => {
    const plan = planVariableImageAssignments([], [img('v1'), img('v2')], 3)
    expect(plan.assignments.map((item) => item.images.map((i) => i.id))).toEqual([['v1'], ['v2'], ['v1']])
  })

  it('没有变量图时每条都带同一组固定图', () => {
    const plan = planVariableImageAssignments([img('f1')], [], 2)
    expect(plan.assignments.every((item) => item.images.map((i) => i.id).join() === 'f1')).toBe(true)
    expect(plan.assignments.every((item) => item.variableImage === null)).toBe(true)
  })

  it('固定图与变量图重复时只保留一次，且仍算固定图', () => {
    const plan = planVariableImageAssignments([img('same')], [img('same')], 1)
    expect(plan.assignments[0]!.images.map((i) => i.id)).toEqual(['same'])
    expect(plan.assignments[0]!.variableImage).toBeNull()
  })

  it('offset 让后续卡接着上一张继续轮转', () => {
    const plan = planVariableImageAssignments([], [img('v1'), img('v2')], 2, 1)
    expect(plan.assignments.map((item) => item.variableImage?.id)).toEqual(['v2', 'v1'])
    expect(plan.nextOffset).toBe(3)
  })

  it('条数为 0 时返回空计划，不推进 offset', () => {
    const plan = planVariableImageAssignments([img('f1')], [img('v1')], 0, 2)
    expect(plan.assignments).toEqual([])
    expect(plan.nextOffset).toBe(2)
  })

  it('固定图占满上限时不再带变量图，避免请求超限', () => {
    const fixed = Array.from({ length: 16 }, (_, i) => img(`f${i}`))
    const plan = planVariableImageAssignments(fixed, [img('v1')], 2)
    for (const item of plan.assignments) {
      expect(item.images).toHaveLength(16)
      expect(item.variableImage).toBeNull()
    }
  })
})

describe('变量图超限提示', () => {
  it('16 张固定图再加变量图就会超限', () => {
    expect(variableImageOverflow(16, true)).toBe(true)
    expect(variableImageOverflow(15, true)).toBe(false)
    expect(variableImageOverflow(16, false)).toBe(false)
  })
})

describe('变量图说明', () => {
  it('固定图与变量图都有时说清各自角色', () => {
    const hint = buildVariableImageHint(2, 1)
    expect(hint).toContain('前 2 张是固定图')
    expect(hint).toContain('最后 1 张是本次变量图')
    expect(hint).toContain('以固定图为准')
  })

  it('只有固定图时说明本次没有变量图', () => {
    const hint = buildVariableImageHint(3, 0)
    expect(hint).toContain('3 张都是固定图')
    expect(hint).toContain('没有变量图')
  })

  it('只有变量图时按单图说明', () => {
    expect(buildVariableImageHint(0, 1)).toContain('只提供了 1 张变量图')
  })

  it('没有图时返回空串，不往提示词里插空段', () => {
    expect(buildVariableImageHint(0, 0)).toBe('')
    expect(withVariableImageHint('原始提示词', '')).toBe('原始提示词')
  })

  it('说明拼在提示词前面', () => {
    expect(withVariableImageHint('原始提示词', '【输入图片说明】')).toBe('【输入图片说明】\n\n原始提示词')
  })
})
