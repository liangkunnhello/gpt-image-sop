import { describe, expect, it } from 'vitest'

import type { SopDirectionNode, TaskRecord } from '../types'
import { resolveDeliveryDir, hasOwnDeliveryDir } from './deliveryDir'
import { deliverableOutputImages, cardFolderName, tasksOfCard, deliverImageFileName, joinDeliveryPath, resolveCardDeliveryLocation } from './deliver'

const DIRECTIONS: SopDirectionNode[] = [
  { id: 'cat-1', parentId: null, name: '保险', kind: 'category' },
  { id: 'prod-1', parentId: 'cat-1', name: '百万医疗险', kind: 'product' },
  { id: 'dir-1', parentId: 'prod-1', name: '月亮', kind: 'direction' },
  { id: 'dir-2', parentId: 'prod-1', name: '图标', kind: 'direction' },
]

function makeTask(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    prompt: '提示词',
    params: { size: '1024x1024' } as TaskRecord['params'],
    inputImageIds: [],
    outputImages: ['img-1', 'img-2'],
    status: 'done',
    error: null,
    createdAt: new Date('2026-10-23T00:00:00+08:00').getTime(),
    finishedAt: null,
    elapsed: null,
    sopName: '月亮图',
    ...patch,
  } as TaskRecord
}

describe('交付地址的三级继承', () => {
  it('自己配了就用自己这条', () => {
    const resolved = resolveDeliveryDir({ 'dir-1': 'D:/dir', 'prod-1': 'D:/prod' }, DIRECTIONS, 'dir-1')
    expect(resolved).toEqual({ ownerId: 'dir-1', path: 'D:/dir' })
  })

  it('自己没配就向上复用产品', () => {
    const resolved = resolveDeliveryDir({ 'prod-1': 'D:/prod' }, DIRECTIONS, 'dir-1')
    expect(resolved).toEqual({ ownerId: 'prod-1', path: 'D:/prod' })
  })

  it('产品也没配就继续向上复用业务线', () => {
    const resolved = resolveDeliveryDir({ 'cat-1': 'D:/cat' }, DIRECTIONS, 'dir-1')
    expect(resolved).toEqual({ ownerId: 'cat-1', path: 'D:/cat' })
  })

  it('三级都没配返回 null，交给调用方回退默认保存地址', () => {
    expect(resolveDeliveryDir({}, DIRECTIONS, 'dir-1')).toBeNull()
    expect(resolveDeliveryDir({ 'prod-1': 'D:/prod' }, DIRECTIONS, undefined)).toBeNull()
    expect(resolveDeliveryDir({ 'prod-1': 'D:/prod' }, DIRECTIONS, 'gone-node')).toBeNull()
  })

  it('空白字符串视为没配，不会把交付写到空路径', () => {
    expect(resolveDeliveryDir({ 'dir-1': '   ' }, DIRECTIONS, 'dir-1')).toBeNull()
  })

  it('hasOwnDeliveryDir 只看自己这一层', () => {
    expect(hasOwnDeliveryDir({ 'dir-1': 'D:/dir' }, 'dir-1')).toBe(true)
    expect(hasOwnDeliveryDir({ 'prod-1': 'D:/prod' }, 'dir-1')).toBe(false)
    expect(hasOwnDeliveryDir({ 'dir-1': '  ' }, 'dir-1')).toBe(false)
  })
})

describe('交付的文件范围与命名', () => {
  it('进图片回收站的图不参与交付', () => {
    const task = makeTask({ trashedOutputImages: ['img-1'] })
    expect(deliverableOutputImages(task)).toEqual(['img-2'])
  })

  it('没有图片回收站记录时原样交付全部成品图', () => {
    expect(deliverableOutputImages(makeTask())).toEqual(['img-1', 'img-2'])
  })

  it('整张卡交付时聚合同一 sopJobId 的任务，不含已删除的', () => {
    const tasks = [
      makeTask({ id: 't1', sopJobId: 'job-1' }),
      makeTask({ id: 't2', sopJobId: 'job-1' }),
      makeTask({ id: 't3', sopJobId: 'job-2' }),
      makeTask({ id: 't4', sopJobId: 'job-1', deletedAt: 1 }),
    ]
    expect(tasksOfCard(tasks, tasks[0]).map((item) => item.id)).toEqual(['t1', 't2'])
    // 没有 sopJobId 的单条任务就是自己一张卡
    expect(tasksOfCard(tasks, tasks[2]).map((item) => item.id)).toEqual(['t3'])
  })

  it('文件夹名沿用设置模板，产品与方向从业务树取', () => {
    const name = cardFolderName(makeTask({ sopDirectionId: 'dir-1' }), {
      tasks: [],
      directions: DIRECTIONS,
      deliveryDirs: {},
      template: '{product}-{direction}-{size}',
    })
    expect(name).toBe('百万医疗险-月亮-1024x1024')
  })

  it('模板全空时退回任务 id，不会写进交付目录根下', () => {
    const name = cardFolderName(makeTask({ id: 'abcdef12345' }), {
      tasks: [],
      directions: [],
      deliveryDirs: {},
      template: '',
      custom: 'x',
    })
    expect(name).not.toBe('')
    expect(name.length).toBeGreaterThan(0)
  })
})

describe('交付的图片文件名', () => {
  const context = {
    tasks: [],
    directions: DIRECTIONS,
    deliveryDirs: {},
    template: '{product}-{direction}-{size}-{sop}',
  }

  function cardTask(patch: Partial<TaskRecord> = {}) {
    return makeTask({ sopDirectionId: 'dir-1', sopName: '月亮图', ...patch })
  }

  it('完整命名模板 + 末尾序号，尺寸段用成品的真实尺寸', () => {
    // 请求的是 1024x1024，成品被后处理画成 1080x1920，名字必须反映成品
    const name = deliverImageFileName(3, cardTask(), context, '1080x1920', 'png')
    expect(name).toBe('百万医疗险-月亮-闪屏-月亮图-03.png')
    expect(name).not.toContain('1024x1024')
  })

  it('同一张卡里不同提示词的图不会撞名', () => {
    // 30 个任务各交付一张，序号取提示词序号才不会被 overwrite 覆盖成一张
    const names = Array.from({ length: 30 }, (_, index) => deliverImageFileName(
      index + 1,
      cardTask({ id: `t${index}`, sopJobId: 'job-1', sopPromptIndex: index + 1 }),
      context,
      '1080x1920',
      'png',
    ))
    expect(new Set(names).size).toBe(30)
    expect(names[0].endsWith('-01.png')).toBe(true)
    expect(names[29].endsWith('-30.png')).toBe(true)
  })

  it('序号补两位，超过 99 不截断', () => {
    expect(deliverImageFileName(7, cardTask(), context, '1024x1024', 'jpg').endsWith('-07.jpg')).toBe(true)
    expect(deliverImageFileName(120, cardTask(), context, '1024x1024', 'jpg').endsWith('-120.jpg')).toBe(true)
  })

  it('模板很长时截断模板段，序号仍然留在末尾', () => {
    const name = deliverImageFileName(1, cardTask(), { ...context, template: 'x'.repeat(400) }, '1024x1024', 'png')
    expect(name.length).toBeLessThanOrEqual(185)
    // 先截模板再拼序号：序号不能被截掉
    expect(name.endsWith('-01.png')).toBe(true)
  })

  it('非法字符不会带进文件名', () => {
    const name = deliverImageFileName(1, cardTask({ sopName: 'a/b:c*d' }), context, '1024x1024', 'png')
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
  })
})

describe('「打开交付文件夹」的路径解析', () => {
  const context = {
    tasks: [],
    directions: DIRECTIONS,
    deliveryDirs: {} as Record<string, string>,
    template: '{product}-{direction}-{size}-{sop}',
  }

  it('按目录本来的分隔符拼接，不产出混合路径', () => {
    // 反斜杠在这套工具链里传输容易被吃掉，用字符码构造，保证测的真是 Windows 分隔符
    const bs = String.fromCharCode(92)
    expect(joinDeliveryPath(`D:${bs}交付`, '卡A')).toBe(`D:${bs}交付${bs}卡A`)
    expect(joinDeliveryPath('D:/交付/', '卡A')).toBe('D:/交付/卡A')
  })

  it('交付地址末尾的分隔符先剥掉，不出现双斜杠', () => {
    const bs = String.fromCharCode(92)
    expect(joinDeliveryPath('D:/交付///', '卡A')).toBe('D:/交付/卡A')
    expect(joinDeliveryPath(`D:${bs}交付${bs}`, '卡A')).toBe(`D:${bs}交付${bs}卡A`)
  })

  it('用三级继承到的交付地址拼出卡文件夹', async () => {
    const location = await resolveCardDeliveryLocation(
      makeTask({ sopDirectionId: 'dir-1', sopName: '月亮图' }),
      { ...context, deliveryDirs: { 'prod-1': 'D:/prod' } },
    )
    expect(location?.dir).toBe('D:/prod')
    expect(location?.ownerId).toBe('prod-1')
    expect(location?.isFallback).toBe(false)
    // 测试环境读不到图片字节，尺寸退回请求尺寸，仍是交付时那个文件夹名
    expect(location?.folder).toBe('百万医疗险-月亮-1024x1024-月亮图')
    expect(location?.path).toBe('D:/prod/百万医疗险-月亮-1024x1024-月亮图')
  })

  it('三级都没配时用兜底地址，并标出这是兜底', async () => {
    const location = await resolveCardDeliveryLocation(
      makeTask({ sopDirectionId: 'dir-1', sopName: '月亮图' }),
      { ...context, fallbackDir: 'D:/默认保存' },
    )
    expect(location?.dir).toBe('D:/默认保存')
    expect(location?.ownerId).toBe('')
    expect(location?.isFallback).toBe(true)
  })

  it('既没配交付地址也没有兜底地址时返回 null，由界面提示去配置', async () => {
    expect(await resolveCardDeliveryLocation(makeTask({ sopDirectionId: 'dir-1' }), context)).toBeNull()
  })
})
