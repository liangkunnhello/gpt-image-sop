// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiProfile } from '../types'
import { appendCopySection, buildPromptMessages, buildSopSystemPrompt, dedupeScenes, generatePrompts, needsLayoutOptimize, resolveSopTextModel, rewriteSopText, sceneSimilarity, SOP_TEXT_MODEL, sopTitleOf, stripButtonPlaceholders } from './sopPipeline'
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

/**
 * 两阶段 mock：按 system 提示区分「规划画面方案」与「写正文」。
 *
 * 两阶段之后不能再按调用顺序喂固定回复 —— 并行写词时各批完成先后不确定，
 * 顺序喂会串错。这里按请求内容回应，才测得出真实行为。
 */
const PLAN_MARKER = '生图策划'

/**
 * 四个词池的长度两两互质（17 / 13 / 11 / 7）。
 *
 * 一开始用 16/8/8/6 这种有公约数的长度，结果 i 与 i+24 会「场景不同、
 * 人物同、色调同、机位同」，2-gram 相似度直接超过阈值，被 dedupeScenes 判成重复，
 * 规划条数不够就退回顺序路径 —— 测出来的现象是「模型返回空内容」，很误导。
 * 互质之后任意两条至少有三项不同，才符合「四项里至少三项不同」的规划要求。
 */
const SCENE_WORDS = [
  '公园林荫道', '城市天台花园', '居家飘窗角落', '海边栈桥', '校园操场', '街角咖啡馆',
  '山地草甸', '地铁站台', '书房窗边', '清晨菜市场', '楼顶泳池边', '乡间土路',
  '美术馆长廊', '健身房一角', '儿童游乐区', '老城巷口', '湖心凉亭',
]
const PEOPLE_WORDS = ['母女二人', '独处青年', '祖孙三代', '情侣二人', '父子二人', '姐妹三人', '一家四口', '独处老人', '并肩同事', '兄弟二人', '母女三代', '情侣带宠物', '独处少年']
const COLOR_WORDS = ['薄荷绿配奶白', '暖橙配深棕', '雾蓝配浅灰', '蜜桃粉配米白', '青竹绿配象牙', '酒红配暖金', '雾紫配奶咖', '柠檬黄配纯白', '砂粉配灰蓝', '墨绿配浅木', '奶黄配砖红']
const SHOT_WORDS = ['平视中景', '微俯全景', '低角度仰拍', '侧俯三分', '正面近景', '斜四十五度中景', '过肩视角']

/** 造一条与其他条至少三项不同的方案标签 */
function sceneTag(index: number): string {
  return `${SCENE_WORDS[index % SCENE_WORDS.length]}，${PEOPLE_WORDS[index % PEOPLE_WORDS.length]}，${COLOR_WORDS[index % COLOR_WORDS.length]}，${SHOT_WORDS[index % SHOT_WORDS.length]}`
}

/** 从写词请求里取出这一批被分到的方案（sceneBlock 里的编号行） */
function scenesOf(user: string): string[] {
  const block = user.split('【这一批必须按下列画面方案逐条写')[1]
  if (!block) return []
  const body = block.split('\n\n按这份 SOP')[0]
  return body
    .split('\n')
    .map((line) => line.match(/^\d+\.\s*(.+)$/)?.[1]?.trim())
    .filter((item): item is string => Boolean(item))
}

function jsonReply(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/**
 * @param planCount 规划阶段返回多少条方案（默认比要的多 30%，与实现一致）
 * @param onWrite  可选的写词拦截：返回 null 表示用默认回复
 */
function mockTwoPhase(options: {
  planCount: number
  onWrite?: (scenes: string[], callIndex: number) => string | null
}) {
  let writeCalls = 0
  const planCalls: string[] = []
  const writeRequests: Array<{ scenes: string[]; user: string }> = []
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const system = body.messages[0].content as string
    const user = body.messages[1].content as string
    if (system.includes(PLAN_MARKER)) {
      planCalls.push(user)
      return jsonReply(Array.from({ length: options.planCount }, (_, i) => `${i + 1}. ${sceneTag(i)}`).join('\n'))
    }
    const scenes = scenesOf(user)
    writeRequests.push({ scenes, user })
    const custom = options.onWrite?.(scenes, writeCalls)
    writeCalls += 1
    if (custom !== null && custom !== undefined) return jsonReply(custom)
    if (!scenes.length) {
      // 规划失败时的顺序回退路径：按请求里要的条数给回复
      const need = Number(user.match(/写 (\d+) 条提示词/)?.[1] ?? 1)
      return jsonReply(numbered(1, need))
    }
    // 默认：按分到的方案逐条回正文，条数与方案一致
    return jsonReply(scenes.map((scene, i) => `${i + 1}. ${scene}，三栏排版，无按钮。`).join('\n'))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, planCalls, writeRequests }
}

describe('generatePrompts 两阶段并行写', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('先规划一次，再按批并行写；总调用数 = 1 + 批数', async () => {
    const total = 30
    const batches = Math.ceil(total / PROMPTS_PER_BATCH)
    const { fetchMock, planCalls, writeRequests } = mockTwoPhase({ planCount: total + 10 })
    const prompts = await generatePrompts(profile, SOP, total)

    // 规划只跑一次（不随批数增长），这是提速的关键
    expect(planCalls).toHaveLength(1)
    expect(writeRequests).toHaveLength(batches)
    expect(fetchMock).toHaveBeenCalledTimes(1 + batches)
    expect(prompts).toHaveLength(total)
  })

  it('每批只写自己那份方案，不会看到别的批的', async () => {
    const total = PROMPTS_PER_BATCH * 2
    const { writeRequests } = mockTwoPhase({ planCount: total + 6 })
    await generatePrompts(profile, SOP, total)

    expect(writeRequests).toHaveLength(2)
    const [first, second] = writeRequests.map((item) => item.scenes)
    // 每批条数都等于单批上限
    expect(first).toHaveLength(PROMPTS_PER_BATCH)
    expect(second).toHaveLength(PROMPTS_PER_BATCH)
    // 两批的方案集合没有交集 —— 这正是能并行且不撞车的前提
    for (const scene of first) expect(second).not.toContain(scene)
  })

  it('结果顺序按批号还原，不受各批完成先后影响', async () => {
    const total = PROMPTS_PER_BATCH * 2
    // 第 0 批故意慢、第 1 批快：并行下第 1 批会先返回
    const { } = mockTwoPhase({
      planCount: total + 6,
      onWrite: (scenes, callIndex) => {
        if (callIndex === 0) {
          return scenes.map((scene, i) => `${i + 1}. ${scene}，这是第一批，无按钮。`).join('\n')
        }
        return scenes.map((scene, i) => `${i + 1}. ${scene}，这是第二批，无按钮。`).join('\n')
      },
    })
    const prompts = await generatePrompts(profile, SOP, total)

    // 前 PROMPTS_PER_BATCH 条必须来自第一批，不能因为第二批先返回就抢在前面
    expect(prompts.slice(0, PROMPTS_PER_BATCH).every((item) => item.includes('这是第一批'))).toBe(true)
    expect(prompts.slice(PROMPTS_PER_BATCH).every((item) => item.includes('这是第二批'))).toBe(true)
  })

  it('进度按已完成条数累加，最后一条回调等于总数', async () => {
    const total = 30
    const { } = mockTwoPhase({ planCount: total + 10 })
    const progress: Array<[number, number]> = []
    await generatePrompts(profile, SOP, total, true, '', '', false, (written, t) => {
      progress.push([written, t])
    })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]).toEqual([total, total])
    // 累加不应倒退
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0])
    }
  })

  it('规划失败时退回顺序写法，不让整批卡住', async () => {
    // 规划请求返回一段无法解析成编号列表的内容
    let writeCalls = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      const system = body.messages[0].content as string
      if (system.includes(PLAN_MARKER)) return jsonReply('抱歉，我无法完成这个请求。')
      writeCalls += 1
      return jsonReply(numbered(1, PROMPTS_PER_BATCH))
    })
    vi.stubGlobal('fetch', fetchMock)

    const prompts = await generatePrompts(profile, SOP, PROMPTS_PER_BATCH)
    // 退回顺序路径：仍然能写出这批提示词
    expect(prompts).toHaveLength(PROMPTS_PER_BATCH)
    expect(writeCalls).toBeGreaterThanOrEqual(1)
  })

  it('单批写词失败不拖垮整批，其余批照常返回', async () => {
    const total = PROMPTS_PER_BATCH * 2
    const { } = mockTwoPhase({
      planCount: total + 6,
      onWrite: (scenes, callIndex) => {
        if (callIndex === 1) throw new Error('这一批网络断了')
        return null
      },
    })
    const prompts = await generatePrompts(profile, SOP, total)
    // 只剩第一批的条数，但不能抛错
    expect(prompts).toHaveLength(PROMPTS_PER_BATCH)
  })

  it('条数超过上限时按上限算', async () => {
    const { fetchMock } = mockTwoPhase({ planCount: MAX_PROMPTS_PER_RUN + 100 })
    const prompts = await generatePrompts(profile, SOP, MAX_PROMPTS_PER_RUN + 500)
    expect(prompts.length).toBeLessThanOrEqual(MAX_PROMPTS_PER_RUN)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('dedupeScenes 规划去重', () => {
  it('四项里只换色调的方案算重复，会被丢掉', () => {
    const scenes = [
      '公园林荫道，母女二人，薄荷绿配奶白，平视中景',
      // 只有色调不同 —— 画出来还是同一个画面
      '公园林荫道，母女二人，暖橙配深棕，平视中景',
    ]
    const result = dedupeScenes(scenes)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
  })

  it('四项里有三项不同的方案都保留', () => {
    const scenes = [
      '公园林荫道，母女二人，薄荷绿配奶白，平视中景',
      '城市天台花园，独处青年，雾蓝配浅灰，低角度仰拍',
    ]
    const result = dedupeScenes(scenes)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })

  it('完全照抄的方案一定被丢掉', () => {
    const one = '海边栈桥，祖孙三代，蜜桃粉配米白，微俯全景'
    const result = dedupeScenes([one, one, one])
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(2)
  })

  it('相似度是自反的，且完全不同的两条接近 0', () => {
    const a = '公园林荫道，母女二人，薄荷绿配奶白，平视中景'
    const b = '地铁站台，独处老人，酒红配暖金，侧俯三分'
    expect(sceneSimilarity(a, a)).toBe(1)
    expect(sceneSimilarity(a, b)).toBeLessThan(0.45)
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

describe('括号说明不许当重复卖点去掉', () => {
  const COPY = '有无社保均可办理(责任内)\n大病小病均可保障(责任内)'

  it('写提示词时说明括号内文字是原文、不算重复', () => {
    const { system, user } = buildPromptMessages({ sopText: SOP, count: 1, copyText: COPY })
    expect(system).toContain('括号说明不算重复')
    expect(system).toContain('括号里的内容也是文案')
    expect(user).toContain('括号中的说明')
  })

  it('没有卖点时不出现括号规则', () => {
    const { system } = buildPromptMessages({ sopText: SOP, count: 1 })
    expect(system).not.toContain('括号说明不算重复')
    expect(system).not.toContain('括号里的内容也是文案')
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

  /**
   * 按行删会把版式一起删掉；整份 SOP 写成一段时甚至会被删空。
   * 这两种都会让出图看起来「SOP 没生效」，所以锁住「只删命中的那一段」。
   */
  it('只删命中的那一段，不整行删掉版式信息', () => {
    const sop = '底部留白 40px，按钮位置在右下角，整体版式保持居中'
    const cleaned = stripButtonPlaceholders(sop)
    expect(cleaned).toContain('底部留白 40px')
    expect(cleaned).toContain('整体版式保持居中')
    expect(cleaned).not.toContain('按钮位置')
  })

  it('整份 SOP 写成一段时不会被整段删空', () => {
    const sop = '必守：留出按钮位置（但不生成按钮）。标题两行，卖点四条竖排，底色深绿，主体居中偏右。'
    const cleaned = stripButtonPlaceholders(sop)
    expect(cleaned.trim().length).toBeGreaterThan(0)
    expect(cleaned).toContain('标题两行')
    expect(cleaned).toContain('底色深绿')
  })

  it('删得太狠时宁可整份不动（不拿掉一半以上的篇幅）', () => {
    const sop = '留出按钮位置。'
    // 删完几乎不剩东西：退回原文，交给写词阶段的「禁止按钮占位」去约束
    expect(stripButtonPlaceholders(sop)).toBe(sop)
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

describe('排版专项优化只对 deepseek-v4.1 生效', () => {
  it('deepseek-v4.1 命中，gemini-3.8 不命中', () => {
    expect(needsLayoutOptimize('deepseek-v4.1-flash')).toBe(true)
    expect(needsLayoutOptimize('DeepSeek-V4.1-Pro')).toBe(true)
    expect(needsLayoutOptimize('dsv4.1')).toBe(true)
    expect(needsLayoutOptimize('gemini-3.8-flash')).toBe(false)
    expect(needsLayoutOptimize('')).toBe(false)
    expect(needsLayoutOptimize(undefined)).toBe(false)
  })

  it('命中时系统提示词注入禁坐标与排版逐条不同两条规则', () => {
    const on = buildPromptMessages({ sopText: SOP, count: 1, layoutOptimize: true }).system
    expect(on).toContain('不要写坐标数字')
    expect(on).toContain('排版话术必须逐条不同')
    expect(on).toContain('排版只写生图模型能落地的信息')
  })

  it('不命中时三条排版规则都不出现，其余规则不受影响', () => {
    const off = buildPromptMessages({ sopText: SOP, count: 1, layoutOptimize: false }).system
    expect(off).not.toContain('不要写坐标数字')
    expect(off).not.toContain('排版话术必须逐条不同')
    // 原有常识性规则仍在
    expect(off).toContain('叠字')
  })

  it('profile 没填 sopTextModel 时回落到默认模型', () => {
    expect(resolveSopTextModel(profile)).toBe(SOP_TEXT_MODEL)
    expect(resolveSopTextModel({ ...profile, sopTextModel: ' gemini-3.8-flash ' } as ApiProfile)).toBe('gemini-3.8-flash')
  })
})
