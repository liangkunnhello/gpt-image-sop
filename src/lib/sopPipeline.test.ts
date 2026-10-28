// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiProfile } from '../types'
import { appendCopySection, buildPromptMessages, buildSopSystemPrompt, generatePrompts, rewriteSopText, sopTitleOf, stripButtonPlaceholders } from './sopPipeline'
import { MAX_PROMPTS_PER_RUN, PROMPTS_PER_BATCH } from './promptLimits'

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
    // 结构由 SOP 自己决定，请求里不再写死某几个小节
    expect(system).toContain('必须保持原文已有的小节结构与标题')
    expect(system).not.toContain('## 适用场景')
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

/** 按调用次序依次返回不同内容；用完最后一组后一直重复它 */
function mockSequence(contents: string[]) {
  let cursor = 0
  const fetchMock = vi.fn(async () => {
    const content = contents[Math.min(cursor, contents.length - 1)]
    cursor += 1
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 生成一段编号列表，第 n 条带「场景n」便于校验顺序 */
function numbered(from: number, count: number, tail = '夜晚街道，正面机位，暖色调'): string {
  return Array.from({ length: count }, (_, i) => `${i + 1}. 场景${from + i}，${tail}`).join('\n')
}

describe('generatePrompts 分批写', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('条数不超过单批时只请求一次（原行为不变）', async () => {
    const fetchMock = mockSequence([numbered(1, 5)])
    const prompts = await generatePrompts(profile, SOP, 5)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(prompts).toHaveLength(5)
  })

  it('要 30 条时按批循环写满，进度逐批回调', async () => {
    const perBatch = PROMPTS_PER_BATCH
    const fetchMock = mockSequence([
      numbered(1, perBatch),
      numbered(perBatch + 1, perBatch),
      numbered(perBatch * 2 + 1, 6),
    ])
    const progress: Array<[number, number]> = []
    const prompts = await generatePrompts(profile, SOP, 30, true, '', '', false, (written, total) => {
      progress.push([written, total])
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(prompts).toHaveLength(30)
    expect(progress[progress.length - 1]).toEqual([30, 30])
    // 编号必须接着往下走，不能每批都从「场景1」重来
    expect(prompts[0]).toContain('场景1')
    expect(prompts[29]).toContain('场景30')
  })

  it('第二批请求里带上已写好的条目，并明确要求避重', async () => {
    const fetchMock = mockSequence([
      numbered(1, PROMPTS_PER_BATCH),
      numbered(PROMPTS_PER_BATCH + 1, PROMPTS_PER_BATCH),
    ])
    await generatePrompts(profile, SOP, PROMPTS_PER_BATCH * 2)
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body),
    )
    const user = secondBody.messages[1].content as string
    expect(user).toContain('已经写好的提示词')
    expect(user).toContain('场景1')
    // 每批只请求这一批的条数，不能又按总数要一次
    expect(user).toContain(`写 ${PROMPTS_PER_BATCH} 条提示词`)
  })

  it('跨批逐字重复的条目会被丢掉，不占总数', async () => {
    const repeated = numbered(1, 8)
    mockSequence([
      numbered(1, PROMPTS_PER_BATCH),
      // 第二批前 8 条与第一批逐字相同，只有后面几条是新的
      `${repeated}\n${numbered(100, 4)}`,
    ])
    const prompts = await generatePrompts(profile, SOP, PROMPTS_PER_BATCH + 4)
    expect(prompts).toHaveLength(PROMPTS_PER_BATCH + 4)
    expect(new Set(prompts).size).toBe(prompts.length)
    expect(prompts.some((item) => item.includes('场景100'))).toBe(true)
  })

  it('条数超过上限时按上限算', async () => {
    const fetchMock = mockSequence([numbered(1, 50)])
    const prompts = await generatePrompts(profile, SOP, MAX_PROMPTS_PER_RUN + 500)
    expect(prompts.length).toBeLessThanOrEqual(MAX_PROMPTS_PER_RUN)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('appendCopySection 卖点并入存档 SOP', () => {
  it('把卖点作为最高优先级一节附到末尾', () => {
    const merged = appendCopySection(SOP, '赔付总限额600万')
    expect(merged).toContain('# 卖点文案（最高优先级 · 图上文字的唯一来源）')
    expect(merged).toContain('赔付总限额600万')
    // 原 SOP 内容一字不动，标题还能从「SOP 名称」取到
    expect(merged).toContain('不画按钮，不加引导点击的箭头。')
    expect(sopTitleOf(merged, '兜底')).toBe('百万医疗险 · 月亮夜景')
  })

  it('已带卖点一节时不重复加', () => {
    const once = appendCopySection(SOP, '赔付总限额600万')
    const twice = appendCopySection(once, '赔付总限额600万')
    expect(twice).toBe(once)
  })

  it('卖点为空时原样返回', () => {
    expect(appendCopySection(SOP, '  ')).toBe(SOP)
  })

  it('buildPromptMessages 提示 SOP 禁忌与卖点冲突时以卖点为准', () => {
    const { system } = buildPromptMessages({
      sopText: SOP,
      count: 1,
      copyText: '赔付总限额600万',
    })
    expect(system).toContain('以卖点为准')
    expect(system).toContain('画面不出现任何文字')
  })

  it('没有卖点时不出现冲突规则', () => {
    const { system } = buildPromptMessages({ sopText: SOP, count: 1 })
    expect(system).not.toContain('以卖点为准')
  })
})

describe('按钮形占位与叠字约束', () => {
  const SOP_WITH_BUTTON = [
    '## 版式结构',
    '卡片内包含标题、卖点列表和底部按钮（注：SOP 不生成按钮，仅留出按钮位置）。',
    '',
    '## 必守与禁忌',
    '1. **必守**：必须留出底部按钮位置（但不生成按钮）。',
    '2. **禁忌**：不画按钮、不画手指点击示意。',
  ].join('\n')

  it('去掉「留出按钮位置」这类要求，保留「不画按钮」的禁忌', () => {
    const cleaned = stripButtonPlaceholders(SOP_WITH_BUTTON)
    expect(cleaned).not.toContain('留出按钮位置')
    expect(cleaned).not.toContain('留出按钮位置（但不生成按钮）')
    expect(cleaned).toContain('不画按钮、不画手指点击示意')
  })

  it('写提示词时带一段明确的禁止占位说明，并已把 SOP 里的按钮位要求剔掉', () => {
    const { user } = buildPromptMessages({
      sopText: SOP_WITH_BUTTON,
      count: 1,
      copyText: '赔付总限额600万',
      avoidCta: true,
    })
    expect(user).toContain('禁止按钮形占位')
    expect(user).toContain('空白胶囊')
    // SOP 正文里那句「必须留出底部按钮位置」已被剔掉（禁止说明里会提到这个词，所以按原句判断）
    expect(user).not.toContain('必须留出底部按钮位置')
    expect(user).not.toContain('仅留出按钮位置')
  })

  it('关掉「不要按钮」时不加这段说明', () => {
    const { user } = buildPromptMessages({ sopText: SOP_WITH_BUTTON, count: 1, avoidCta: false })
    expect(user).not.toContain('禁止按钮形占位')
    expect(user).toContain('留出按钮位置')
  })

  it('system 里禁止空白胶囊占位，并要求文字单层不叠字', () => {
    const { system } = buildPromptMessages({ sopText: SOP_WITH_BUTTON, count: 1, avoidCta: true })
    expect(system).toContain('空白胶囊')
    expect(system).toContain('叠字')
  })
})

describe('反推 SOP 时一并注入后期预留区与按钮规则', () => {
  it('版式要给预留区让位，且禁写「留出按钮位置」', () => {
    const prompt = buildSopSystemPrompt(true, false, true, undefined, '左上角（后期叠Logo）、底部居中（后期叠警示语）')
    expect(prompt).toContain('左上角（后期叠Logo）')
    expect(prompt).toContain('不是画一个空白边框或空块去「占位」')
    expect(prompt).toContain('不要给按钮留坑')
  })

  it('关掉按钮避让、没有预留区时两条规则都不出现', () => {
    const prompt = buildSopSystemPrompt(false, false, false)
    expect(prompt).not.toContain('不要给按钮留坑')
    expect(prompt).not.toContain('后期预留区')
  })
})
