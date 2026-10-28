import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { groupSopTasks, mergePromptText, resolveCardInputText } from './sopGroup'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    prompt: 'p',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('卡片聚合', () => {
  it('同卡的图回收标记按整组合并，兄弟任务里的图也能从展示里排掉', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, outputImages: ['img-a'], createdAt: 3 })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, outputImages: ['img-b'], trashedOutputImages: ['img-b'], createdAt: 2 })
    const [card] = groupSopTasks([a, b])
    expect(card.outputImages).toEqual(['img-a', 'img-b'])
    expect(card.trashedOutputImages).toEqual(['img-b'])
  })

  it('人工改判同样按整组合并', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, outputImages: ['img-a'], createdAt: 3 })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, outputImages: ['img-b'], qcVerdicts: { 'img-b': 'fail' }, createdAt: 2 })
    const [card] = groupSopTasks([a, b])
    expect(card.qcVerdicts).toEqual({ 'img-b': 'fail' })
  })

  it('没有回收图时不带这个字段，保持老数据形状', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, outputImages: ['img-a'] })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, outputImages: ['img-b'] })
    const [card] = groupSopTasks([a, b])
    expect(card.trashedOutputImages).toBeUndefined()
    expect(card.qcVerdicts).toBeUndefined()
  })
})

describe('卡片的「输入内容」', () => {
  it('普通模式批量：显示各条提示词，不是「批量 · N 张图」这种概况', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, prompt: '第一条提示词', outputImages: ['img-a'] })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, prompt: '第二条提示词', outputImages: ['img-b'] })
    const [card] = groupSopTasks([a, b])
    expect(card.prompt).toBe('第一条提示词\n\n第二条提示词')
    expect(card.prompt).not.toContain('张图')
  })

  it('SOP 卡同样显示真实提示词（SOP 正文另有展示）', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, prompt: '提示词一', sopText: 'SOP 正文', outputImages: ['img-a'] })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, prompt: '提示词二', sopText: 'SOP 正文', outputImages: ['img-b'] })
    const [card] = groupSopTasks([a, b])
    expect(card.prompt).toBe('提示词一\n\n提示词二')
  })

  it('都没提示词时退回代表任务的那条，不会拼成空串', () => {
    const a = task({ id: 'a', sopJobId: 'job', sopPromptIndex: 1, prompt: '', outputImages: ['img-a'] })
    const b = task({ id: 'b', sopJobId: 'job', sopPromptIndex: 2, prompt: '  ', outputImages: ['img-b'] })
    const [card] = groupSopTasks([a, b])
    expect(card.prompt).toBe('')
  })
})

describe('mergePromptText 同一条提示词不重复', () => {
  it('同一条提示词跑 N 张，只显示一份', () => {
    const merged = mergePromptText(['一只猫在雨里', '一只猫在雨里', '一只猫在雨里'])
    expect(merged.text).toBe('一只猫在雨里')
    expect(merged.count).toBe(1)
  })

  it('内容不同的才按空行分段，保持先出现的顺序', () => {
    const merged = mergePromptText(['第二条', '第一条', '第二条', '  第三条  '])
    expect(merged.text).toBe('第二条\n\n第一条\n\n第三条')
    expect(merged.count).toBe(3)
  })

  it('首尾空格不同但内容一样，算同一条', () => {
    expect(mergePromptText(['  一只猫 ', '一只猫']).count).toBe(1)
  })

  it('空值与 undefined 跳过，不占段', () => {
    const merged = mergePromptText(['', '  ', undefined, null, '正文'])
    expect(merged.text).toBe('正文')
    expect(merged.count).toBe(1)
  })

  it('整卡聚合用的是去重后的结果', () => {
    const same = '同一段提示词'
    const tasks = Array.from({ length: 8 }, (_, i) => task({
      id: `t${i}`,
      sopJobId: 'job',
      sopPromptIndex: i + 1,
      prompt: same,
      outputImages: [`img-${i}`],
    }))
    const [card] = groupSopTasks(tasks)
    expect(card.prompt).toBe(same)
    // 8 张图仍在，只有提示词去重
    expect(card.outputImages).toHaveLength(8)
  })
})

describe('resolveCardInputText「输入内容」显示什么', () => {
  it('普通模式：用快照里的输入框原文，不是拼了卖点/风格的那条', () => {
    const t = task({
      id: 'a',
      prompt: '卖点：600万\n用户写的原文',
      inputSnapshot: { mode: 'plain', prompt: '用户写的原文' },
    })
    expect(resolveCardInputText([t])).toEqual({ text: '用户写的原文', fromInputBox: true })
  })

  it('SOP / 变量模式：快照里没有原文就给空，不拿生成的几十条提示词顶替', () => {
    const group = [
      task({ id: 'a', sopPromptIndex: 1, prompt: '模型写的第一条（几千字）', sopText: '## SOP', inputSnapshot: { mode: 'sop' } }),
      task({ id: 'b', sopPromptIndex: 2, prompt: '模型写的第二条（几千字）', sopText: '## SOP', inputSnapshot: { mode: 'sop' } }),
    ]
    expect(resolveCardInputText(group)).toEqual({ text: '', fromInputBox: true })
  })

  it('SOP / 变量模式：当时输入框写了补充要求就还原它', () => {
    const t = task({
      id: 'a',
      prompt: '模型生成的提示词',
      sopText: '## SOP',
      inputSnapshot: { mode: 'sop', prompt: '  别出现正面人脸  ' },
    })
    expect(resolveCardInputText([t])).toEqual({ text: '别出现正面人脸', fromInputBox: true })
  })

  it('老任务没有快照：SOP 卡给空，普通卡退回提示词拼接（去重）', () => {
    expect(resolveCardInputText([
      task({ id: 'a', prompt: '生成的提示词', sopText: '## SOP' }),
    ])).toEqual({ text: '', fromInputBox: true })

    expect(resolveCardInputText([
      task({ id: 'a', prompt: '一只猫' }),
      task({ id: 'b', prompt: '一只猫' }),
      task({ id: 'c', prompt: '一只狗' }),
    ])).toEqual({ text: '一只猫\n\n一只狗', fromInputBox: false })
  })

  it('变量的老任务同样给空', () => {
    expect(resolveCardInputText([
      task({ id: 'a', prompt: '填词结果', variableMode: true }),
    ])).toEqual({ text: '', fromInputBox: true })
  })
})
