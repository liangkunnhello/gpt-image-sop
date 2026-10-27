import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSelectedTextMentionLabel } from './promptImageMentions'

const chat = vi.fn()
vi.mock('./sopPipeline', () => ({ chat: (...args: unknown[]) => chat(...args) }))

const {
  DEFAULT_OPTIMIZE_REQUIREMENT,
  buildOptimizeMessages,
  cleanOptimizedPrompt,
  collectMentions,
  collectPlaceholders,
  missingPlaceholders,
  optimizePrompt,
  restoreMentionMarkers,
} = await import('./promptOptimize')

const profile = { id: 'p1', provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example.com/v1' } as never

describe('优化提示词的提示词构造', () => {
  it('系统提示词里写明只输出正文、保留变量与图片引用', () => {
    const { system } = buildOptimizeMessages('一只猫', '更具体', 0)
    expect(system).toContain('只输出改写后的提示词正文')
    expect(system).toContain('{{变量}}')
    expect(system).toContain('@图1')
  })

  it('用户消息里带原文与优化要求，要求留空时用默认值', () => {
    const withRequirement = buildOptimizeMessages('一只猫', '补上光线', 0)
    expect(withRequirement.user).toContain('一只猫')
    expect(withRequirement.user).toContain('补上光线')

    const blank = buildOptimizeMessages('一只猫', '   ', 0)
    expect(blank.user).toContain(DEFAULT_OPTIMIZE_REQUIREMENT)
  })

  it('有参考图时说明可以看图，但不照抄图上文字', () => {
    const { user } = buildOptimizeMessages('一只猫', '更具体', 2)
    expect(user).toContain('附带的 2 张图')
    expect(user).toContain('不要把图上的文字照抄')
    expect(buildOptimizeMessages('一只猫', '更具体', 0).user).not.toContain('附带的')
  })
})

describe('模型输出清洗', () => {
  it('剥掉代码块、前缀和整段引号', () => {
    expect(cleanOptimizedPrompt('```\n一只猫\n```')).toBe('一只猫')
    expect(cleanOptimizedPrompt('优化后：一只猫')).toBe('一只猫')
    expect(cleanOptimizedPrompt('「一只猫」')).toBe('一只猫')
    expect(cleanOptimizedPrompt('  "一只猫"  ')).toBe('一只猫')
  })

  it('句内引号是提示词的一部分，不能剥', () => {
    expect(cleanOptimizedPrompt('海报上写「限时」两个字')).toBe('海报上写「限时」两个字')
  })
})

describe('变量占位符与图片引用', () => {
  it('收集占位符去重，模型弄丢任何一项都要报出来', () => {
    expect(collectPlaceholders('{{场景}}里放{{主体}}，再来一次{{场景}}')).toEqual(['{{场景}}', '{{主体}}'])
    expect(missingPlaceholders('{{场景}}里放{{主体}}', '{{场景}}里放一只猫')).toEqual(['{{主体}}'])
    expect(missingPlaceholders('{{场景}}', '{{场景}}里放一只猫')).toEqual([])
  })

  it('收集图片引用时跳过已经有标记的，避免重复算', () => {
    // collectMentions 只收「裸的」引用：已带不可见标记的由还原逻辑原样保留，不参与重算
    expect(collectMentions(`${getSelectedTextMentionLabel('@图1')}和@图2`)).toEqual(['@图2'])
    expect(collectMentions(`@第2轮图3 对比 @图1`)).toEqual(['@第2轮图3', '@图1'])
  })

  it('还原不可见标记：裸 @图N 包一层，已包好的不重复包', () => {
    expect(restoreMentionMarkers('参考@图1的排版')).toBe(`参考${getSelectedTextMentionLabel('@图1')}的排版`)

    const wrapped = getSelectedTextMentionLabel('@图2')
    expect(restoreMentionMarkers(`参考${wrapped}的排版`)).toBe(`参考${wrapped}的排版`)
    // 同一段里既有已包装的、又有新出现的，两种都要对
    expect(restoreMentionMarkers(`${wrapped}配@图1`)).toBe(`${wrapped}配${getSelectedTextMentionLabel('@图1')}`)
  })
})

describe('优化提示词调用', () => {
  beforeEach(() => {
    chat.mockReset()
  })

  it('把清洗和引用还原后的正文返回', async () => {
    chat.mockResolvedValue('优化后：只参考@图1的排版，其他按提示词进行')
    const result = await optimizePrompt({ profile, prompt: '参考@图1', requirement: '更具体' })

    expect(result).toBe(`只参考${getSelectedTextMentionLabel('@图1')}的排版，其他按提示词进行`)
    // 系统 + 用户两条消息，纯文本时 user 是字符串
    const messages = chat.mock.calls[0][1] as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('user')
    expect(typeof messages[1].content).toBe('string')
  })

  it('带参考图时按多模态内容发送', async () => {
    chat.mockResolvedValue('一只猫')
    await optimizePrompt({ profile, prompt: '一只猫', requirement: '更具体', imageDataUrls: ['data:image/jpeg;base64,AAA'] })

    const messages = chat.mock.calls[0][1] as Array<{ content: unknown }>
    expect(Array.isArray(messages[1].content)).toBe(true)
    expect(messages[1].content).toEqual([
      { type: 'text', text: expect.stringContaining('一只猫') },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
    ])
  })

  it('模型弄丢变量占位符时报错，不把结果覆盖回输入框', async () => {
    chat.mockResolvedValue('一只猫在{{场景}}里')
    await expect(optimizePrompt({ profile, prompt: '{{场景}}里放{{主体}}', requirement: '更具体' }))
      .rejects.toThrow('{{主体}}')
  })

  it('模型把图片引用整段删掉时报错（位置补不回来）', async () => {
    chat.mockResolvedValue('只参考排版设计，其他按提示词进行')
    await expect(optimizePrompt({ profile, prompt: '参考@图1的排版设计', requirement: '更具体' }))
      .rejects.toThrow('@图1')
  })

  it('引用还在、只是被改写措辞时正常返回', async () => {
    chat.mockResolvedValue('只参考@图1的排版设计与动作内容')
    await expect(optimizePrompt({ profile, prompt: '参考@图1的排版设计和动作内容', requirement: '更具体' }))
      .resolves.toContain('@图1')
  })

  it('模型返回空内容时报错', async () => {
    chat.mockResolvedValue('   ')
    await expect(optimizePrompt({ profile, prompt: '一只猫', requirement: '更具体' })).rejects.toThrow('空内容')
  })
})
