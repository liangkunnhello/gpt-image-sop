import { beforeEach, describe, expect, it } from 'vitest'

import { createPostTemplate } from './postTemplate'
import { collectSopLibrary, mergeSopLibrary, useSopStore } from './sopStore'

const template = (productId: string, label: string) => ({
  ...createPostTemplate(1440, 2560, label),
  enabled: true,
})

describe('提示词库导入导出', () => {
  beforeEach(() => {
    useSopStore.setState({
      directions: [{ id: 'cat-1', parentId: null, name: '保险', kind: 'category' }],
      systemPrompts: [],
      presets: [],
      postTemplates: {},
      lastPick: {},
      defaultPick: {},
      ignoreCompliance: true,
      useImageSellingPoints: false,
      promptsPerGroup: 5,
      avoidOverlay: true,
    })
  })

  it('本地为空时整份恢复', () => {
    mergeSopLibrary({
      directions: [{ id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' }],
      systemPrompts: [{ id: 'sys-1', productId: 'prod-1', name: '默认', content: '内容', updatedAt: 1 }],
      presets: [{ id: 'p-1', productId: 'prod-1', kind: 'style', name: '扁平', content: '内容', updatedAt: 1 }],
      postTemplates: { 'prod-1': [template('prod-1', '9:16')] },
      lastPick: { 'dir-1': { pointId: 'p-1' } },
      defaultPick: {},
      promptsPerGroup: 8,
      avoidOverlay: false,
    })
    const state = useSopStore.getState()
    expect(state.directions.map((node) => node.id)).toEqual(['cat-1', 'prod-1'])
    expect(state.systemPrompts).toHaveLength(1)
    expect(state.presets).toHaveLength(1)
    expect(state.postTemplates['prod-1']).toHaveLength(1)
    expect(state.lastPick['dir-1']).toEqual({ pointId: 'p-1' })
    expect(state.promptsPerGroup).toBe(8)
    expect(state.avoidOverlay).toBe(false)
  })

  it('同 id 覆盖，不同 id 追加，本地独有的保留', () => {
    useSopStore.setState({
      presets: [
        { id: 'p-1', productId: 'prod-1', kind: 'point', name: '本地卖点', content: '本地', updatedAt: 1 },
        { id: 'p-2', productId: 'prod-1', kind: 'point', name: '本地独有', content: '本地', updatedAt: 1 },
      ],
      systemPrompts: [{ id: 'sys-1', productId: 'prod-1', name: '本地', content: '本地', updatedAt: 1 }],
    })
    mergeSopLibrary({
      directions: [],
      systemPrompts: [{ id: 'sys-1', productId: 'prod-1', name: '备份', content: '备份内容', updatedAt: 2 }],
      presets: [{ id: 'p-1', productId: 'prod-1', kind: 'point', name: '备份卖点', content: '备份', updatedAt: 2 }],
      postTemplates: {},
      lastPick: {},
      defaultPick: {},
    })
    const state = useSopStore.getState()
    expect(state.systemPrompts).toHaveLength(1)
    expect(state.systemPrompts[0].name).toBe('备份')
    expect(state.presets.map((item) => item.name).sort()).toEqual(['备份卖点', '本地独有'])
  })

  it('后处理模板按产品合并，不覆盖别的产品', () => {
    useSopStore.setState({ postTemplates: { 'prod-2': [template('prod-2', '方图')] } })
    mergeSopLibrary({
      directions: [],
      systemPrompts: [],
      presets: [],
      postTemplates: { 'prod-1': [template('prod-1', '9:16')] },
      lastPick: {},
      defaultPick: {},
    })
    const state = useSopStore.getState()
    expect(state.postTemplates['prod-1']).toHaveLength(1)
    expect(state.postTemplates['prod-2']).toHaveLength(1)
  })

  it('收集导出数据时带上当前提示词库', () => {
    useSopStore.setState({
      presets: [{ id: 'p-1', productId: 'prod-1', kind: 'point', name: '卖点', content: '内容', updatedAt: 1 }],
      postTemplates: { 'prod-1': [template('prod-1', '9:16')] },
    })
    const library = collectSopLibrary()
    expect(library.presets).toHaveLength(1)
    expect(library.postTemplates['prod-1']).toHaveLength(1)
    expect(library.directions.map((node) => node.id)).toEqual(['cat-1'])
    expect(library.promptsPerGroup).toBe(5)
  })
})

describe('按钮 / 引导点击开关', () => {
  beforeEach(() => {
    useSopStore.setState({ avoidCtaDesign: true })
  })

  it('默认开启，明确关掉后才关', () => {
    expect(useSopStore.getState().avoidCtaDesign).toBe(true)
    useSopStore.getState().setAvoidCtaDesign(false)
    expect(useSopStore.getState().avoidCtaDesign).toBe(false)
  })

  it('随提示词库一起备份与恢复', () => {
    useSopStore.getState().setAvoidCtaDesign(false)
    expect(collectSopLibrary().avoidCtaDesign).toBe(false)
    mergeSopLibrary({ ...collectSopLibrary(), avoidCtaDesign: true })
    expect(useSopStore.getState().avoidCtaDesign).toBe(true)
  })
})
