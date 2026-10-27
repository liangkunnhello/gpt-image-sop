import { describe, expect, it } from 'vitest'

import {
  parseDirectionCopy,
  parseLingjingArchive,
  runLingjingArchiveImport,
  type ArchiveFileInput,
  type LingjingMapping,
} from './lingjingArchive'
import type { PostTemplate } from './postTemplate'

const file = (name: string, value: unknown): ArchiveFileInput => ({ name, text: JSON.stringify(value) })

const textEl = (over: Record<string, unknown> = {}) => ({
  type: 'text',
  content: '本保障责任详见条款',
  x: 0.5,
  y: 0.9,
  width: 0.4,
  height: 0.05,
  fontSize: 20,
  fontColor: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 1,
  textAlign: 'right',
  opacity: 1,
  ...over,
})

const watermarkSpec = (items: Array<Record<string, unknown>>) => ({ entity: 'watermark', watermarks: items })

const baseWatermark = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `水印 ${id}`,
  channelCode: 'gdt',
  baseSizeId: 1,
  canvas: { width: 1080, height: 1920 },
  enabled: 1,
  elements: [textEl()],
  ...over,
})

const mapping = (over: Partial<LingjingMapping> = {}): LingjingMapping => ({
  groupId: 6,
  groupName: '保险',
  productId: 7,
  productName: '百万医疗险',
  directionId: null,
  directionName: null,
  watermarks: [{ id: 100, name: '水印 100', channelCode: 'gdt', baseSizeId: 1, canvasWidth: 1080, canvasHeight: 1920 }],
  nas: { nasDirectory: '\\\\nas\\保险\\百万医疗险\\图片' },
  ...over,
})

const options = () => ({
  existingNodes: [],
  existingTemplates: {} as Record<string, PostTemplate[]>,
  existingDeliveryDirs: {} as Record<string, string>,
  existingPresets: [],
  resolveLogo: async () => null,
  wantTemplates: true,
  wantDelivery: true,
  wantPresets: false,
})

describe('归档文件识别', () => {
  it('按内容形状认出各类文件', async () => {
    const { detectArchiveKind } = await import('./lingjingArchive')
    expect(detectArchiveKind({ mappings: [] })).toBe('mapping')
    expect(detectArchiveKind({ watermarks: [] })).toBe('watermark')
    expect(detectArchiveKind({ presets: [] })).toBe('nas')
    expect(detectArchiveKind({ sizes: [] })).toBe('sizes')
    expect(detectArchiveKind([{ groupName: '保险' }])).toBe('groups')
    expect(detectArchiveKind([{ productName: '百万医疗险' }])).toBe('products')
    expect(detectArchiveKind([{ directionName: '月亮' }])).toBe('directions')
    expect(detectArchiveKind([1, 2, 3])).toBe('unknown')
    expect(detectArchiveKind('nope')).toBe('unknown')
  })
})

describe('解析归档', () => {
  it('画布从 canvas 归一化到 canvasWidth/Height，图层从 elementsJson 解析', () => {
    const archive = parseLingjingArchive([
      file('watermark_spec.json', watermarkSpec([
        baseWatermark(1),
        { id: 2, name: '字符串图层', canvas: { width: 1280, height: 720 }, elementsJson: JSON.stringify([textEl()]) },
      ])),
      file('product_direction_map.json', { mappings: [mapping()] }),
    ])
    expect(archive.watermarks.get(1)?.canvasWidth).toBe(1080)
    expect(archive.watermarks.get(1)?.canvasHeight).toBe(1920)
    expect(archive.watermarks.get(2)?.elements).toHaveLength(1)
  })

  it('只给映射文件时，方向树从映射里反推', () => {
    const archive = parseLingjingArchive([
      file('product_direction_map.json', {
        mappings: [
          mapping(),
          mapping({ directionId: 19, directionName: '月亮' }),
          mapping({ groupId: 7, groupName: '银行', productId: 8, productName: '信用卡' }),
        ],
      }),
    ])
    expect(archive.groups.map((item) => item.groupName)).toEqual(['保险', '银行'])
    expect(archive.products.map((item) => item.productName)).toEqual(['百万医疗险', '信用卡'])
    expect(archive.directions.map((item) => item.directionName)).toEqual(['月亮'])
  })

  it('产品树（嵌套 tree.json）一个文件就把三层都读到，带上方向文案', () => {
    const archive = parseLingjingArchive([
      file('tree.json', [
        {
          id: 6,
          name: '保险',
          type: 'group',
          products: [
            {
              id: 7,
              name: '百万医疗险',
              type: 'product',
              directions: [
                { id: 9, name: '月亮', type: 'direction', productCopy: '投保条件0~70岁' },
                { id: 17, name: '图标', type: 'direction', productCopy: null },
              ],
            },
          ],
        },
        { id: 8, name: '银行', type: 'group', products: [] },
      ]),
    ])
    expect(archive.groups.map((item) => item.groupName)).toEqual(['保险', '银行'])
    expect(archive.products).toEqual([{ id: 7, productName: '百万医疗险', groupId: 6, sortOrder: 0 }])
    expect(archive.directions.map((item) => item.directionName)).toEqual(['月亮', '图标'])
    expect(archive.directions[0].productCopy).toBe('投保条件0~70岁')
    expect(archive.directions[1].productCopy).toBeUndefined()
    expect(archive.missing.join('|')).toContain('产品-方向映射')
    expect(archive.missing.join('|')).not.toContain('方向树')
  })

  it('缺哪块如实写在 missing 里', () => {
    const archive = parseLingjingArchive([file('watermark_spec.json', watermarkSpec([baseWatermark(1)]))])
    expect(archive.missing.join('|')).toContain('方向树')
    expect(archive.missing.join('|')).toContain('产品-方向映射')
    expect(archive.missing.join('|')).not.toContain('水印图层')
  })

  it('文件不是合法 JSON 时报出文件名', () => {
    expect(() => parseLingjingArchive([{ name: '坏文件.json', text: '{{{' }])).toThrow('坏文件.json')
  })
})

describe('归档导入', () => {
  it('建出 分类 → 产品 → 方向 三层，并把模板挂到对应节点上', async () => {
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([baseWatermark(100)])),
      file('product_direction_map.json', { mappings: [mapping({ directionId: 19, directionName: '月亮' })] }),
      file('sizes.json', { sizes: [{ id: 1, name: '广点通 1080x1920', channelCode: 'gdt', width: 1080, height: 1920, maxFileSizeKb: 399 }] }),
    ], options())

    expect(result.tree.created).toBe(3)
    const kinds = result.nodes.map((item) => item.kind).sort()
    expect(kinds).toEqual(['category', 'direction', 'product'])
    const direction = result.nodes.find((item) => item.kind === 'direction')!
    const templates = result.postTemplates[direction.id]
    expect(templates).toHaveLength(1)
    expect(templates[0].width).toBe(1080)
    expect(templates[0].height).toBe(1920)
    expect(templates[0].channel).toBe('gdt')
    // 体积上限取自尺寸字典
    expect(templates[0].maxFileKb).toBe(399)
    // 右对齐要取框的右边缘，否则整块文字会左移一个框宽
    expect(templates[0].elements[0].x).toBeCloseTo(0.9, 5)
    expect(templates[0].elements[0].align).toBe('right')
  })

  it('方向和产品的水印完全一致时直接继承，不另存一套', async () => {
    const ref = { id: 100, name: '水印 100', channelCode: 'gdt', baseSizeId: 1, canvasWidth: 1080, canvasHeight: 1920 }
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([baseWatermark(100)])),
      file('product_direction_map.json', {
        mappings: [
          mapping({ watermarks: [ref], nas: { nasDirectory: '\\\\nas\\产品' } }),
          mapping({ directionId: 19, directionName: '月亮', watermarks: [ref], nas: { nasDirectory: '\\\\nas\\产品' } }),
        ],
      }),
    ], options())

    const product = result.nodes.find((item) => item.kind === 'product')!
    const direction = result.nodes.find((item) => item.kind === 'direction')!
    expect(result.templates.inherited).toBe(1)
    expect(result.postTemplates[direction.id]).toBeUndefined()
    expect(result.postTemplates[product.id]).toHaveLength(1)
    // 交付地址同理：一样就不抄到方向，留着继承
    expect(result.deliveryDirs[product.id]).toBe('\\\\nas\\产品')
    expect(result.deliveryDirs[direction.id]).toBeUndefined()
    expect(result.delivery.inherited).toBe(1)
  })

  it('方向覆盖了自己的水印和交付地址时各存一份', async () => {
    const productRef = { id: 100, name: '水印 100', channelCode: 'gdt', baseSizeId: 1, canvasWidth: 1080, canvasHeight: 1920 }
    const directionRef = { id: 200, name: '水印 200', channelCode: 'gdt', baseSizeId: 1, canvasWidth: 1080, canvasHeight: 1920 }
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([baseWatermark(100), baseWatermark(200, { name: '方向专属' })])),
      file('product_direction_map.json', {
        mappings: [
          mapping({ watermarks: [productRef], nas: { nasDirectory: '\\\\nas\\产品' } }),
          mapping({
            directionId: 19,
            directionName: '月亮',
            watermarks: [directionRef],
            nas: { nasDirectory: '\\\\nas\\月亮' },
          }),
        ],
      }),
    ], options())

    const direction = result.nodes.find((item) => item.kind === 'direction')!
    expect(result.postTemplates[direction.id]?.[0].label).toBe('方向专属')
    expect(result.deliveryDirs[direction.id]).toBe('\\\\nas\\月亮')
    expect(result.templates.inherited).toBe(0)
  })

  it('enabled=0 的水印导成未启用模板', async () => {
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([baseWatermark(100, { enabled: 0 })])),
      file('product_direction_map.json', { mappings: [mapping()] }),
    ], options())
    const templates = Object.values(result.postTemplates).flat()
    expect(templates[0].enabled).toBe(false)
  })

  it('logo 取不到图片时跳过该图层并计数，文字层照常可用', async () => {
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([
        baseWatermark(100, {
          elements: [textEl(), { type: 'image', content: 'https://cos.example.com/a.png', x: 0.02, y: 0.01, width: 0.1, height: 0.05, opacity: 1 }],
        }),
      ])),
      file('product_direction_map.json', { mappings: [mapping()] }),
    ], options())

    expect(result.templates.logosSkipped).toBe(1)
    const template = Object.values(result.postTemplates).flat()[0]
    expect(template.elements.map((item) => item.kind)).toEqual(['text'])
  })

  it('logo 能取到就转成 dataURL 存进模板，并记下高宽比', async () => {
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([
        baseWatermark(100, {
          elements: [{ type: 'image', content: 'https://cos.example.com/a.png', x: 0.02, y: 0.01, width: 0.2, height: 0.1, opacity: 1 }],
        }),
      ])),
      file('product_direction_map.json', { mappings: [mapping()] }),
    ], { ...options(), resolveLogo: async () => 'data:image/png;base64,AAA' })

    const logo = Object.values(result.postTemplates).flat()[0].elements[0]
    expect(logo.kind).toBe('logo')
    expect(logo.text).toBe('data:image/png;base64,AAA')
    // 0.1 * 1920 / (0.2 * 1080) = 0.8888…
    expect(logo.aspect).toBeCloseTo(0.889, 3)
  })

  it('opacity=0 的图层是灵境里关掉的图层，不导', async () => {
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([
        baseWatermark(100, { elements: [textEl(), textEl({ content: '隐藏', opacity: 0 })] }),
      ])),
      file('product_direction_map.json', { mappings: [mapping()] }),
    ], options())
    expect(Object.values(result.postTemplates).flat()[0].elements).toHaveLength(1)
  })

  it('同名同尺寸同渠道的模板更新内容但保留本地 id', async () => {
    const existing: PostTemplate = {
      id: 'local-keep-me',
      label: '水印 100',
      width: 1080,
      height: 1920,
      channel: 'gdt',
      enabled: false,
      isDefault: true,
      elements: [],
    }
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([baseWatermark(100)])),
      file('product_direction_map.json', { mappings: [mapping()] }),
    ], {
      ...options(),
      existingTemplates: { 'product-7': [existing] },
      // 已有节点要挂在同一个分类下，否则会被当成新节点（同名不同父级 = 两个产品）
      existingNodes: [
        { id: 'cat-6', parentId: null, name: '保险', kind: 'category' },
        { id: 'product-7', parentId: 'cat-6', name: '百万医疗险', kind: 'product' },
      ],
    })

    const templates = result.postTemplates['product-7']
    expect(templates).toHaveLength(1)
    expect(templates[0].id).toBe('local-keep-me')
    expect(templates[0].elements).toHaveLength(1)
    expect(result.templates.updated).toBe(1)
    expect(result.templates.created).toBe(0)
  })

  it('关掉「水印转模板」时只导树和交付地址', async () => {
    const result = await runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([baseWatermark(100)])),
      file('product_direction_map.json', { mappings: [mapping()] }),
    ], { ...options(), wantTemplates: false })

    expect(Object.keys(result.postTemplates)).toHaveLength(0)
    expect(Object.keys(result.deliveryDirs)).toHaveLength(1)
  })

  it('认不出方向树时直接报错，不写半截数据', async () => {
    await expect(runLingjingArchiveImport([
      file('watermark_spec.json', watermarkSpec([baseWatermark(100)])),
    ], options())).rejects.toThrow('认不出方向树')
  })
})

describe('方向文案拆卖点 / 风格', () => {
  it('认「风格统一为 X」与「文案：…」两种标记', () => {
    const parsed = parseDirectionCopy('萌宠', [
      '风格统一为扁平插画',
      '文案只采用如下：',
      '主文案：赔付总限额600万',
      '文案：免健康告知(五类重大既往症除外）',
    ].join('\n'))
    expect(parsed.style?.content).toBe('扁平插画')
    expect(parsed.points.map((item) => item.content)).toEqual([
      '赔付总限额600万',
      '免健康告知(五类重大既往症除外）',
    ])
  })

  it('没有标记时整段当一条卖点，不硬拆', () => {
    const parsed = parseDirectionCopy('月亮', '百万医疗险  投保条件0~70岁 |  大病小病均可保障(责任内)')
    expect(parsed.style).toBeUndefined()
    expect(parsed.points).toHaveLength(1)
    expect(parsed.points[0].content).toContain('投保条件0~70岁')
  })

  it('空文案不产生预设', () => {
    expect(parseDirectionCopy('月亮', '   ').points).toHaveLength(0)
  })

  it('开了「卖点 / 风格」时写进预设，重复导入不会长出第二条', async () => {
    const files = [
      file('directions.json', [
        { id: 19, directionName: '萌宠', productId: 7, productCopy: '风格统一为扁平插画\n文案：赔付总限额600万' },
      ]),
      file('products.json', [{ id: 7, productName: '百万医疗险', groupId: 6 }]),
      file('groups.json', [{ id: 6, groupName: '保险' }]),
    ]
    const first = await runLingjingArchiveImport(files, { ...options(), wantPresets: true })
    expect(first.presetsStats.created).toBe(2)
    expect(first.presets.map((item) => item.kind).sort()).toEqual(['point', 'style'])

    const second = await runLingjingArchiveImport(files, {
      ...options(),
      wantPresets: true,
      existingNodes: first.nodes,
      existingPresets: first.presets,
    })
    expect(second.presetsStats.created).toBe(0)
    expect(second.presets).toHaveLength(2)
  })
})
