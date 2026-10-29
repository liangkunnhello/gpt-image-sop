import { describe, expect, it } from 'vitest'

import {
  buildTaskFolderName,
  copyLabel,
  DEFAULT_TASK_FOLDER_TEMPLATE,
  MAX_CUSTOM_COPY_CHARS,
  MAX_POINT_NAME_CHARS,
  MAX_SOP_NAME_CHARS,
  sizeLabel,
  truncatePointName,
  truncateSopName,
  withCopyToken,
} from './taskFolderName'

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

  it('默认模板按 日期-产品-方向-尺寸-SOP-卖点-自定义 拼', () => {
    expect(buildTaskFolderName(DEFAULT_TASK_FOLDER_TEMPLATE, { ...context, pointName: '小病住院' }))
      .toBe('20261021-百万医疗险-月亮-大图-SOP A-小病住院-第三批')
  })

  it('没配卖点时整段跳过，不留空分隔符', () => {
    expect(buildTaskFolderName(DEFAULT_TASK_FOLDER_TEMPLATE, context)).toBe('20261021-百万医疗险-月亮-大图-SOP A-第三批')
  })

  /**
   * 「本次文案」要排在卖点**前面**。
   * 之前只在生图提示词里做了这个顺序，文件名模板里根本没这个占位符，
   * 导出的文件夹名里就看不到这一批临时换上的文案。
   */
  it('本次文案排在卖点前面', () => {
    expect(buildTaskFolderName(DEFAULT_TASK_FOLDER_TEMPLATE, { ...context, copy: '住院直付', pointName: '小病住院' }))
      .toBe('20261021-百万医疗险-月亮-大图-SOP A-住院直付-小病住院-第三批')
  })

  it('本次文案是多行时压成一行再截断，不会把名字撑开', () => {
    const name = copyLabel('住院直付\n不限社保范围\n0免赔')
    expect(name.includes('\n')).toBe(false)
    expect(Array.from(name).length).toBeLessThanOrEqual(MAX_CUSTOM_COPY_CHARS)
    expect(name.startsWith('住院直付')).toBe(true)
  })

  it('卖点名和 SOP 名一样按「字」截断，超长不会撑开名字', () => {
    const longPoint = '住院医疗费用报销额度高达六百万且不限社保范围'
    expect(Array.from(truncatePointName(longPoint))).toHaveLength(MAX_POINT_NAME_CHARS)
    expect(buildTaskFolderName('{product}-{point}', { product: '京东保', pointName: longPoint }))
      .toBe(`京东保-${truncatePointName(longPoint)}`)
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

describe('SOP 名截断', () => {
  it('超长 SOP 名只保留前 6 个字', () => {
    const long = '2D手绘风信息流广告图生图SOP（保险类·文字型主体）'
    expect(truncateSopName(long)).toBe(long.slice(0, MAX_SOP_NAME_CHARS))
    expect(Array.from(truncateSopName(long)).length).toBe(6)
  })

  it('不足 6 个字原样保留，不做补位', () => {
    expect(truncateSopName('月亮图')).toBe('月亮图')
    expect(truncateSopName('')).toBe('')
    expect(truncateSopName(undefined)).toBe('')
  })

  it('按字算长度，emoji 不会被劈成半个', () => {
    expect(truncateSopName('🎨🎨🎨🎨🎨🎨🎨')).toBe('🎨🎨🎨🎨🎨🎨')
    expect(truncatePointName('🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨')).toBe(truncatePointName('🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨'))
    expect(Array.from(truncatePointName('🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨🎨'))).toHaveLength(MAX_POINT_NAME_CHARS)
  })

  it('文件夹名与文件名共用这套截断', () => {
    const name = buildTaskFolderName('{date}-{product}-{direction}-{size}-{sop}', {
      date: new Date(2026, 9, 26),
      product: '京东保',
      direction: '大字报',
      size: '1280x720',
      sopName: '2D手绘风信息流广告图生图SOP（保险类·文字型主体）',
    })
    expect(name).toBe('20261026-京东保-大字报-大图-2D手绘风信')
  })
})

describe('withCopyToken（老模板自动补 {copy}）', () => {
  it('把 {copy} 补在 {point} 前面', () => {
    expect(withCopyToken('{date}-{product}-{point}-{custom}')).toBe('{date}-{product}-{copy}-{point}-{custom}')
  })

  it('已经在用 {copy} 的模板原样返回，重复执行不会叠加', () => {
    const template = '{date}-{copy}-{point}'
    expect(withCopyToken(template)).toBe(template)
    expect(withCopyToken(withCopyToken('{date}-{point}'))).toBe('{date}-{copy}-{point}')
  })

  it('模板里没有 {point} 就不动', () => {
    expect(withCopyToken('{date}-{custom}')).toBe('{date}-{custom}')
  })

  it('空模板原样留着，退回默认是拼名字时的事', () => {
    // 设置里允许清空重输，这里替它填默认值会让输入框自己长出内容
    expect(withCopyToken('')).toBe('')
    expect(withCopyToken('   ')).toBe('   ')
  })
})
