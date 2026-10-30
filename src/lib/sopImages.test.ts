import { describe, expect, it } from 'vitest'

import {
  buildSopImageHint,
  DEFAULT_IMAGE_FIDELITY,
  imageFidelityLabel,
  normalizeImageFidelity,
  planSopImages,
  sopVariableImageOffset,
  withSopImageHint,
} from './sopImages'

const img = (id: string) => ({ id, dataUrl: `data:image/png;base64,${id}` })

describe('底图说明', () => {
  it('两个池都空时返回空串，提示词里不该出现任何底图字样', () => {
    expect(buildSopImageHint({ fixedCount: 0, variableCount: 0 })).toBe('')
    expect(withSopImageHint('一条提示词', '')).toBe('一条提示词')
  })

  it('固定图 + 变量图讲清两者分工', () => {
    const hint = buildSopImageHint({ fixedCount: 2, variableCount: 3 })
    expect(hint).toContain('前 2 张是固定图')
    expect(hint).toContain('最后 1 张是本次变量图')
    expect(hint).toContain('两张冲突时以固定图为准')
  })

  it('只有变量图时说清「各带 1 张」', () => {
    const hint = buildSopImageHint({ fixedCount: 0, variableCount: 4 })
    expect(hint).toContain('每条提示词会各带 1 张变量图')
    expect(hint).not.toContain('固定图')
  })

  it('保真档决定「保留什么、重画什么」', () => {
    expect(buildSopImageHint({ fixedCount: 1, variableCount: 0, fidelity: 'layout' }))
      .toContain('只把画面上的文字换成本批文案')
    expect(buildSopImageHint({ fixedCount: 1, variableCount: 0, fidelity: 'product' }))
      .toContain('场景、构图、光线与配色可以按提示词重新设计')
    expect(buildSopImageHint({ fixedCount: 1, variableCount: 0, fidelity: 'style' }))
      .toContain('产品、场景、版式都按提示词重新设计')
  })

  it('「用户要求优先」必须写在里面：底图是参考，不是命令', () => {
    const hint = buildSopImageHint({ fixedCount: 1, variableCount: 1, fidelity: 'layout' })
    expect(hint).toContain('用户给出的文案与额外要求优先级最高')
    expect(hint).toContain('与底图冲突时以用户要求为准')
  })

  it('拼到提示词前面时保留原文', () => {
    const hint = buildSopImageHint({ fixedCount: 1, variableCount: 0 })
    expect(withSopImageHint('换成主视觉大图', hint)).toBe(`${hint}\n\n换成主视觉大图`)
  })
})

describe('保真档取值', () => {
  it('脏值 / 老数据退回默认档', () => {
    expect(normalizeImageFidelity(undefined)).toBe(DEFAULT_IMAGE_FIDELITY)
    expect(normalizeImageFidelity('whatever')).toBe(DEFAULT_IMAGE_FIDELITY)
    expect(normalizeImageFidelity('style')).toBe('style')
    expect(imageFidelityLabel('product')).toBe('保产品')
  })
})

describe('变量图跨卡轮换', () => {
  it('每卡 5 条时，第二张卡从第 6 张继续', () => {
    expect(sopVariableImageOffset(0, 5)).toBe(0)
    expect(sopVariableImageOffset(1, 5)).toBe(5)
    expect(sopVariableImageOffset(3, 8)).toBe(24)
  })

  it('参数不合法时退回 0，不让批次错位', () => {
    expect(sopVariableImageOffset(-1, 5)).toBe(0)
    expect(sopVariableImageOffset(2, NaN)).toBe(0)
  })

  it('分配沿用变量模式：固定图全带、变量图按 offset 轮换', () => {
    const plan = planSopImages([img('f1')], [img('v1'), img('v2')], 3, 1)
    expect(plan.assignments.map((item) => item.images.map((image) => image.id))).toEqual([
      ['f1', 'v2'],
      ['f1', 'v1'],
      ['f1', 'v2'],
    ])
    expect(plan.nextOffset).toBe(4)
  })
})
