import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentTurnUserMessage,
  formatTurnHistory,
  groupAgentTurns,
  parseAgentTurnResponse,
  loadLastTurnBaseImages,
} from './agentCardPipeline'
import { DEFAULT_PARAMS, type AgentCardTurn, type TaskRecord } from '../types'

vi.mock('./imageCache', () => ({
  // ok- 开头的图还在，其它视为已被清理
  ensureImageCached: vi.fn(async (id: string) => (id.startsWith('ok') ? `data:${id}` : undefined)),
}))

function turn(index: number, patch: Partial<AgentCardTurn> = {}): AgentCardTurn {
  return {
    index,
    userText: `第 ${index} 轮的话`,
    reply: '',
    promptCount: 1,
    baseImageIds: [],
    createdAt: index,
    ...patch,
  }
}

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: Math.random().toString(36).slice(2),
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
    ...patch,
  }
}

describe('parseAgentTurnResponse', () => {
  it('读标准 JSON', () => {
    const result = parseAgentTurnResponse('{"reply":"改大标题","prompts":["a","b"]}', 2)
    expect(result.reply).toBe('改大标题')
    expect(result.prompts).toEqual(['a', 'b'])
  })

  it('包了 ```json 围栏也能读', () => {
    const result = parseAgentTurnResponse('```json\n{"reply":"x","prompts":["p1"]}\n```', 1)
    expect(result.prompts).toEqual(['p1'])
  })

  it('JSON 前后多说了几句也能读', () => {
    const result = parseAgentTurnResponse('好的，这是结果：\n{"reply":"x","prompts":["p1"]}\n希望有帮助', 1)
    expect(result.prompts).toEqual(['p1'])
  })

  it('条数超过要求时截断，不按条数补空', () => {
    const result = parseAgentTurnResponse('{"reply":"","prompts":["a","b","c"]}', 2)
    expect(result.prompts).toEqual(['a', 'b'])
  })

  it('不是 JSON 时把整段当一条提示词（宁可出一条，也不让整轮作废）', () => {
    const result = parseAgentTurnResponse('一张深绿色的锁图标主图', 3)
    expect(result.reply).toBe('')
    expect(result.prompts).toEqual(['一张深绿色的锁图标主图'])
  })

  it('空返回就是空', () => {
    expect(parseAgentTurnResponse('   ', 2)).toEqual({ reply: '', prompts: [] })
  })

  it('prompts 里的空串会被剔掉', () => {
    const result = parseAgentTurnResponse('{"reply":"","prompts":["a","  ","b"]}', 3)
    expect(result.prompts).toEqual(['a', 'b'])
  })
})

describe('groupAgentTurns', () => {
  it('同一轮的多条任务并成一轮，图按任务顺序拼起来', () => {
    const tasks = [
      task({ agentTurn: turn(1), sopPromptIndex: 2, outputImages: ['i3'] }),
      task({ agentTurn: turn(1), sopPromptIndex: 1, outputImages: ['i1', 'i2'] }),
    ]
    const groups = groupAgentTurns(tasks)
    expect(groups).toHaveLength(1)
    expect(groups[0].turn.index).toBe(1)
    // 按 sopPromptIndex 排：第 1 条的两张在前
    expect(groups[0].outputImages).toEqual(['i1', 'i2', 'i3'])
  })

  it('按轮次升序返回', () => {
    const groups = groupAgentTurns([
      task({ agentTurn: turn(3) }),
      task({ agentTurn: turn(1) }),
      task({ agentTurn: turn(2) }),
    ])
    expect(groups.map((group) => group.turn.index)).toEqual([1, 2, 3])
  })

  it('没有轮次信息的任务不参与（避免把别的东西算成一轮）', () => {
    expect(groupAgentTurns([task()])).toEqual([])
  })
})

describe('对话历史的组织', () => {
  it('只带最近几轮，越早的越先被丢掉', () => {
    const groups = groupAgentTurns([
      task({ agentTurn: turn(1) }),
      task({ agentTurn: turn(2) }),
      task({ agentTurn: turn(3) }),
    ])
    const text = formatTurnHistory(groups, 2)
    expect(text).not.toContain('第 1 轮')
    expect(text).toContain('第 2 轮')
    expect(text).toContain('第 3 轮')
  })

  it('有底图时说清是第几轮的产出', () => {
    const message = buildAgentTurnUserMessage({
      turns: groupAgentTurns([task({ agentTurn: turn(2) })]),
      text: '标题再大点',
      count: 4,
      baseCount: 2,
      baseTurnIndex: 2,
    })
    expect(message).toContain('会带 2 张图')
    expect(message).toContain('第 2 轮')
    expect(message).toContain('本轮要写 4 条提示词')
  })

  it('没底图时明确说从零开始画', () => {
    const message = buildAgentTurnUserMessage({ turns: [], text: '画一张主图', count: 1, baseCount: 0 })
    expect(message).toContain('这次没有底图')
    expect(message).not.toContain('已经聊过的轮次')
  })
})

describe('上一版的图', () => {
  const group = (index: number, images: string[]) => ({
    turn: turn(index),
    tasks: [task({ agentTurn: turn(index), outputImages: images })],
    outputImages: images,
  })

  it('取最后一轮的图', async () => {
    const images = await loadLastTurnBaseImages([group(1, ['ok-1']), group(2, ['ok-2', 'ok-3'])])
    expect(images.map((item) => item.id)).toEqual(['ok-2', 'ok-3'])
  })

  it('最后一轮一张都没出时继续往前找', async () => {
    const images = await loadLastTurnBaseImages([group(1, ['ok-1']), group(2, [])])
    expect(images.map((item) => item.id)).toEqual(['ok-1'])
  })

  it('图已被清理时继续往前找，而不是当这轮没有底图', async () => {
    const images = await loadLastTurnBaseImages([group(1, ['ok-1']), group(2, ['gone-1'])])
    expect(images.map((item) => item.id)).toEqual(['ok-1'])
  })

  it('一张都取不到就是纯文生图', async () => {
    expect(await loadLastTurnBaseImages([group(1, [])])).toEqual([])
  })
})
