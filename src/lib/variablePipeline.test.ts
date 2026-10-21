import { describe, expect, it } from 'vitest'

import {
  BUILTIN_VARIABLE_PROMPT,
  buildVariableExtractMessages,
  parseStrategies,
  strategiesToText,
} from './variablePipeline'

const json = (value: unknown) => JSON.stringify(value)

describe('buildVariableExtractMessages', () => {
  it('没给变量提示词时用内置策略', () => {
    const { system } = buildVariableExtractMessages({ variablePromptText: '' })
    expect(system).toContain('从参考图片中提炼可迁移的视觉生成方法')
    expect(system).toContain('{{变量名}}')
  })

  it('给了变量提示词时以它为准，内置策略不再出现', () => {
    const { system } = buildVariableExtractMessages({ variablePromptText: '只提取几何结构' })
    expect(system).toContain('只提取几何结构')
    expect(system).not.toContain('从参考图片中提炼可迁移的视觉生成方法')
  })

  it('输出格式约定始终附在最后', () => {
    const { system } = buildVariableExtractMessages({ variablePromptText: '策略' })
    expect(system).toContain('只输出一个 JSON 数组')
    expect(system).toContain('"dimensions"')
  })

  it('开启合规忽略时不提取 logo 与免责声明', () => {
    expect(buildVariableExtractMessages({ variablePromptText: '策略', ignoreCompliance: true }).system).toContain('免责声明')
    expect(buildVariableExtractMessages({ variablePromptText: '策略', ignoreCompliance: false }).system).not.toContain('一律不要提取')
  })

  it('卖点单独给一块，并说明不要当成视觉策略', () => {
    const { user } = buildVariableExtractMessages({ variablePromptText: '策略', copyText: '600 万保障' })
    expect(user).toContain('【卖点文案（图上文字必须逐字照抄，不得改写）】')
    expect(user).toContain('不要把卖点当成视觉策略')
  })

  it('没有卖点时不出卖点块', () => {
    const { user } = buildVariableExtractMessages({ variablePromptText: '策略' })
    expect(user).not.toContain('卖点文案')
  })

  it('多张参考图时说明张数', () => {
    expect(buildVariableExtractMessages({ variablePromptText: '策略', imageCount: 3 }).user).toContain('3 张参考图')
  })
})

describe('parseStrategies', () => {
  const dims = [
    { name: '承载结构', options: ['圆盘', '方框', '环'] },
    { name: '外围元素', options: ['羽翼', '叶片'] },
  ]

  it('解析裸 JSON 数组', () => {
    const raw = json([{ name: '中心阵列', evidence: '图1', skeleton: '{{承载结构}}托住主体，{{外围元素}}展开', dimensions: dims, value: '可批量' }])
    const [first] = parseStrategies(raw)
    expect(first.name).toBe('中心阵列')
    expect(first.dimensions).toHaveLength(2)
    expect(first.dimensions[0].options).toEqual(['圆盘', '方框', '环'])
  })

  it('剥掉 ```json 包裹也能解析', () => {
    const raw = '```json\n' + json([{ name: 'A', skeleton: '{{X}}', dimensions: [{ name: 'X', options: ['1', '2'] }] }]) + '\n```'
    expect(parseStrategies(raw)).toHaveLength(1)
  })

  it('前后有废话时截取数组', () => {
    const raw = '好的，结果如下：\n' + json([{ name: 'A', skeleton: '{{X}}', dimensions: [{ name: 'X', options: ['1', '2'] }] }]) + '\n以上。'
    expect(parseStrategies(raw)).toHaveLength(1)
  })

  it('骨架里没出现的变量被丢掉', () => {
    const raw = json([{
      name: 'A',
      skeleton: '{{实际用到}}',
      dimensions: [
        { name: '实际用到', options: ['x', 'y'] },
        { name: '多余变量', options: ['m', 'n'] },
      ],
    }])
    const [first] = parseStrategies(raw)
    expect(first.dimensions.map((d) => d.name)).toEqual(['实际用到'])
  })

  it('选项去重并去掉空值', () => {
    const raw = json([{ name: 'A', skeleton: '{{X}}', dimensions: [{ name: 'X', options: ['a', 'a', '', ' b ', 'b'] }] }])
    expect(parseStrategies(raw)[0].dimensions[0].options).toEqual(['a', 'b'])
  })

  it('没有骨架的策略丢弃', () => {
    expect(parseStrategies(json([{ name: 'A', dimensions: dims }]))).toEqual([])
  })

  it('名称缺失时补默认名', () => {
    const raw = json([{ skeleton: '{{X}}', dimensions: [{ name: 'X', options: ['1', '2'] }] }])
    expect(parseStrategies(raw)[0].name).toBe('策略 1')
  })

  it('不是数组或不是 JSON 时返回空', () => {
    expect(parseStrategies('完全不是 JSON')).toEqual([])
    expect(parseStrategies('{"a":1}')).toEqual([])
  })
})

describe('strategiesToText', () => {
  it('把策略回写成 Markdown，含编号与可变项', () => {
    const text = strategiesToText([{
      name: '负形融合',
      evidence: '图1、图3',
      skeleton: '图片以{{轮廓}}剪出{{主体}}',
      dimensions: [{ name: '轮廓', options: ['羽翼', '齿'] }],
      value: '适合批量换轮廓',
    }])
    expect(text).toContain('## 1. 负形融合')
    expect(text).toContain('对应图1、图3')
    expect(text).toContain('- {{轮廓}}：羽翼 / 齿')
    expect(text).toContain('图片以{{轮廓}}剪出{{主体}}')
    expect(text).toContain('适合批量换轮廓')
  })

  it('空列表返回空串', () => {
    expect(strategiesToText([])).toBe('')
  })
})

describe('BUILTIN_VARIABLE_PROMPT', () => {
  it('覆盖用户给定的关键约束', () => {
    const content = BUILTIN_VARIABLE_PROMPT.content
    expect(content).toContain('只复述画面内容')
    expect(content).toContain('{{变量名}}')
    expect(content).toContain('不得写成“核心圆盘”')
    expect(content).toContain('不预设参考图之外的固定颜色')
    expect(content).toContain('完整闭合、连续可见')
    expect(content).toContain('不把广告文案、免责声明或投保条件当成视觉策略')
  })
})
