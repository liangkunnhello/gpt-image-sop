import { describe, expect, it } from 'vitest'
import type { SopDirectionNode } from '../types'
import { matchDirectionByPath, normalizeNodeName, planAutoDirections, planMissingNodes } from './assetDirection'

/**
 * 真实素材的路径长这样（采集工具的分类结果目录）：
 *   保险/京东保/图标/横版、APP-拉新/快手/旅游/横版、未知/未知/未知/横版
 * 树是用户手建的，两边名字不完全一致，所以这里盯着「能对上 / 不乱配」两件事。
 */
const node = (id: string, name: string, kind: SopDirectionNode['kind'], parentId: string | null = null): SopDirectionNode =>
  ({ id, name, kind, parentId })

const TREE: SopDirectionNode[] = [
  node('cat-ins', '保险', 'category'),
  node('prod-mil', '百万医疗险', 'product', 'cat-ins'),
  node('dir-moon', '月亮', 'direction', 'prod-mil'),
  node('dir-icon', '图标', 'direction', 'prod-mil'),
  node('dir-poster', '大字报', 'direction', 'prod-mil'),
  node('prod-jd', '京东保', 'product', 'cat-ins'),
  node('dir-jd-flat', '扁平插画', 'direction', 'prod-jd'),
  node('dir-jd-3d', '3D插画', 'direction', 'prod-jd'),
  node('cat-app', 'APP-拉新', 'category'),
  node('prod-ks', '快手', 'product', 'cat-app'),
  node('dir-travel', '旅游', 'direction', 'prod-ks'),
  node('dir-money', '网赚', 'direction', 'prod-ks'),
]

describe('normalizeNodeName', () => {
  it('去空白、统一大小写、全角括号转半角', () => {
    expect(normalizeNodeName(' 3D 插画（微缩） ')).toBe('3d插画(微缩)')
  })

  it('空值不炸', () => {
    expect(normalizeNodeName('')).toBe('')
  })
})

describe('matchDirectionByPath', () => {
  it('标准四段路径：业务线/产品/方向/横竖版', () => {
    const hit = matchDirectionByPath(['保险', '京东保', '扁平插画', '横版'], TREE)
    expect(hit).toMatchObject({ directionId: 'dir-jd-flat', productName: '京东保', kind: 'exact' })
  })

  it('两个产品都有「图标」时，按产品锚点归到正确的那一个', () => {
    // 京东保下面没有「图标」，百万医疗险下面才有 —— 不能跨产品乱配
    expect(matchDirectionByPath(['保险', '京东保', '图标', '横版'], TREE)).toBeNull()
    expect(matchDirectionByPath(['保险', '百万医疗险', '图标', '竖版'], TREE)?.directionId).toBe('dir-icon')
  })

  it('目录名是「方向名-细分」时走前缀匹配', () => {
    // 采集工具的目录：3D插画-京东硬广；树里的方向叫「3D插画」
    const hit = matchDirectionByPath(['保险', '京东保', '3D插画-京东硬广', '横版'], TREE)
    expect(hit).toMatchObject({ directionId: 'dir-jd-3d', kind: 'prefix' })
  })

  it('精确匹配优先于前缀匹配', () => {
    const tree = [...TREE, node('dir-jd-3d-hard', '3D插画-京东硬广', 'direction', 'prod-jd')]
    const hit = matchDirectionByPath(['保险', '京东保', '3D插画-京东硬广', '横版'], tree)
    expect(hit?.directionId).toBe('dir-jd-3d-hard')
  })

  it('树里没有这个产品时不硬配（卡券 / 淘宝联盟 这些还没有节点）', () => {
    expect(matchDirectionByPath(['卡券', 'QQ阅读-25元', '内容创意'], TREE)).toBeNull()
    expect(matchDirectionByPath(['APP-拉新', '淘宝联盟', '购物'], TREE)).toBeNull()
  })

  it('未知 / 待确认 目录一律不猜', () => {
    expect(matchDirectionByPath(['未知', '未知', '未知'], TREE)).toBeNull()
    expect(matchDirectionByPath(['_待确认', 'API失败'], TREE)).toBeNull()
  })

  it('已删除的节点不参与匹配', () => {
    const tree = TREE.map((item) => (item.id === 'dir-travel' ? { ...item, deletedAt: 1 } : item))
    expect(matchDirectionByPath(['APP-拉新', '快手', '旅游'], tree)).toBeNull()
  })

  it('路径本身就是产品（采集结果直接落在产品目录下）时不乱给方向', () => {
    expect(matchDirectionByPath(['保险', '京东保'], TREE)).toBeNull()
  })

  it('空路径返回 null', () => {
    expect(matchDirectionByPath([], TREE)).toBeNull()
    expect(matchDirectionByPath(undefined, TREE)).toBeNull()
  })
})

describe('planMissingNodes 缺失节点', () => {
  it('树里没有的产品和方向会被列出来，未知目录不建', () => {
    const plan = planMissingNodes([
      { dirPath: ['卡券', 'QQ阅读-25元', '插画', '横版'] },
      { dirPath: ['保险', '百万医疗险', '左右图文', '竖版'] },
      { dirPath: ['未知', '未知', '未知', '横版'] },
      { dirPath: ['保险', '京东保', '扁平插画', '横版'] },
    ], TREE)
    expect(plan.categories).toEqual(['卡券'])
    expect(plan.products).toEqual([{ category: '卡券', name: 'QQ阅读-25元' }])
    // 百万医疗险存在，但缺「左右图文」这个方向
    expect(plan.directions).toEqual(expect.arrayContaining([
      { category: '卡券', product: 'QQ阅读-25元', name: '插画' },
      { category: '保险', product: '百万医疗险', name: '左右图文' },
    ]))
    expect(plan.directions).toHaveLength(2)
    // 未知/未知 那 1 条被跳过，已能匹配的也不计入
    expect(plan.assetCount).toBe(2)
  })

  it('人工设定过的不参与推断', () => {
    const plan = planMissingNodes([
      { dirPath: ['卡券', 'QQ阅读-25元', '插画'], directionSource: 'manual', directionId: 'x' },
    ], TREE)
    expect(plan.assetCount).toBe(0)
    expect(plan.products).toHaveLength(0)
  })
})

describe('planAutoDirections', () => {
  const base = { platformIds: [], reportNames: [], createdAt: 0 }

  it('只给能匹配上的、且不是人工设定的素材补归属', () => {
    const updates = planAutoDirections([
      { ...base, id: 'a', dirPath: ['保险', '京东保', '扁平插画'] },
      { ...base, id: 'b', dirPath: ['保险', '京东保', '扁平插画'], directionSource: 'manual', directionId: 'keep' },
      { ...base, id: 'c', dirPath: ['卡券', 'QQ阅读-25元', '插画'] },
    ], TREE)
    expect(updates.map((item) => item.id)).toEqual(['a'])
    expect(updates[0]).toMatchObject({ directionId: 'dir-jd-flat', directionSource: 'auto' })
  })

  it('已经归对的素材不再产生写库操作', () => {
    const updates = planAutoDirections([
      { ...base, id: 'a', dirPath: ['保险', '京东保', '扁平插画'], directionId: 'dir-jd-flat', directionSource: 'auto' },
    ], TREE)
    expect(updates).toHaveLength(0)
  })
})
