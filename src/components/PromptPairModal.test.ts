import { describe, expect, it } from 'vitest'

import type { TaskRecord } from '../types'
import { buildPairRows } from './PromptPairModal'

function makeTask(patch: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'id',
    prompt: '',
    status: 'done',
    error: null,
    outputImages: [],
    inputImageIds: [],
    createdAt: 0,
    finishedAt: null,
    elapsed: null,
    sopJobId: 'job-1',
    ...patch,
  } as unknown as TaskRecord
}

describe('buildPairRows（图片与提示词对照）', () => {
  it('每条提示词只认自己产出的图，不会串到别的条目', () => {
    const rows = buildPairRows([
      makeTask({ id: 'a', sopPromptIndex: 1, prompt: '提示词甲', outputImages: ['img-a'] }),
      makeTask({ id: 'b', sopPromptIndex: 2, prompt: '提示词乙', outputImages: ['img-b1', 'img-b2'] }),
      makeTask({ id: 'c', sopPromptIndex: 3, prompt: '提示词丙', outputImages: ['img-c'] }),
    ])
    expect(rows.map((row) => row.images)).toEqual([['img-a'], ['img-b1', 'img-b2'], ['img-c']])
    expect(rows[1].prompt).toBe('提示词乙')
    // 一条提示词可以出多张图（n>1），两张都归它
    expect(rows[1].images).toHaveLength(2)
  })

  it('按 sopPromptIndex 排序，不依赖数组原有顺序', () => {
    const rows = buildPairRows([
      makeTask({ id: 'third', sopPromptIndex: 3, prompt: '三', outputImages: ['i3'] }),
      makeTask({ id: 'first', sopPromptIndex: 1, prompt: '一', outputImages: ['i1'] }),
      makeTask({ id: 'second', sopPromptIndex: 2, prompt: '二', outputImages: ['i2'] }),
    ])
    expect(rows.map((row) => row.prompt)).toEqual(['一', '二', '三'])
  })

  it('没出图的任务也保留一行，不留空档', () => {
    const rows = buildPairRows([
      makeTask({ id: 'a', sopPromptIndex: 1, prompt: '有图', outputImages: ['i1'] }),
      makeTask({ id: 'b', sopPromptIndex: 2, prompt: '失败', outputImages: [], status: 'error', error: 'HTTP 500' }),
      makeTask({ id: 'c', sopPromptIndex: 3, prompt: '进行中', outputImages: [], status: 'running' }),
    ])
    expect(rows).toHaveLength(3)
    expect(rows[1].images).toEqual([])
    expect(rows[1].status).toBe('error')
    expect(rows[1].error).toBe('HTTP 500')
    expect(rows[2].status).toBe('running')
  })

  it('占位卡不进对照表', () => {
    const rows = buildPairRows([
      makeTask({ id: 'p', sopPromptIndex: 0, prompt: '正在反推', status: 'running', sopPlaceholder: true }),
      makeTask({ id: 'a', sopPromptIndex: 1, prompt: '真任务', outputImages: ['i1'] }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].prompt).toBe('真任务')
  })

  it('缺 sopPromptIndex 时按位置补序号', () => {
    const rows = buildPairRows([
      makeTask({ id: 'a', prompt: '甲', outputImages: ['i1'] }),
      makeTask({ id: 'b', prompt: '乙', outputImages: ['i2'] }),
    ])
    expect(rows.map((row) => row.index)).toEqual([1, 2])
  })

  it('带上变量取值与策略名，方便看相邻两条差在哪', () => {
    const rows = buildPairRows([
      makeTask({
        id: 'a',
        sopPromptIndex: 1,
        prompt: '一条提示词',
        outputImages: ['i1'],
        variableMode: true,
        variableSkeleton: '中心核心与外围阵列',
        variableAssignments: { 承载结构: '圆盘', 主体: '光核' },
      }),
    ])
    expect(rows[0].strategy).toBe('中心核心与外围阵列')
    expect(rows[0].assignments).toEqual({ 承载结构: '圆盘', 主体: '光核' })
  })

  it('方向名从方向树里取，取不到留空', () => {
    const directions = [{ id: 'dir-1', name: '月亮' }]
    const rows = buildPairRows([
      makeTask({ id: 'a', sopPromptIndex: 1, sopDirectionId: 'dir-1' }),
      makeTask({ id: 'b', sopPromptIndex: 2, sopDirectionId: 'dir-missing' }),
      makeTask({ id: 'c', sopPromptIndex: 3 }),
    ], directions)
    expect(rows.map((row) => row.direction)).toEqual(['月亮', '', ''])
  })

  it('图片总数等于各行图片数之和，一张不多一张不少', () => {
    const tasks = [
      makeTask({ id: 'a', sopPromptIndex: 1, outputImages: ['i1', 'i2'] }),
      makeTask({ id: 'b', sopPromptIndex: 2, outputImages: ['i3'] }),
    ]
    const rows = buildPairRows(tasks)
    expect(rows.reduce((sum, row) => sum + row.images.length, 0)).toBe(3)
    // 与详情页摊平后的总数一致，说明没漏也没重复
    expect(tasks.flatMap((task) => task.outputImages)).toHaveLength(3)
  })

  it('空列表返回空数组', () => {
    expect(buildPairRows([])).toEqual([])
  })

  it('按任务自身是否变量模式打标，决定强调色', () => {
    const rows = buildPairRows([
      makeTask({ id: 'a', sopPromptIndex: 1, variableMode: true }),
      makeTask({ id: 'b', sopPromptIndex: 2 }),
    ])
    expect(rows.map((row) => row.variableMode)).toEqual([true, false])
  })
})

describe('对照表里不进回收站的图', () => {
  it('移入图片回收站的那张不出现在对照表里，其余照常', () => {
    const rows = buildPairRows([
      makeTask({ id: 'a', sopPromptIndex: 1, prompt: '甲', outputImages: ['img-a1', 'img-a2'], trashedOutputImages: ['img-a2'] }),
      makeTask({ id: 'b', sopPromptIndex: 2, prompt: '乙', outputImages: ['img-b'] }),
    ])
    expect(rows.map((row) => row.images)).toEqual([['img-a1'], ['img-b']])
  })

  it('一张都进回收站的那条提示词，图列表为空但条目还在', () => {
    const rows = buildPairRows([
      makeTask({ id: 'a', sopPromptIndex: 1, prompt: '甲', outputImages: ['img-a'], trashedOutputImages: ['img-a'] }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].images).toEqual([])
  })
})
