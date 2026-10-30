import { describe, expect, it } from 'vitest'

import { buildPromptBundle } from './promptBundle'
import { buildPromptMessages, buildSopSystemPrompt } from './sopPipeline'

describe('buildPromptBundle', () => {
  it('把三份合成一份，卖点排在最前并写明优先级', () => {
    const bundle = buildPromptBundle({
      systemPrompt: '# 版式\n左图右文，标题居左。',
      point: '600 万医疗保障\n住院 0 免赔',
      style: '扁平插画，莫兰迪配色',
    })
    const { merged, copyText } = bundle
    expect(copyText).toBe('600 万医疗保障\n住院 0 免赔')
    expect(merged.indexOf('# 文案（最高优先级')).toBeLessThan(merged.indexOf('# 系统提示词'))
    expect(merged.indexOf('# 系统提示词')).toBeLessThan(merged.indexOf('# 风格'))
    expect(merged).toContain('逐字来自「文案」')
    expect(merged).toContain('600 万医疗保障')
    expect(merged).toContain('左图右文')
    expect(merged).toContain('扁平插画')
  })

  it('没有卖点时不写优先级，只合并其余两段', () => {
    const bundle = buildPromptBundle({ systemPrompt: '只要画面，不要文字', style: '三宫格' })
    expect(bundle.copyText).toBe('')
    expect(bundle.merged).not.toContain('最高优先级')
    expect(bundle.merged).toContain('只要画面')
    expect(bundle.merged).toContain('三宫格')
  })

  it('全空时返回空串', () => {
    expect(buildPromptBundle({}).merged).toBe('')
    expect(buildPromptBundle({ systemPrompt: '  ', point: '\n' }).merged).toBe('')
  })

  it('只有卖点时也能单独成文', () => {
    const bundle = buildPromptBundle({ point: '首月 1 元' })
    expect(bundle.merged).toContain('文案（最高优先级')
    expect(bundle.merged).toContain('首月 1 元')
  })
})

describe('buildPromptMessages', () => {
  const base = { sopText: '## 版式\n左图右文', count: 3 }

  it('有卖点时，system 与 user 都要强调逐字照抄', () => {
    const { system, user } = buildPromptMessages({ ...base, copyText: '600 万医疗保障' })
    expect(system).toContain('文案唯一来源')
    expect(system).toContain('不得改写')
    expect(user).toContain('【卖点文案（图上文字必须逐字照抄，不得改写）】')
    expect(user).toContain('600 万医疗保障')
  })

  it('卖点在每张图里用全，且各图保持一致', () => {
    const { system, user } = buildPromptMessages({ ...base, copyText: 'A\nB\nC' })
    // 不再按张分配，卖点整段给到每一条提示词
    expect(user).not.toContain('卖点分配')
    expect(user).toContain('各张图的卖点完全一致')
    expect(system).toContain('卖点在各图之间保持一致')
    expect(system).toContain('文字内容逐张一致')
  })

  it('同一张图内不许重复同一句卖点', () => {
    const { system, user } = buildPromptMessages({ ...base, copyText: 'A\nB\nC' })
    expect(system).toContain('同一张图里不许重复卖点')
    expect(system).toContain('不能拿同一句卖点去填满版面')
    expect(user).toContain('同一张图里，一份卖点从头到尾只用一遍')
    expect(user).toContain('不许换个说法或拆成两行重写')
    expect(system).toContain('文字位')
  })

  it('SOP 阶段要求文字槽位数跟着卖点条数走', () => {
    expect(buildSopSystemPrompt(true, false, true)).toContain('按卖点条数定义槽位')
    expect(buildSopSystemPrompt(true, false, true)).toContain('不能靠重复同一句卖点把版面填满')
  })

  it('没有卖点时退回原来的规则，不出现卖点段', () => {
    const { system, user } = buildPromptMessages({ ...base, ignoreCompliance: true })
    expect(system).not.toContain('文案唯一来源')
    expect(system).toContain('不要写品牌 logo')
    expect(user).not.toContain('卖点文案')
  })

  it('预留区说明仍然拼在最后', () => {
    const { system, user } = buildPromptMessages({
      ...base,
      copyText: '首月 1 元',
      avoidHint: '【画面预留区】左上角留白',
    })
    expect(system).toContain('画面预留区')
    expect(user.trimEnd().endsWith('左上角留白')).toBe(true)
  })

  it('发散交给 SOP：要求按变量池与互斥规则执行，不再由代码逐条分配', () => {
    const { system, user } = buildPromptMessages({
      ...base,
      copyText: '首月 1 元',
      avoidHint: '【画面预留区】左上角留白',
    })
    expect(system).toContain('「变量池」和「互斥规则」')
    expect(user).toContain('严格遵守其中的「变量池」与「互斥规则」')
    // 差异由 SOP 决定，请求里不该再出现第几条用哪组
    expect(user).not.toContain('第 1 条：场景＝')
    // 预留给后处理的说明仍然固定在最末
    expect(user.trimEnd().endsWith('左上角留白')).toBe(true)
  })
})

describe('按钮 / 引导点击开关', () => {
  it('开启时 SOP 与提示词两轮都禁止按钮类设计', () => {
    const sopSystem = buildSopSystemPrompt(true, false, true)
    expect(sopSystem).toContain('按钮')
    expect(sopSystem).toContain('禁忌')

    const promptSystem = buildPromptMessages({ sopText: 'SOP', count: 2, avoidCta: true }).system
    expect(promptSystem).toContain('仿系统界面')
    expect(promptSystem).toContain('立即领取')
  })

  it('关闭时不出现相关限制，保留参考图原有按钮', () => {
    expect(buildSopSystemPrompt(true, false, false)).not.toContain('仿系统界面')
    expect(buildPromptMessages({ sopText: 'SOP', count: 2, avoidCta: false }).system).not.toContain('立即领取')
  })
})

describe('额外要求并进提示词', () => {
  it('排在文案之后、系统提示词之前，编号成条', () => {
    const { merged } = buildPromptBundle({
      systemPrompt: '画面要求',
      point: '赔付总限额600万',
      extras: ['不画按钮', '避开左上角'],
    })
    const copyAt = merged.indexOf('# 文案')
    const extraAt = merged.indexOf('# 额外要求')
    const systemAt = merged.indexOf('# 系统提示词')
    expect(copyAt).toBeGreaterThanOrEqual(0)
    expect(extraAt).toBeGreaterThan(copyAt)
    expect(systemAt).toBeGreaterThan(extraAt)
    expect(merged).toContain('1. 不画按钮')
    expect(merged).toContain('2. 避开左上角')
  })

  it('没有额外要求时不产生这一节', () => {
    const { merged } = buildPromptBundle({ systemPrompt: '画面要求' })
    expect(merged).not.toContain('# 额外要求')
  })

  it('空白条目被丢掉，不会出现「1. 」这种空行', () => {
    const { merged } = buildPromptBundle({ extras: ['  ', '', '真要求'] })
    expect(merged).toContain('1. 真要求')
    expect(merged).not.toContain('2.')
  })

  it('只有额外要求时也能拼出一份（不依赖系统提示词/卖点）', () => {
    const { merged } = buildPromptBundle({ extras: ['不画按钮'] })
    expect(merged).toContain('# 额外要求')
    expect(merged).toContain('不画按钮')
  })
})
/**
 * 输入框原文必须进生成链路。
 *
 * SOP / 变量模式下输入框不直接成为提示词（由模型按 SOP 写），
 * 所以以前在这里写的字完全没作用 —— 用户写了「把固定图完整植入图片」，
 * 出来的图里一点体现都没有。
 */
describe('输入框原文（本次要求）', () => {
  it('并进合成结果，排在系统提示词之后', () => {
    const { merged } = buildPromptBundle({
      inputPrompt: '把固定图完整植入图片',
      systemPrompt: '画面要求',
    })
    const systemAt = merged.indexOf('# 系统提示词')
    const inputAt = merged.indexOf('本次要求')
    expect(inputAt).toBeGreaterThan(systemAt)
    expect(merged).toContain('把固定图完整植入图片')
  })

  it('标明优先级高于系统提示词，避免与通用要求冲突时被盖掉', () => {
    const { merged } = buildPromptBundle({ inputPrompt: '只保留产品主体' })
    expect(merged).toContain('优先级高于系统提示词')
    expect(merged).toContain('只保留产品主体')
  })

  it('留空时不产生空小节', () => {
    const { merged } = buildPromptBundle({ inputPrompt: '   ', systemPrompt: '画面要求' })
    expect(merged).not.toContain('本次要求')
  })

  it('同时返回原文，供写提示词阶段再喂一次', () => {
    expect(buildPromptBundle({ inputPrompt: ' 带底图出  ' }).inputPrompt).toBe('带底图出')
  })
})

/**
 * 写提示词阶段的第二次投喂：模型按 SOP 写二十条时，
 * 很容易把「这次要怎么做」当背景信息忽略，所以要单独成块放在末尾。
 */
describe('本次要求在写词消息里的位置', () => {
  it('单独成块，并强调与 SOP 冲突时以它为准', () => {
    const { user, system } = buildPromptMessages({
      sopText: '## SOP',
      count: 2,
      userRequirement: '把固定图完整植入图片',
    })
    expect(user).toContain('【本次要求（用户输入框里写的，优先级最高）】')
    expect(user).toContain('把固定图完整植入图片')
    expect(user).toContain('与 SOP 冲突时以它为准')
    expect(system).toContain('【本次要求必须落到每一条】')
  })

  it('没写时不出现这一段', () => {
    const { user, system } = buildPromptMessages({ sopText: '## SOP', count: 2 })
    expect(user).not.toContain('本次要求')
    expect(system).not.toContain('本次要求必须落到每一条')
  })
})
