import { describe, expect, it } from 'vitest'

import { CHANNELS, NO_CHANNEL, channelLabel, taskMatchesChannel } from './channel'

describe('渠道清单', () => {
  it('固定这 6 项，取值唯一', () => {
    expect(CHANNELS.map((item) => item.label)).toEqual(['AI原图', '广点通', '头条', '百度', '厂商'])
    expect(new Set(CHANNELS.map((item) => item.value)).size).toBe(CHANNELS.length)
  })
})

describe('channelLabel', () => {
  it('已知渠道返回中文名', () => {
    expect(channelLabel('baidu')).toBe('百度')
    expect(channelLabel('gdt')).toBe('广点通')
  })

  it('未设置时返回「未指定」', () => {
    expect(channelLabel(undefined)).toBe('未指定')
    expect(channelLabel('')).toBe('未指定')
    expect(channelLabel(null)).toBe('未指定')
  })

  it('遇到未知取值原样显示，不吞掉数据', () => {
    expect(channelLabel('weibo')).toBe('weibo')
  })
})

describe('taskMatchesChannel', () => {
  it('不限时不看渠道', () => {
    expect(taskMatchesChannel({ channel: 'baidu' }, null)).toBe(true)
    expect(taskMatchesChannel({}, null)).toBe(true)
    expect(taskMatchesChannel({ channel: 'baidu' }, 'all')).toBe(true)
  })

  it('指定渠道时只命中该渠道', () => {
    expect(taskMatchesChannel({ channel: 'baidu' }, 'baidu')).toBe(true)
    expect(taskMatchesChannel({ channel: 'gdt' }, 'baidu')).toBe(false)
  })

  it('筛「未指定」只出没有渠道的卡', () => {
    expect(taskMatchesChannel({}, NO_CHANNEL)).toBe(true)
    expect(taskMatchesChannel({ channel: undefined }, NO_CHANNEL)).toBe(true)
    expect(taskMatchesChannel({ channel: 'baidu' }, NO_CHANNEL)).toBe(false)
  })
})
