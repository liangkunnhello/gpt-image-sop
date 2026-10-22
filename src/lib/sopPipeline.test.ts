// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiProfile } from '../types'
import { rewriteSopText } from './sopPipeline'

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
  transparentBackgroundMethod: 'local',
} as unknown as ApiProfile

const SOP = [
  '## SOP 名称',
  '百万医疗险 · 月亮夜景',
  '',
  '## 适用场景',
  '夜间投放的信息流首图。',
  '',
  '## 版式结构',
  '左侧人物，右侧大字标题。',
  '',
  '## 必守与禁忌',
  '不画按钮，不加引导点击的箭头。',
].join('\n')

/** 把模型回复塞进 chat/completions 的标准响应结构 */
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

describe('rewriteSopText', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('返回改写后的 SOP 正文，保留小节结构', async () => {
    const next = SOP.replace('左侧人物，右侧大字标题。', '右侧人物，左侧大字标题。')
    mockReply(next)
    expect(await rewriteSopText(profile, SOP, '人物换到右边')).toBe(next)
  })

  it('去掉模型包的 markdown 代码块', async () => {
    const next = SOP.replace('夜间投放', '白天投放')
    mockReply('```markdown\n' + next + '\n```')
    expect(await rewriteSopText(profile, SOP, '改成白天')).toBe(next)
  })

  it('请求里带上原文和修改要求，且要求只输出正文', async () => {
    const fetchMock = mockReply(SOP)
    await rewriteSopText(profile, SOP, '更简洁')
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    const system = body.messages[0].content as string
    const user = body.messages[1].content as string
    // 关键：不能沿用「第一行名称 + 空行 + 正文」那套输出约定
    expect(system).toContain('只输出改写后的完整 SOP 正文')
    expect(system).toContain('## SOP 名称')
    expect(user).toContain(SOP)
    expect(user).toContain('更简洁')
  })

  it('模型返回不像 SOP 的内容时抛错，不覆盖原文', async () => {
    mockReply('好的，我帮您把夜景改成了日景，看起来更明亮一些。')
    await expect(rewriteSopText(profile, SOP, '改成白天')).rejects.toThrow('不像 SOP')
  })

  it('模型返回空内容时抛错', async () => {
    mockReply('   ')
    await expect(rewriteSopText(profile, SOP, '改一下')).rejects.toThrow('空内容')
  })

  it('只有小节的 SOP 也能通过（没有「SOP 名称」这一节时按标题判断）', async () => {
    const partial = ['## 版式结构', '左图右文。', '', '## 必守与禁忌', '不画按钮。'].join('\n')
    mockReply(partial.replace('左图右文。', '上图下文。'))
    expect(await rewriteSopText(profile, partial, '改成上图下文')).toContain('上图下文')
  })
})
