import { beforeEach, describe, expect, it } from 'vitest'

import { resolvePostTemplates } from './applyPostTemplate'
import { createPostTemplate, type PostTemplate } from './postTemplate'
import { useSopStore } from './sopStore'
import type { SopDirectionNode } from '../types'

const DIRECTIONS: SopDirectionNode[] = [
  { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
  { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
  { id: 'dir-1', parentId: 'prod-1', name: '月亮', kind: 'direction' },
  { id: 'dir-2', parentId: 'prod-1', name: '图标', kind: 'direction' },
]

const tpl = (label: string, enabled = true): PostTemplate => ({
  ...createPostTemplate(1440, 2560, label),
  enabled,
})

describe('后处理模板按方向取用', () => {
  it('方向没配专属模板时沿用产品模板', () => {
    const resolved = resolvePostTemplates({ 'prod-1': [tpl('产品模板')] }, DIRECTIONS, 'dir-1')
    expect(resolved.scope).toBe('product')
    expect(resolved.ownerId).toBe('prod-1')
    expect(resolved.templates.map((item) => item.label)).toEqual(['产品模板'])
  })

  it('方向配了专属模板就只用它，不叠加产品模板', () => {
    const resolved = resolvePostTemplates({
      'prod-1': [tpl('产品模板')],
      'dir-1': [tpl('方向模板')],
    }, DIRECTIONS, 'dir-1')
    expect(resolved.scope).toBe('direction')
    expect(resolved.ownerId).toBe('dir-1')
    expect(resolved.templates.map((item) => item.label)).toEqual(['方向模板'])
  })

  it('方向专属模板只影响自己那个方向，同产品其它方向仍然用产品模板', () => {
    const templates = { 'prod-1': [tpl('产品模板')], 'dir-1': [tpl('方向模板')] }
    expect(resolvePostTemplates(templates, DIRECTIONS, 'dir-2').templates.map((item) => item.label))
      .toEqual(['产品模板'])
  })

  it('方向模板全被禁用也不回落到产品模板（方向自己说了算）', () => {
    const resolved = resolvePostTemplates({
      'prod-1': [tpl('产品模板')],
      'dir-1': [tpl('方向模板', false)],
    }, DIRECTIONS, 'dir-1')
    expect(resolved.scope).toBe('direction')
    expect(resolved.templates.map((item) => [item.label, item.enabled])).toEqual([['方向模板', false]])
  })

  it('方向模板被删空（存成空数组）时回到产品模板', () => {
    const resolved = resolvePostTemplates({
      'prod-1': [tpl('产品模板')],
      'dir-1': [],
    }, DIRECTIONS, 'dir-1')
    expect(resolved.scope).toBe('product')
    expect(resolved.templates.map((item) => item.label)).toEqual(['产品模板'])
  })

  it('任务挂在产品上时，读的是产品自己的模板', () => {
    const resolved = resolvePostTemplates({ 'prod-1': [tpl('产品模板')] }, DIRECTIONS, 'prod-1')
    expect(resolved.scope).toBe('product')
    expect(resolved.ownerId).toBe('prod-1')
  })

  it('未归属或节点已不存在时没有任何模板', () => {
    const templates = { 'prod-1': [tpl('产品模板')], 'dir-1': [tpl('方向模板')] }
    expect(resolvePostTemplates(templates, DIRECTIONS, undefined)).toEqual({ ownerId: '', scope: 'none', templates: [] })
    expect(resolvePostTemplates(templates, DIRECTIONS, '')).toEqual({ ownerId: '', scope: 'none', templates: [] })
    expect(resolvePostTemplates(templates, DIRECTIONS, 'gone-dir')).toEqual({ ownerId: '', scope: 'none', templates: [] })
  })
})

describe('方向模板与产品模板分开存', () => {
  beforeEach(() => {
    useSopStore.setState({ directions: DIRECTIONS, postTemplates: {}, postPreviewImages: {} })
  })

  it('写在方向上的模板不会出现在产品的模板列表里', () => {
    const store = useSopStore.getState()
    store.setPostTemplates('prod-1', [tpl('产品模板')])
    store.setPostTemplates('dir-1', [tpl('方向模板')])
    const next = useSopStore.getState().postTemplates
    expect(next['prod-1']?.map((item) => item.label)).toEqual(['产品模板'])
    expect(next['dir-1']?.map((item) => item.label)).toEqual(['方向模板'])
  })

  it('节点被彻底删除时，它的专属模板与预览底图一起清掉', () => {
    const store = useSopStore.getState()
    store.setPostTemplates('prod-1', [tpl('产品模板')])
    store.setPostTemplates('dir-1', [tpl('方向模板')])
    useSopStore.getState().setPostPreviewImage('dir-1', '9:16', 'img-1')

    const batchId = useSopStore.getState().trashNode('dir-1')
    useSopStore.getState().purgeTrashBatch(batchId)

    const next = useSopStore.getState()
    expect(next.postTemplates['dir-1']).toBeUndefined()
    expect(next.postTemplates['prod-1']).toHaveLength(1)
    expect(next.postPreviewImages['dir-1']).toBeUndefined()
  })
})
