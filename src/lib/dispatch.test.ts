import { describe, expect, it } from 'vitest'
import type { SopDirectionNode } from '../types'
import { createPostTemplate, type PostTemplate } from './postTemplate'
import {
  countDispatchable,
  dispatchCandidates,
  dispatchSkipNote,
  pickDispatchTemplate,
} from './dispatch'

const nodes: SopDirectionNode[] = [
  { id: 'cat', parentId: null, name: '保险', kind: 'category' },
  { id: 'prod-a', parentId: 'cat', name: '百万医疗险', kind: 'product' },
  { id: 'dir-a1', parentId: 'prod-a', name: '月亮', kind: 'direction' },
  { id: 'dir-a2', parentId: 'prod-a', name: '大字报', kind: 'direction' },
  { id: 'prod-b', parentId: 'cat', name: '京东保', kind: 'product' },
  { id: 'dir-b1', parentId: 'prod-b', name: '扁平插画', kind: 'direction' },
]

function square(overrides: Partial<PostTemplate> = {}): PostTemplate {
  return { ...createPostTemplate(2048, 2048, '方图'), enabled: true, ...overrides }
}

function portrait(overrides: Partial<PostTemplate> = {}): PostTemplate {
  return { ...createPostTemplate(1440, 2560, '竖图'), enabled: true, ...overrides }
}

describe('dispatchCandidates', () => {
  it('顶层类目只是分组容器，不能当派发目标', () => {
    const list = dispatchCandidates(nodes, { cat: [square()] })
    expect(list.map((item) => item.id)).not.toContain('cat')
  })

  it('没有启用模板的节点不出现（没有水印就无从派发）', () => {
    const list = dispatchCandidates(nodes, {
      'prod-a': [square({ enabled: false })],
      'dir-b1': [square()],
    })
    expect(list.map((item) => item.id)).toEqual(['dir-b1'])
  })

  it('方向配了自己的模板就只算它，不再继承产品模板', () => {
    const list = dispatchCandidates(nodes, {
      'prod-a': [square({ label: '产品版' })],
      'dir-a1': [portrait({ label: '方向版' })],
    })
    const direction = list.find((item) => item.id === 'dir-a1')
    expect(direction?.scope).toBe('direction')
    expect(direction?.templates.map((item) => item.label)).toEqual(['方向版'])
    // 同产品另一个方向没配，回落到产品模板
    const sibling = list.find((item) => item.id === 'dir-a2')
    expect(sibling?.templates.map((item) => item.label)).toEqual(['产品版'])
  })

  it('产品本身也是合法目标：产品模板对它的所有方向都生效', () => {
    const list = dispatchCandidates(nodes, { 'prod-a': [square()] })
    const product = list.find((item) => item.id === 'prod-a')
    expect(product?.scope).toBe('product')
    expect(product?.path).toBe('保险 / 百万医疗险')
  })

  it('已删除的节点不出现', () => {
    const list = dispatchCandidates(
      nodes.map((node) => (node.id === 'dir-b1' ? { ...node, deletedAt: 1 } : node)),
      { 'dir-b1': [square()] },
    )
    expect(list.map((item) => item.id)).not.toContain('dir-b1')
  })

  it('按路径排序，同一产品的方向聚在一起', () => {
    const list = dispatchCandidates(nodes, {
      'prod-a': [square()],
      'prod-b': [square()],
    })
    const paths = list.map((item) => item.path)
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b, 'zh')))
  })
})

describe('pickDispatchTemplate', () => {
  const gdt = square({ id: 'gdt', label: '广点通' })
  const generic = portrait({ id: 'generic', label: '通用', channel: undefined })

  it('同渠道模板优先', () => {
    const picked = pickDispatchTemplate([gdt, generic], 2048, 2048, 'gdt')
    expect(picked?.id).toBe('gdt')
  })

  it('这个渠道一套都没有时退回只看比例，不让渠道卡死派发', () => {
    const other = square({ id: 'other', label: '别的渠道', channel: 'toutiao' })
    const picked = pickDispatchTemplate([other], 2048, 2048, 'gdt')
    expect(picked?.id).toBe('other')
  })

  it('比例对不上就返回 null（硬裁会毁画面）', () => {
    const picked = pickDispatchTemplate([portrait()], 2048, 2048, undefined)
    expect(picked).toBeNull()
  })

  it('不启用 / 尺寸为 0 的模板不参与挑选', () => {
    expect(pickDispatchTemplate([square({ enabled: false })], 2048, 2048)).toBeNull()
    expect(pickDispatchTemplate([square({ width: 0 })], 2048, 2048)).toBeNull()
  })
})

describe('countDispatchable', () => {
  const candidate = dispatchCandidates(nodes, { 'prod-a': [square()] })[0]

  it('只数比例对得上的那几张', () => {
    expect(countDispatchable(candidate, [
      { width: 2048, height: 2048 },
      { width: 1440, height: 2560 },
      { width: 1024, height: 1024 },
    ])).toBe(2)
  })

  it('一张都对不上时是 0', () => {
    expect(countDispatchable(candidate, [{ width: 2560, height: 1440 }])).toBe(0)
  })

  it('尺寸列表为空时是 0', () => {
    expect(countDispatchable(candidate, [])).toBe(0)
  })
})

describe('dispatchSkipNote', () => {
  it('没有跳过就不说话', () => {
    expect(dispatchSkipNote(0, 5)).toBe('')
  })

  it('全跳过时说明是比例问题', () => {
    expect(dispatchSkipNote(3, 3)).toContain('比例')
  })

  it('部分跳过时报出张数', () => {
    expect(dispatchSkipNote(2, 5)).toContain('2')
  })
})
