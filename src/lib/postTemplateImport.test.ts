import { describe, expect, it } from 'vitest'

import { collectPostTemplateSources, importPostTemplates } from './postTemplateImport'

/**
 * 树：业务线A ─ 产品A1 ─ 方向A1a / A1b
 *     业务线B ─ 产品B1
 */
const directions = [
  { id: 'cat-a', name: '业务线A', parentId: null },
  { id: 'prod-a1', name: '产品A1', parentId: 'cat-a' },
  { id: 'dir-a1a', name: '方向A1a', parentId: 'prod-a1' },
  { id: 'dir-a1b', name: '方向A1b', parentId: 'prod-a1' },
  { id: 'cat-b', name: '业务线B', parentId: null },
  { id: 'prod-b1', name: '产品B1', parentId: 'cat-b' },
]

/** 测试用的最小模板结构：只带导入逻辑用得到的字段 */
interface Tpl {
  id: string
  label: string
  width: number
  height: number
  enabled: boolean
  isDefault: boolean
  channel?: string
  elements: Array<{ id: string; kind: string; text?: string; width?: number }>
}

const tpl = (id: string, width = 2048, height = 2048, extra: Partial<Tpl> = {}): Tpl => ({
  id,
  label: id,
  width,
  height,
  enabled: true,
  isDefault: false,
  elements: [],
  ...extra,
})

describe('列出可导入的模板来源', () => {
  it('按业务线分组，产品排在自己的方向前面', () => {
    const groups = collectPostTemplateSources(
      {
        'prod-a1': [tpl('p1')],
        'dir-a1a': [tpl('d1')],
        'dir-a1b': [tpl('d2')],
        'prod-b1': [tpl('p2')],
      },
      directions,
    )
    expect(groups.map((g) => g.categoryName)).toEqual(['业务线A', '业务线B'])
    // 产品在自己的方向前
    expect(groups[0]!.sources.map((s) => s.name)).toEqual(['产品A1', '方向A1a', '方向A1b'])
    expect(groups[0]!.sources.map((s) => s.kind)).toEqual(['product', 'direction', 'direction'])
    // 方向带上父产品名，便于辨认
    expect(groups[0]!.sources[1]!.parentName).toBe('产品A1')
    expect(groups[0]!.sources[0]!.parentName).toBeUndefined()
  })

  it('没有模板的节点不作为来源', () => {
    const groups = collectPostTemplateSources({ 'prod-a1': [] }, directions)
    expect(groups).toEqual([])
  })

  it('排除目标节点自己', () => {
    const groups = collectPostTemplateSources(
      { 'prod-a1': [tpl('p1')], 'prod-b1': [tpl('p2')] },
      directions,
      { excludeId: 'prod-a1' },
    )
    expect(groups.flatMap((g) => g.sources).map((s) => s.id)).toEqual(['prod-b1'])
  })

  it('节点已被删除的模板不出现', () => {
    const groups = collectPostTemplateSources(
      { 'prod-a1': [tpl('p1')], 'ghost-node': [tpl('g')] },
      directions,
    )
    expect(groups.flatMap((g) => g.sources).map((s) => s.id)).toEqual(['prod-a1'])
  })

  it('业务线自己不作来源（模板只在产品/方向两层）', () => {
    const groups = collectPostTemplateSources({ 'cat-a': [tpl('c')] }, directions)
    expect(groups).toEqual([])
  })
})

describe('导入模板', () => {
  it('复制进来并换掉 id，元素与 logo 原样带过来', () => {
    const src = tpl('src-1', 2560, 1440, {
      label: '9:16 竖版 A',
      channel: 'gdt',
      elements: [{ id: 'el-1', kind: 'logo', text: 'data:image/png;base64,xxx', width: 0.12 }],
    })
    const out = importPostTemplates([], [src], (_, i) => `new-${i}`)
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('new-0')
    // 其他字段原样保留
    expect(out[0]!.label).toBe('9:16 竖版 A')
    expect(out[0]!.width).toBe(2560)
    expect(out[0]!.channel).toBe('gdt')
    expect(out[0]!.elements).toEqual(src.elements)
  })

  it('原有模板不被动到', () => {
    const existing = [tpl('keep-1')]
    const out = importPostTemplates(existing, [tpl('src-1')], () => 'new-0')
    expect(out.map((t) => t.id)).toEqual(['keep-1', 'new-0'])
    expect(existing.map((t) => t.id)).toEqual(['keep-1'])
  })

  it('同渠道同比例已有默认时，导入进来的不抢默认', () => {
    const existing = [tpl('keep-1', 2048, 2048, { isDefault: true, channel: 'gdt' })]
    const out = importPostTemplates(
      existing,
      [tpl('src-1', 1024, 1024, { isDefault: true, channel: 'gdt' })],
      () => 'new-0',
    )
    expect(out[0]!.isDefault).toBe(true)
    expect(out[1]!.isDefault).toBe(false)
  })

  it('比例档与渠道都不同时保留默认标记', () => {
    const existing = [tpl('keep-1', 2048, 2048, { isDefault: true, channel: 'gdt' })]
    const out = importPostTemplates(
      existing,
      [tpl('src-1', 2560, 1440, { isDefault: true, channel: 'gdt' })],
      () => 'new-0',
    )
    expect(out[1]!.isDefault).toBe(true)
  })

  it('没选任何模板时原样返回', () => {
    const existing = [tpl('keep-1')]
    expect(importPostTemplates(existing, [], () => 'x')).toBe(existing)
  })
})
