// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  checkPromptCopy,
  describeCopyIssues,
  extractQuotedCopy,
  splitCopyLines,
  splitCopyNote,
} from './copyCheck'
import { fixPromptCopy } from './sopPipeline'
import type { ApiProfile } from '../types'

const profile = {
  id: 'p1',
  name: 'test',
  provider: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  timeout: 60,
  apiMode: 'chat',
  codexCli: false,
  apiProxy: false,
} as unknown as ApiProfile

const COPY = '600 万医疗保障\n住院 0 免赔'

function mockReply(content: string) {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('splitCopyLines', () => {
  it('一行一条，忽略空行与列表符号', () => {
    expect(splitCopyLines('A\n\n- B\n• C\n  \n')).toEqual(['A', 'B', 'C'])
  })
})

describe('extractQuotedCopy', () => {
  it('取出全部「」文案，忽略空格', () => {
    expect(extractQuotedCopy('主标题「600 万医疗保障」，角标「住院 0 免赔」')).toEqual([
      '600 万医疗保障',
      '住院 0 免赔',
    ])
  })
})

describe('checkPromptCopy', () => {
  const good = '左图右文，主标题「600 万医疗保障」，副标题「住院 0 免赔」，暖色。'

  it('卖点逐字一致时通过', () => {
    expect(checkPromptCopy([good], COPY)).toEqual({ ok: true, issues: [] })
  })

  it('标点、空格、全半角差异不算不一致', () => {
    const loose = '主标题「600万医疗保障」，副标题「住院0免赔」'
    expect(checkPromptCopy([loose], COPY).ok).toBe(true)
  })

  it('漏掉一条卖点会报缺失', () => {
    const missing = '主标题「600 万医疗保障」'
    const result = checkPromptCopy([missing], COPY)
    expect(result.ok).toBe(false)
    expect(result.issues.some((item) => item.kind === 'missing' && item.detail === '住院 0 免赔')).toBe(true)
  })

  it('改写或缩写会同时报缺失与改写', () => {
    const altered = '主标题「600万保额」，副标题「住院0免赔」'
    const kinds = checkPromptCopy([altered], COPY).issues.map((item) => item.kind)
    expect(kinds).toContain('altered')
    expect(kinds).toContain('missing')
  })

  it('自己加卖点以外的文字也会被抓到', () => {
    const extra = '主标题「600 万医疗保障」，副标题「住院 0 免赔」，角标「限时抢购」'
    const result = checkPromptCopy([extra], COPY)
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([{ index: 0, kind: 'altered', detail: '限时抢购' }])
  })

  it('长度小于 2 的碎片不当成改写（如 ¥、1）', () => {
    const short = '主标题「600 万医疗保障」，副标题「住院 0 免赔」，角标「¥」'
    expect(checkPromptCopy([short], COPY).ok).toBe(true)
  })

  it('没有卖点时不校验', () => {
    expect(checkPromptCopy([good], '  ').ok).toBe(true)
  })

  it('多条提示词各自判定，issue 带上是第几条', () => {
    const result = checkPromptCopy([good, '主标题「600 万医疗保障」'], COPY)
    expect(result.issues.every((item) => item.index === 1)).toBe(true)
  })
})

describe('splitCopyNote', () => {
  it('拆出正文与结尾括号说明', () => {
    expect(splitCopyNote('大病小病均可保障(责任内)')).toEqual({ main: '大病小病均可保障', note: '责任内' })
  })

  it('全角括号同样识别', () => {
    expect(splitCopyNote('涵盖120万元特效抗癌针（责任内）。')).toEqual({ main: '涵盖120万元特效抗癌针', note: '责任内' })
  })

  it('没有括号说明时 note 为空', () => {
    expect(splitCopyNote('赔付总限额600万')).toEqual({ main: '赔付总限额600万', note: '' })
  })

  it('正文中间的括号不算结尾说明', () => {
    expect(splitCopyNote('投保（限时）条件0~70岁')).toEqual({ main: '投保（限时）条件0~70岁', note: '' })
  })
})

/**
 * 真实事故：卖点里两句都带「(责任内)」，模型判成重复、删掉后一个，
 * 提示词里留下「第四条内为主句「大病小病均可保障」及下方小字，」这种空壳，
 * 旧校验按「互相包含即相同」直接放行，废图一路出了。任务 mw1kvds69sed9u。
 */
describe('checkPromptCopy 括号说明', () => {
  const NOTE_COPY = '有无社保均可办理(责任内)\n大病小病均可保障(责任内)'
  const tail = '，排完自然留白收尾画面上无按钮。'

  it('两处括号说明都写了就通过', () => {
    const prompt = `第三条内为主句「有无社保均可办理」及下方小字「(责任内)」，第四条内为主句「大病小病均可保障」及下方小字「(责任内)」${tail}`
    expect(checkPromptCopy([prompt], NOTE_COPY)).toEqual({ ok: true, issues: [] })
  })

  it('只留一处括号说明，另一处留空壳要报缺失', () => {
    const prompt = `第三条内为主句「有无社保均可办理」及下方小字「(责任内)」，第四条内为主句「大病小病均可保障」及下方小字${tail}`
    const result = checkPromptCopy([prompt], NOTE_COPY)
    expect(result.ok).toBe(false)
    expect(result.issues).toEqual([
      { index: 0, kind: 'missing', detail: '大病小病均可保障(责任内)' },
    ])
  })

  it('整条提示词里一次都没写括号说明要报缺失', () => {
    const prompt = `第三条内为主句「有无社保均可办理」，第四条内为主句「大病小病均可保障」${tail}`
    const missing = checkPromptCopy([prompt], NOTE_COPY).issues.filter((item) => item.kind === 'missing')
    expect(missing).toHaveLength(2)
  })

  it('正文本身缺失时只报一次，不因定位不到再重复报', () => {
    const prompt = `第三条内为主句「有无社保均可办理」及下方小字「(责任内)」${tail}`
    const hits = checkPromptCopy([prompt], NOTE_COPY).issues
      .filter((item) => item.detail === '大病小病均可保障(责任内)')
    expect(hits).toHaveLength(1)
  })
})

describe('describeCopyIssues', () => {
  it('按缺失与改写分类汇总', () => {
    const text = describeCopyIssues([
      { index: 0, kind: 'missing', detail: 'A' },
      { index: 1, kind: 'altered', detail: 'B' },
      { index: 2, kind: 'altered', detail: 'C' },
    ])
    expect(text).toBe('1 处卖点缺失、2 处文案被改写')
  })
})

describe('fixPromptCopy', () => {
  it('条数一致时采用模型修正结果', async () => {
    mockReply('1. 主标题「600 万医疗保障」，副标题「住院 0 免赔」\n2. 主标题「住院 0 免赔」，副标题「600 万医疗保障」')
    const fixed = await fixPromptCopy(profile, ['旧 1', '旧 2'], COPY)
    expect(fixed).toHaveLength(2)
    expect(fixed[0]).toContain('600 万医疗保障')
    expect(fixed[1]).toContain('住院 0 免赔')
  })

  it('条数对不上时退回原提示词，不弄乱整批', async () => {
    mockReply('1. 只有一条')
    const originals = ['旧 1', '旧 2']
    expect(await fixPromptCopy(profile, originals, COPY)).toEqual(originals)
  })

  it('请求里带上卖点原文与校正要求', async () => {
    const fetchMock = mockReply('1. A\n2. B')
    await fixPromptCopy(profile, ['旧 1', '旧 2'], COPY)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.messages[0].content).toContain('只改被「」包裹的文字')
    expect(body.messages[1].content).toContain('600 万医疗保障')
    expect(body.messages[1].content).toContain('旧 1')
    // 校对用低温度，避免自由发挥
    expect(body.temperature).toBe(0.2)
  })
})
