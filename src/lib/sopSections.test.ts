import { describe, expect, it } from 'vitest'

import {
  buildSopSystemPrompt,
  buildTextSopSystemPrompt,
  DEFAULT_SOP_SECTIONS,
  sopSectionsFrom,
  sopTitleOf,
} from './sopPipeline'

/** 模拟 buildPromptBundle 合并后的文档 */
const MERGED = [
  '> 优先级：文案 > 系统提示词 > 风格。',
  '',
  '# 文案（最高优先级 · 图上文字的唯一来源）',
  '600 万医疗保障',
  '',
  '---',
  '',
  '# 系统提示词（画面、版式与执行要求）',
  '## 产品与受众',
  '30-55 岁家庭投保决策人',
  '### 细分人群',
  '有房贷的中年人',
  '## 必须做到',
  '一张图只讲一件事',
  '## 绝对不要',
  '不画按钮',
  '',
  '---',
  '',
  '# 风格',
  '## 扁平插画',
  '莫兰迪配色',
].join('\n')

describe('sopSectionsFrom', () => {
  it('系统提示词里没写小节时退回默认结构（含变量池与互斥规则）', () => {
    expect(sopSectionsFrom('一段没有任何标题的说明文字')).toEqual(DEFAULT_SOP_SECTIONS)
    expect(sopSectionsFrom('')).toEqual(DEFAULT_SOP_SECTIONS)
    expect(DEFAULT_SOP_SECTIONS).toContain('变量池')
    expect(DEFAULT_SOP_SECTIONS).toContain('互斥规则')
  })

  it('按系统提示词里的小节决定结构，并自动补上变量池与互斥规则', () => {
    const text = ['## 版式要求', '左图右文', '## 文案规则', '主标题 12 字内', '## 禁忌', '不画按钮'].join('\n')
    expect(sopSectionsFrom(text)).toEqual(['版式要求', '文案规则', '禁忌', '变量池', '互斥规则'])
  })

  it('系统提示词自己已经写了变量池时不再重复追加', () => {
    const text = ['## 版式要求', '左图右文', '## 变量池', '场景：室内', '## 互斥规则', '不重复'].join('\n')
    expect(sopSectionsFrom(text)).toEqual(['版式要求', '变量池', '互斥规则'])
  })

  it('只取最外层标题，不把更深的子项当小节', () => {
    const text = ['## 产品', '### 人群', '### 痛点', '## 版式', '### 分区'].join('\n')
    expect(sopSectionsFrom(text)).toEqual(['产品', '版式', '变量池', '互斥规则'])
  })

  it('合并文档里只认「系统提示词」那一段，文案和风格不算小节', () => {
    expect(sopSectionsFrom(MERGED)).toEqual(['产品与受众', '必须做到', '绝对不要', '变量池', '互斥规则'])
  })
})

describe('输出格式由系统提示词决定', () => {
  it('自定义结构写进反推请求，默认小节不再出现', () => {
    const system = buildSopSystemPrompt(true, false, true, ['版式要求', '文案规则', '禁忌'])
    expect(system).toContain('## 版式要求、## 文案规则、## 禁忌')
    expect(system).toContain('标题文字与顺序都照此执行')
    expect(system).not.toContain('## 适用场景')
  })

  it('无参考图版本同样按外部结构输出', () => {
    const system = buildTextSopSystemPrompt(true, false, true, ['版式要求', '禁忌'])
    expect(system).toContain('## 版式要求、## 禁忌')
    expect(system).not.toContain('## 配色与光线')
  })

  it('不传结构时用默认结构，且包含变量池与互斥规则的写法要求', () => {
    const system = buildSopSystemPrompt(true, false, true)
    for (const name of DEFAULT_SOP_SECTIONS) {
      expect(system).toContain(`## ${name}`)
    }
    expect(system).toContain('每个维度至少 4 个')
    expect(system).toContain('任意两条至少在场景、机位、主体、色调中的两项上不同')
  })
})

describe('sopTitleOf', () => {
  it('优先取「SOP 名称」小节', () => {
    expect(sopTitleOf('## SOP 名称\n百万医疗险 · 月亮\n\n## 版式结构\n左图右文', '方向名')).toBe('百万医疗险 · 月亮')
  })

  it('自定义结构没有这一节时，取第一个小节下的第一行', () => {
    expect(sopTitleOf('## 版式要求\n左图右文，标题居左\n\n## 禁忌\n不画按钮', '方向名')).toBe('左图右文，标题居左')
    // 列表项也能取，去掉前导符号
    expect(sopTitleOf('## 产品与受众\n- 百万医疗险\n\n## 禁忌\n无', '方向名')).toBe('百万医疗险')
  })

  it('完全没有标题时用兜底名', () => {
    expect(sopTitleOf('一段没有小节的文字', '方向名')).toBe('方向名')
  })
})
