import { beforeEach, describe, expect, it, vi } from 'vitest'

const chat = vi.fn()
vi.mock('./sopPipeline', () => ({ chat: (...args: unknown[]) => chat(...args) }))

const {
  checkPromptRules,
  describeBlocks,
  findBannedWords,
  keepIndexes,
  parseComplianceReply,
  proofreadPrompts,
} = await import('./promptProofread')

const profile = { id: 'p1', provider: 'openai', apiKey: 'k', baseUrl: 'https://api.example.com/v1' } as never
/** 模型判定为全部合规 */
const CLEAN_REPLY = '[]'

describe('违禁词规则', () => {
  it('命中绝对化用语、医疗承诺和引流词', () => {
    expect(findBannedWords('画面文字写「行业第一」')).toEqual([{ label: '绝对化用语', word: '行业第一' }])
    expect(findBannedWords('写上「保证赔付」')).toEqual([{ label: '医疗功效承诺', word: '保证赔付' }])
    expect(findBannedWords('角落放一个二维码')).toEqual([{ label: '引流 / 诱导点击', word: '二维码' }])
  })

  it('「不要画二维码」这类禁忌说明不算违规', () => {
    expect(findBannedWords('不要画二维码，也不加微信号')).toEqual([])
    expect(findBannedWords('避免出现「立即领取」这类文案')).toEqual([])
  })

  it('单字「第一」不当绝对化用语误伤', () => {
    expect(findBannedWords('第一张图画主体')).toEqual([])
  })

  it('同一个词只报一次', () => {
    expect(findBannedWords('二维码 二维码')).toHaveLength(1)
  })
})

describe('规则层校对', () => {
  const copy = '住院医疗费用报销\n不限社保范围'

  it('卖点逐字一致时没有问题', () => {
    expect(checkPromptRules('画面写「住院医疗费用报销」和「不限社保范围」', copy)).toEqual([])
  })

  it('漏了一条卖点会报出来', () => {
    const reasons = checkPromptRules('画面写「住院医疗费用报销」', copy)
    expect(reasons.some((item) => item.includes('缺卖点') && item.includes('不限社保范围'))).toBe(true)
  })

  it('自己加了卖点以外的文案算改写', () => {
    const reasons = checkPromptRules('画面写「住院医疗费用报销」「不限社保范围」「限时福利」', copy)
    expect(reasons.some((item) => item.includes('文案被改写') && item.includes('限时福利'))).toBe(true)
  })

  it('有卖点却一个「」文案都没有：直接判成没有画面文案', () => {
    const reasons = checkPromptRules('一对夫妻站在阳台上看城市天际线', copy)
    expect(reasons.some((item) => item.includes('没有任何画面文案'))).toBe(true)
    // 同时还会报两条「缺卖点」，都算出来便于用户判断
    expect(reasons.filter((item) => item.includes('缺卖点'))).toHaveLength(2)
  })

  it('没有卖点时不做文案比对，只查违规词', () => {
    expect(checkPromptRules('一对夫妻站在阳台上', '')).toEqual([])
    expect(checkPromptRules('画面写「全网最低」', '')).toEqual(['含绝对化用语「全网最低」'])
  })
})

describe('模型结论解析', () => {
  it('解析 JSON 数组，序号转成 0 基', () => {
    expect(parseComplianceReply('[{"index":2,"reason":"疑似色情"}]', 3)).toEqual([{ index: 1, reason: '疑似色情' }])
  })

  it('容忍代码块包裹', () => {
    expect(parseComplianceReply('```json\n[{"index":1,"reason":"x"}]\n```', 2)).toEqual([{ index: 0, reason: 'x' }])
  })

  it('序号越界或原因缺失的条目丢掉 / 兜底', () => {
    expect(parseComplianceReply('[{"index":9,"reason":"x"}]', 2)).toEqual([])
    expect(parseComplianceReply('[{"index":0,"reason":"x"}]', 2)).toEqual([])
    expect(parseComplianceReply('[{"index":1}]', 2)).toEqual([{ index: 0, reason: '模型判定为违规' }])
  })

  it('不是 JSON 就返回 null，交给上层当作「校对没跑成功」', () => {
    expect(parseComplianceReply('看起来没问题', 2)).toBeNull()
    expect(parseComplianceReply('', 2)).toBeNull()
    expect(parseComplianceReply('{"index":1}', 2)).toBeNull()
  })
})

describe('proofreadPrompts', () => {
  beforeEach(() => {
    chat.mockReset()
  })

  it('全部合规时不拦任何一条', async () => {
    chat.mockResolvedValue(CLEAN_REPLY)
    const result = await proofreadPrompts({ profile, prompts: ['一条正常提示词', '另一条'], copyText: '' })
    expect(result.blocks).toEqual([])
    expect(result.notes).toEqual([])
  })

  it('模型判违规的条目被拦下，理由写进 blocks', async () => {
    chat.mockResolvedValue('[{"index":2,"reason":"疑似政治敏感"}]')
    const result = await proofreadPrompts({ profile, prompts: ['正常', '一条有问题'], copyText: '' })
    expect(result.blocks).toEqual([{ index: 1, reasons: ['疑似违规：疑似政治敏感'] }])
  })

  it('规则命中与模型命中会合并在同一条上', async () => {
    chat.mockResolvedValue('[{"index":1,"reason":"疑似医疗夸大"}]')
    const result = await proofreadPrompts({ profile, prompts: ['画面写「保证赔付」'], copyText: '' })
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].reasons).toEqual(['含医疗功效承诺「保证赔付」', '疑似违规：疑似医疗夸大'])
  })

  it('模型调用失败不拦人，只留一条说明', async () => {
    chat.mockRejectedValue(new Error('timeout'))
    const result = await proofreadPrompts({ profile, prompts: ['一条正常提示词'], copyText: '' })
    expect(result.blocks).toEqual([])
    expect(result.notes[0]).toContain('合规检查没跑成功')
  })

  it('模型回复看不懂同样不拦人', async () => {
    chat.mockResolvedValue('我觉得还行')
    const result = await proofreadPrompts({ profile, prompts: ['一条正常提示词'], copyText: '' })
    expect(result.blocks).toEqual([])
    expect(result.notes[0]).toContain('没看懂')
  })

  it('关掉校对时不查也不调模型', async () => {
    const result = await proofreadPrompts({ profile, prompts: ['画面写「保证赔付」'], copyText: '', enabled: false })
    expect(result.blocks).toEqual([])
    expect(chat).not.toHaveBeenCalled()
  })

  it('按 index 摘出还能发的条目，并行数组用同一份下标', () => {
    const blocks = [{ index: 1, reasons: ['x'] }]
    expect(keepIndexes(3, blocks)).toEqual([0, 2])
    const prompts = ['a', 'b', 'c']
    expect(keepIndexes(3, blocks).map((index) => prompts[index])).toEqual(['a', 'c'])
    expect(keepIndexes(3, [])).toEqual([0, 1, 2])
  })

  it('拦截说明最多列三条，其余只报数量', () => {
    const blocks = [
      { index: 0, reasons: ['缺卖点「A」'] },
      { index: 1, reasons: ['含绝对化用语「最佳」'] },
      { index: 2, reasons: ['没有任何画面文案'] },
      { index: 3, reasons: ['疑似违规：x'] },
    ]
    const text = describeBlocks(blocks)
    expect(text).toContain('第 1 条')
    expect(text).toContain('第 3 条')
    expect(text).not.toContain('第 4 条')
    expect(text).toContain('另有 1 条')
  })
})
