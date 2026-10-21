import { describe, expect, it } from 'vitest'

import { buildTaskFolderName, DEFAULT_TASK_FOLDER_TEMPLATE, sizeLabel } from './taskFolderName'

describe('sizeLabel', () => {
  it('1280x720 叫大图，1080x1920 叫闪屏', () => {
    expect(sizeLabel('1280x720')).toBe('大图')
    expect(sizeLabel('1080x1920')).toBe('闪屏')
    expect(sizeLabel('1280×720')).toBe('大图')
  })

  it('其他尺寸直接写分辨率', () => {
    expect(sizeLabel('1024x1024')).toBe('1024x1024')
    expect(sizeLabel('2048*1152')).toBe('2048x1152')
    expect(sizeLabel('')).toBe('')
  })
})

describe('buildTaskFolderName', () => {
  const context = {
    date: new Date(2026, 9, 21),
    product: '百万医疗险',
    direction: '月亮',
    size: '1280x720',
    sopName: 'SOP A',
    custom: '第三批',
  }

  it('默认模板按 日期-产品-方向-尺寸-SOP-自定义 拼', () => {
    expect(buildTaskFolderName(DEFAULT_TASK_FOLDER_TEMPLATE, context)).toBe('20261021-百万医疗险-月亮-大图-SOP A-第三批')
  })

  it('没填的段自动省略，不留下多余分隔符', () => {
    expect(buildTaskFolderName(DEFAULT_TASK_FOLDER_TEMPLATE, { date: new Date(2026, 0, 5), product: '京东保', size: '1080x1920' }))
      .toBe('20260105-京东保-闪屏')
  })

  it('自定义模板、换顺序都生效', () => {
    expect(buildTaskFolderName('{product}/{direction}/{date}', context)).toBe('百万医疗险-月亮-20261021')
  })

  it('去掉文件名里的非法字符', () => {
    const name = buildTaskFolderName(DEFAULT_TASK_FOLDER_TEMPLATE, { ...context, product: '保险/医疗:险', sopName: 'SOP?"A"' })
    expect(name).not.toMatch(/[<>:"/\\|?*]/)
    expect(name).toContain('保险-医疗-险')
  })

  it('模板为空时退回默认模板', () => {
    expect(buildTaskFolderName('   ', context)).toContain('20261021-百万医疗险')
  })
})
