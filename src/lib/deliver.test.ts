import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { deliverableOutputImages, deliveredFileRefsOf, resolveCardFolderName, type DeliverContext } from './deliver'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'p',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

describe('交付时挑哪些图', () => {
  it('回收站里的不交付', () => {
    const target = task({ outputImages: ['a', 'b', 'c'], trashedOutputImages: ['b'] })
    expect(deliverableOutputImages(target)).toEqual(['a', 'c'])
  })

  it('人工改判为不合格的不交付', () => {
    const target = task({ outputImages: ['a', 'b', 'c'], qcVerdicts: { b: 'fail', c: 'pass' } })
    expect(deliverableOutputImages(target)).toEqual(['a', 'c'])
  })

  it('调用方传进来的排除集合（自动质检不合格）生效', () => {
    const target = task({ outputImages: ['a', 'b'] })
    expect(deliverableOutputImages(target, new Set(['a']))).toEqual(['b'])
  })

  it('人工改判成合格的照常交付，哪怕自动质检判了不合格', () => {
    // 自动结论通过 exclude 传进来，人工改判优先
    const target = task({ outputImages: ['a', 'b'], qcVerdicts: { a: 'pass' } })
    expect(deliverableOutputImages(target, new Set())).toEqual(['a', 'b'])
    // 但人工判不合格的，即使不在排除集合里也不交
    const repaired = task({ outputImages: ['a', 'b'], qcVerdicts: { a: 'fail' } })
    expect(deliverableOutputImages(repaired, new Set())).toEqual(['b'])
  })

  it('空 id 与全被排除时返回空数组', () => {
    expect(deliverableOutputImages(task({ outputImages: ['', 'a'] }))).toEqual(['a'])
    expect(deliverableOutputImages(task({ outputImages: ['a'] }), new Set(['a']))).toEqual([])
  })
})

describe('两张同名卡不互相覆盖文件夹', () => {
  const directions = [
    { id: 'cat', parentId: null, name: '保险', kind: 'category' as const },
    { id: 'prod', parentId: 'cat', name: '百万医疗险', kind: 'product' as const },
    { id: 'dir', parentId: 'prod', name: '月亮', kind: 'direction' as const },
    { id: 'dir2', parentId: 'prod', name: '网赚', kind: 'direction' as const },
  ]
  const context = (tasks: TaskRecord[]): DeliverContext => ({
    tasks,
    directions,
    // 两个方向各自配了交付地址（forward slash 在 Windows 上同样有效）
    deliveryDirs: { cat: 'D:/交付', dir2: 'E:/另一个' },
    template: '{date}-{product}-{direction}-{size}-{sop}',
    custom: '',
  })
  // 同一套配置跑两次得到的两张卡：除 id 外完全一样
  const card = (id: string, extra: Partial<TaskRecord> = {}) => task({
    id,
    sopJobId: `job-${id}`,
    sopName: '大字报',
    sopDirectionId: 'dir',
    params: { ...DEFAULT_PARAMS, size: '1080x1920' },
    createdAt: new Date('2026-10-27T10:00:00').getTime(),
    ...extra,
  })
  // 模板名按运行结果取（尺寸段会被映射成「闪屏」这类友好名），不硬编码
  const baseName = () => resolveCardFolderName(card('probe'), context([])).base

  it('没有别的卡占用时用模板名', () => {
    const a = card('a')
    const claim = resolveCardFolderName(a, context([a]))
    expect(claim.folder).toBe(claim.base)
    expect(claim.isNew).toBe(true)
  })

  it('另一个同名卡已占用时改用 -02', () => {
    const base = baseName()
    const a = card('a', { deliverFolder: base })
    const b = card('b')
    const claim = resolveCardFolderName(b, context([a, b]))
    expect(claim.base).toBe(base)
    expect(claim.folder).toBe(`${base}-02`)
    expect(claim.isNew).toBe(true)
  })

  it('占用两个时继续排到 -03', () => {
    const base = baseName()
    const a = card('a', { deliverFolder: base })
    const b = card('b', { deliverFolder: `${base}-02` })
    const c = card('c')
    expect(resolveCardFolderName(c, context([a, b, c])).folder).toBe(`${base}-03`)
  })

  it('自己已经占过名字时沿用，重交付不会越交越多', () => {
    const base = baseName()
    const a = card('a', { deliverFolder: base })
    const b = card('b', { deliverFolder: `${base}-02` })
    const claim = resolveCardFolderName(b, context([a, b]))
    expect(claim.folder).toBe(`${base}-02`)
    expect(claim.isNew).toBe(false)
  })

  it('交付地址不同的卡不算冲突（各自写各自目录）', () => {
    const base = baseName()
    // 另一张卡挂在 dir2，交付到 E:/另一个
    const other = card('other', { sopDirectionId: 'dir2', deliverFolder: base })
    const mine = card('mine')
    const claim = resolveCardFolderName(mine, context([other, mine]))
    expect(claim.folder).toBe(base)
  })

  it('改了命名模板后按新名字重新占位', () => {
    const mine = card('mine', { deliverFolder: '旧模板算出来的名字' })
    const claim = resolveCardFolderName(mine, { ...context([mine]), template: '{date}-{sop}' })
    expect(claim.base).toBe('20261027-大字报')
    expect(claim.folder).toBe('20261027-大字报')
    expect(claim.isNew).toBe(true)
  })

  it('同卡多条任务只算一张卡，不会自己跟自己撞', () => {
    const base = baseName()
    // 同一 sopJobId 的两条任务，各自记着同一个名字
    const t1 = card('t1', { sopJobId: 'job-shared', deliverFolder: base })
    const t2 = card('t2', { sopJobId: 'job-shared', deliverFolder: base })
    expect(resolveCardFolderName(t1, context([t1, t2])).folder).toBe(base)
    expect(resolveCardFolderName(t2, context([t1, t2])).folder).toBe(base)
  })
})

describe('进回收站时删哪个交付文件', () => {
  const directions = [
    { id: 'cat', parentId: null, name: '保险', kind: 'category' as const },
    { id: 'prod', parentId: 'cat', name: '百万医疗险', kind: 'product' as const },
    { id: 'dir', parentId: 'prod', name: '月亮', kind: 'direction' as const },
  ]
  const context = (tasks: TaskRecord[]): DeliverContext => ({
    tasks,
    directions,
    deliveryDirs: { cat: 'D:/交付' },
    template: '{date}-{sop}',
    custom: '',
  })
  const card = (id: string, extra: Partial<TaskRecord> = {}) => task({
    id,
    sopJobId: 'job-1',
    sopName: '大字报',
    sopDirectionId: 'dir',
    params: { ...DEFAULT_PARAMS, size: '1080x1920' },
    createdAt: new Date('2026-10-27T10:00:00').getTime(),
    deliverFolder: '20261027-大字报',
    ...extra,
  })

  it('交付时记过文件名就精确删那一个', async () => {
    const t = card('t1', { outputImages: ['img-a'], deliveredFileNames: { 'img-a': '20261027-大字报-01.jpg' } })
    const refs = await deliveredFileRefsOf(t, 'img-a', context([t]))
    expect(refs).toEqual([{ dir: 'D:/交付', relative: '20261027-大字报/20261027-大字报-01.jpg' }])
  })

  it('老数据没记录时按卡片顺序推算序号，扩展名全部列出来（删的时候不存在的会跳过）', async () => {
    const t1 = card('t1', { outputImages: ['img-a'], sopPromptIndex: 3 })
    const refs = await deliveredFileRefsOf(t1, 'img-a', context([t1]))
    expect(refs.map((item) => item.relative)).toEqual([
      '20261027-大字报/20261027-大字报-03.jpg',
      '20261027-大字报/20261027-大字报-03.jpeg',
      '20261027-大字报/20261027-大字报-03.png',
      '20261027-大字报/20261027-大字报-03.webp',
    ])
    expect(refs.every((item) => item.dir === 'D:/交付')).toBe(true)
  })

  it('同卡多条任务时序号接着前一条往下排', async () => {
    const t1 = card('t1', { outputImages: ['img-a'], sopPromptIndex: undefined })
    const t2 = card('t2', { outputImages: ['img-b'], sopPromptIndex: undefined })
    const refs = await deliveredFileRefsOf(t2, 'img-b', context([t1, t2]))
    expect(refs[0].relative).toBe('20261027-大字报/20261027-大字报-02.jpg')
  })

  it('没有交付地址时返回空，不会乱删', async () => {
    const t = card('t1', { outputImages: ['img-a'], sopDirectionId: undefined })
    expect(await deliveredFileRefsOf(t, 'img-a', { ...context([t]), deliveryDirs: {} })).toEqual([])
  })
})
