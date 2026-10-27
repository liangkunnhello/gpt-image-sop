// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { SopDirectionNode } from '../types'
import {
  downloadImageAsDataUrl,
  lingjingLogin,
  mergeTemplates,
  planDirectionTree,
  watermarkToTemplate,
  type LingjingWatermark,
} from './lingjingImport'
import type { PostTemplate } from './postTemplate'

const node = (id: string, parentId: string | null, name: string, kind: SopDirectionNode['kind']): SopDirectionNode => (
  { id, parentId, name, kind }
)

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('方向树合并', () => {
  const lingjing = {
    groups: [{ id: 6, groupName: '保险', sortOrder: 1 }],
    products: [{ id: 26, productName: '京东保', groupId: 6, sortOrder: 1 }],
    directions: [
      { id: 90, directionName: '月亮', productId: 26, sortOrder: 2 },
      { id: 91, directionName: '大字报', productId: 26, sortOrder: 1 },
    ],
  }

  it('空库时按 分类→产品→方向 全量新建', () => {
    const plan = planDirectionTree([], lingjing)
    expect(plan.created).toBe(4)
    expect(plan.reused).toBe(0)

    const category = plan.nodes.find((item) => item.name === '保险')!
    const product = plan.nodes.find((item) => item.name === '京东保')!
    expect(category.kind).toBe('category')
    expect(category.parentId).toBeNull()
    expect(product.kind).toBe('product')
    expect(product.parentId).toBe(category.id)
    // 方向挂在产品下，按 sortOrder 排（大字报 1 在月亮 2 前）
    const directions = plan.nodes.filter((item) => item.kind === 'direction')
    expect(directions.map((item) => item.name)).toEqual(['大字报', '月亮'])
    expect(directions.every((item) => item.parentId === product.id)).toBe(true)
    expect(plan.directionIds.get(90)).toBeTruthy()
  })

  it('同级同名就复用，不重复建节点', () => {
    const existing = [
      node('c1', null, '保险', 'category'),
      node('p1', 'c1', '京东保', 'product'),
      node('d1', 'p1', '月亮', 'direction'),
    ]
    const plan = planDirectionTree(existing, lingjing)
    expect(plan.created).toBe(1) // 只多出一个「大字报」
    expect(plan.reused).toBe(3)
    expect(plan.directionIds.get(90)).toBe('d1')
    expect(plan.nodes).toHaveLength(4)
  })

  it('同名但在别的父级下不算同一个，各建各的', () => {
    const existing = [node('c2', null, '别的线', 'category'), node('p2', 'c2', '京东保', 'product')]
    const plan = planDirectionTree(existing, lingjing)
    const products = plan.nodes.filter((item) => item.kind === 'product' && item.name === '京东保')
    expect(products).toHaveLength(2)
  })

  it('回收站里同名的当不存在，导入会建新节点', () => {
    const existing = [
      { ...node('c1', null, '保险', 'category'), deletedAt: 1 },
    ]
    const plan = planDirectionTree(existing, lingjing)
    expect(plan.created).toBe(4)
    expect(plan.groupIds.get(6)).not.toBe('c1')
  })
})

describe('水印 → 后处理模板', () => {
  const base: LingjingWatermark = {
    id: 366,
    name: '京东保-带logo水印-广点通-横版',
    channelCode: 'gdt',
    canvasWidth: 1280,
    canvasHeight: 720,
    enabled: '1',
    elements: [
      {
        type: 'text',
        content: '免责声明两行\n第二行',
        textAlign: 'right',
        x: 0.4476,
        y: 0.9125,
        width: 0.5515,
        height: 0.0833,
        fontSize: 25,
        fontColor: '#dbdbdb',
        strokeColor: '#454545',
        strokeWidth: 1,
        fontWeight: 'bold',
        opacity: 1,
      },
    ],
  }

  it('右对齐文字取框的右边缘（不然整体会左移一截）', async () => {
    const { template } = await watermarkToTemplate(base)
    const element = template!.elements[0]
    expect(element.align).toBe('right')
    expect(element.x).toBeCloseTo(0.4476 + 0.5515, 4)
    expect(element.y).toBeCloseTo(0.9125, 4)
    expect(element.fontSize).toBe(25)
    expect(element.color).toBe('#dbdbdb')
    expect(element.strokeColor).toBe('#454545')
    expect(element.strokeWidth).toBe(1)
    expect(element.fontWeight).toBe(700)
    expect(element.text).toContain('第二行')
  })

  it('居中取框中线，左对齐直接用 x', async () => {
    const centered = await watermarkToTemplate({
      ...base,
      elements: [{ ...base.elements![0], textAlign: 'center' }],
    })
    expect(centered.template!.elements[0].x).toBeCloseTo(0.4476 + 0.5515 / 2, 4)

    const left = await watermarkToTemplate({
      ...base,
      elements: [{ ...base.elements![0], textAlign: 'left' }],
    })
    expect(left.template!.elements[0].x).toBeCloseTo(0.4476, 4)
  })

  it('模板带的渠道、画布尺寸、体积上限都跟过来', async () => {
    const { template } = await watermarkToTemplate(base, { sizeLimitKb: 399 })
    expect(template!.channel).toBe('gdt')
    expect(template!.width).toBe(1280)
    expect(template!.height).toBe(720)
    expect(template!.maxFileKb).toBe(399)
    expect(template!.enabled).toBe(true)
  })

  it('enabled=0 的水印导成未启用模板', async () => {
    const { template } = await watermarkToTemplate({ ...base, enabled: '0' })
    expect(template!.enabled).toBe(false)
  })

  it('opacity=0 的图层是灵境里「关掉的图层」，不导进来', async () => {
    const { template } = await watermarkToTemplate({
      ...base,
      elements: [base.elements![0], { ...base.elements![0], content: '隐藏层', opacity: 0 }],
    })
    expect(template!.elements).toHaveLength(1)
    expect(template!.elements[0].text).not.toContain('隐藏层')
  })

  it('取不到 logo 图片时跳过该图层并计数，文字层照常保留', async () => {
    const { template, logosSkipped } = await watermarkToTemplate({
      ...base,
      elements: [
        ...base.elements!,
        { type: 'image', content: 'https://cos.example.com/wm.png', x: 0.01, y: 0.01, width: 0.1, height: 0.056 },
      ],
    }, { resolveLogo: async () => null })
    expect(logosSkipped).toBe(1)
    expect(template!.elements).toHaveLength(1)
    expect(template!.elements[0].kind).toBe('text')
  })

  it('logo 转成 dataURL 后按尺寸字典算高宽比', async () => {
    const { template } = await watermarkToTemplate({
      ...base,
      elements: [{ type: 'image', content: 'https://cos.example.com/wm.png', x: 0.0185, y: 0.0104, width: 0.1, height: 0.05625 }],
    }, { resolveLogo: async () => 'data:image/png;base64,AAA' })
    const logo = template!.elements[0]
    expect(logo.kind).toBe('logo')
    expect(logo.text).toBe('data:image/png;base64,AAA')
    expect(logo.width).toBeCloseTo(0.1, 4)
    // 0.05625 × 720 / (0.1 × 1280) = 0.316…
    expect(logo.aspect).toBeCloseTo(0.05625 * 720 / (0.1 * 1280), 4)
  })

  it('缺画布尺寸或全是废图层时返回原因，不产模板', async () => {
    expect((await watermarkToTemplate({ ...base, canvasWidth: 0 })).reason).toContain('画布')
    const empty = await watermarkToTemplate({ ...base, elements: [] })
    expect(empty.template).toBeNull()
    expect(empty.reason).toContain('图层')

    const onlyLogo = await watermarkToTemplate({
      ...base,
      elements: [{ type: 'image', content: 'https://x/y.png', width: 0.1, height: 0.1 }],
    }, { resolveLogo: async () => null })
    expect(onlyLogo.template).toBeNull()
    expect(onlyLogo.reason).toContain('logo')
  })
})

describe('模板合并', () => {
  const template = (overrides: Partial<PostTemplate> = {}): PostTemplate => ({
    id: 'tpl-1',
    label: '月亮-横版',
    width: 1280,
    height: 720,
    channel: 'gdt',
    enabled: true,
    isDefault: false,
    elements: [],
    ...overrides,
  })

  it('同名同尺寸同渠道 → 更新内容但保留本地 id', () => {
    const current = [template({ id: 'local-1' })]
    const result = mergeTemplates(current, [template({ id: 'tpl-lingjing-9', enabled: false })])
    expect(result.created).toBe(0)
    expect(result.updated).toBe(1)
    expect(result.templates).toHaveLength(1)
    expect(result.templates[0].id).toBe('local-1')
    expect(result.templates[0].enabled).toBe(false)
  })

  it('同名但尺寸不同 → 追加一套，不把两套排版塞进一个模板', () => {
    const result = mergeTemplates([template()], [template({ id: 'tpl-2', label: '月亮-横版', width: 1080, height: 1920 })])
    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.templates).toHaveLength(2)
  })

  it('名字不同一律追加', () => {
    const result = mergeTemplates([template()], [template({ id: 'tpl-3', label: '大字报-横版' })])
    expect(result.templates.map((item) => item.label)).toEqual(['月亮-横版', '大字报-横版'])
  })
})

describe('登录', () => {
  it('rememberMe 恒为 false，成功后返回会话', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, msg: '操作成功', data: '/index' }))
    const session = await lingjingLogin({ baseUrl: 'junbo-cy.jetmobo.com', username: ' u ', password: 'p', fetchImpl })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://junbo-cy.jetmobo.com/login')
    expect(init.credentials).toBe('include')
    expect(init.body).toContain('rememberMe=false')
    expect(init.body).toContain('username=u')
    expect(session.baseUrl).toBe('https://junbo-cy.jetmobo.com')
  })

  it('账号密码错直接把后端提示抛出来', async () => {
    const fetchImpl = async () => jsonResponse({ code: 500, msg: '用户不存在/密码错误' })
    await expect(lingjingLogin({ username: 'u', password: 'p', fetchImpl })).rejects.toThrow('用户不存在/密码错误')
  })

  it('连不上时给出人话提示（含跨域可能）', async () => {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch') }
    await expect(lingjingLogin({ username: 'u', password: 'p', fetchImpl })).rejects.toThrow('跨域')
  })
})

describe('logo 图片转 dataURL', () => {
  it('fetch 失败返回 null，调用方跳过该图层', async () => {
    expect(await downloadImageAsDataUrl('https://cos.example.com/a.png', async () => { throw new Error('cors') })).toBeNull()
  })

  it('拿到的不是图片也返回 null', async () => {
    const fetchImpl = async () => new Response('not image', { headers: { 'Content-Type': 'text/plain' } })
    expect(await downloadImageAsDataUrl('https://cos.example.com/a.txt', fetchImpl)).toBeNull()
  })

  it('正常图片转成 data URL', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    // 直接用 jsdom 的 Blob：undici 的 Response.blob() 会换一套实现，FileReader 读不了
    const fetchImpl = async () => ({ ok: true, blob: async () => blob }) as unknown as Response
    const result = await downloadImageAsDataUrl('https://cos.example.com/a.png', fetchImpl)
    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('浏览器直连被 CORS 拦下时，退到 dev server 的图片代理再取一次', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      // COS 桶没配 CORS：直连抛 TypeError，和浏览器里的表现一致
      if (url.startsWith('https://cos.example.com')) throw new TypeError('Failed to fetch')
      return { ok: true, blob: async () => blob } as unknown as Response
    }) as typeof fetch
    try {
      const result = await downloadImageAsDataUrl('https://cos.example.com/a.png')
      expect(result).toMatch(/^data:image\/png;base64,/)
      expect(calls[1]).toBe(`/__imgproxy?url=${encodeURIComponent('https://cos.example.com/a.png')}`)
    } finally {
      globalThis.fetch = original
    }
  })

  it('调用方自己传了 fetch 时不走代理兜底（单测与自定义请求只打一次）', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string) => {
      calls.push(url)
      throw new Error('blocked')
    }
    expect(await downloadImageAsDataUrl('https://cos.example.com/a.png', fetchImpl)).toBeNull()
    expect(calls).toHaveLength(1)
  })
})
