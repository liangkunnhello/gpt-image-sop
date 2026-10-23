import { describe, expect, it } from 'vitest'

import { finishedFileName, finishedFolderName } from './postFinished'
import type { SopDirectionNode } from '../types'

const directions: SopDirectionNode[] = [
  { id: 'prod-1', parentId: null, name: '百万医疗险', kind: 'product' },
  { id: 'dir-1', parentId: 'prod-1', name: '月亮', kind: 'direction' },
]

const task = {
  id: 'task-abcdef123456',
  createdAt: new Date('2026-10-23T10:00:00').getTime(),
  sopName: '月亮夜景',
  sopDirectionId: 'dir-1',
  params: { size: '2560x1440', output_format: 'jpeg' },
} as Parameters<typeof finishedFolderName>[0]

describe('finishedFileName', () => {
  it('序号补两位 + 分辨率 + 扩展名', () => {
    expect(finishedFileName(0, '2560x1440', 'jpeg')).toBe('01-2560x1440.jpg')
    expect(finishedFileName(2, '1024x1024', 'webp')).toBe('03-1024x1024.webp')
    expect(finishedFileName(10, '800x600', 'png')).toBe('11-800x600.png')
  })

  it('没有尺寸时写 auto，重跑时同名覆盖', () => {
    expect(finishedFileName(0, undefined, 'jpeg')).toBe('01-auto.jpg')
    // 同一张图重跑，名字必须一致才能覆盖
    expect(finishedFileName(0, '2560x1440', 'jpeg')).toBe(finishedFileName(0, '2560x1440', 'jpeg'))
  })
})

describe('finishedFolderName', () => {
  it('按设置的模板拼出产品与方向', () => {
    const folder = finishedFolderName(task, directions, '{product}-{direction}', undefined, 'prod-1')
    expect(folder).toBe('百万医疗险-月亮')
  })

  it('模板里的日期按任务创建时间取', () => {
    const folder = finishedFolderName(task, directions, '{date}-{product}', undefined, 'prod-1')
    expect(folder).toContain('百万医疗险')
    expect(folder).toMatch(/\d{4}/)
  })

  it('模板为空时走内置默认模板，不会是空串也带不出路径分隔符', () => {
    const folder = finishedFolderName(task, [], '', undefined, undefined)
    expect(folder).not.toBe('')
    expect(folder).not.toContain('/')
    expect(folder).not.toContain('\\')
  })
})
