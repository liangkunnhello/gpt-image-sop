import { describe, expect, it } from 'vitest'

import type { TaskRecord } from '../types'
import type { AssetRecord } from './trackDb'
import { buildAssetFileIndex, matchAssetKeyword, matchReportRowKeyword } from './assetSearch'

const asset = (overrides: Partial<AssetRecord> = {}): AssetRecord => ({
  id: 'asset-hash-1234',
  taskId: 'task-1',
  platformIds: ['10086'],
  reportNames: [],
  createdAt: 1,
  ...overrides,
})

const tasks: Array<Pick<TaskRecord, 'id' | 'deliveredFileNames' | 'deliverFolder'>> = [
  {
    id: 'task-1',
    deliveredFileNames: {
      'img-1': '20261110-京东保-扁平插画-头条-闪屏-01.jpeg',
      'img-2': '20261110-京东保-扁平插画-头条-闪屏-02.jpeg',
    },
    deliverFolder: '20261110-京东保-扁平插画-头条-闪屏',
  },
]

describe('按文件名搜索素材', () => {
  const index = buildAssetFileIndex(tasks)
  const info = index.get('task-1')

  it('带扩展名、不带扩展名都能命中', () => {
    expect(matchAssetKeyword(asset(), info, '闪屏-01.jpeg')).toBe(true)
    expect(matchAssetKeyword(asset(), info, '闪屏-01')).toBe(true)
  })

  it('「文件夹/文件名」整体也能命中', () => {
    expect(matchAssetKeyword(asset(), info, '扁平插画-头条-闪屏/20261110-京东保-扁平插画-头条-闪屏-02.jpeg')).toBe(true)
  })

  it('报表里的图片名称也能命中（平台改写过的名字）', () => {
    const withReport = asset({ reportNames: ['京东保_闪屏_600万_v3'] })
    expect(matchAssetKeyword(withReport, info, '闪屏_600万')).toBe(true)
  })

  it('平台素材 ID 能命中', () => {
    expect(matchAssetKeyword(asset(), info, '10086')).toBe(true)
  })

  it('大小写与空格不影响', () => {
    const mixed = asset({ reportNames: ['JD_Flash Screen_600W'] })
    expect(matchAssetKeyword(mixed, info, 'jd_flash screen')).toBe(true)
  })

  it('没交付过的卡只能靠报表名和平台 ID 搜到', () => {
    const noDelivery = buildAssetFileIndex([{ id: 'task-2', deliveredFileNames: {}, deliverFolder: '' }])
    expect(noDelivery.get('task-2')).toBeUndefined()
    expect(matchAssetKeyword(asset({ taskId: 'task-2', platformIds: ['777'] }), undefined, '闪屏-01')).toBe(false)
    expect(matchAssetKeyword(asset({ taskId: 'task-2', platformIds: ['777'] }), undefined, '777')).toBe(true)
  })

  it('关键字为空时不筛', () => {
    expect(matchAssetKeyword(asset(), info, '   ')).toBe(true)
  })

  it('报表行：未挂接本地图的按平台 ID 命中', () => {
    expect(matchReportRowKeyword({ key: 'pid:5555' }, undefined, undefined, '5555')).toBe(true)
    expect(matchReportRowKeyword({ key: 'pid:5555' }, undefined, undefined, '闪屏-01')).toBe(false)
  })

  it('报表行：有本地图的按文件名命中', () => {
    expect(matchReportRowKeyword({ assetId: 'asset-hash-1234', key: 'asset-hash-1234' }, asset(), info, '闪屏-02')).toBe(true)
  })
})
