import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile } from '../types'

// 只桩掉真正的网络层：URL 拼接、body 构造、解析都用真实实现
const apiFetch = vi.fn()
vi.mock('./platform', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  isTauri: false,
}))

const { buildArkGenerationUrl, buildArkRequestBody, callArkImageApi, getArkErrorMessage, isArkOfficialBaseUrl, resolveArkModelId } = await import('./arkImageApi')

function profile(patch: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'ark-1',
    name: '火山方舟',
    provider: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'ark-key',
    model: 'doubao-seedream-4-5-251128',
    imageGenerationModel: 'doubao-seedream-4-5-251128',
    timeout: 600,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    transparentBackgroundMethod: 'local',
    ...patch,
  } as ApiProfile
}

function opts(patch: Record<string, unknown> = {}) {
  return {
    settings: {} as never,
    prompt: '一只橘猫',
    params: { ...DEFAULT_PARAMS },
    inputImageDataUrls: [] as string[],
    ...patch,
  }
}

/** 构造一个成功返回：1 张 b64 图 */
function okResponse(size = '2048x2048') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'doubao-seedream-4-5-251128',
      data: [{ b64_json: 'AAAA', size }],
    }),
  }
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('地址拼接（方舟是 /api/v3，不是 /v1）', () => {
  it('只填域名时补 /api/v3', () => {
    expect(buildArkGenerationUrl('https://ark.cn-beijing.volces.com'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
  })

  it('已经填到 /api/v3 时不再重复拼', () => {
    expect(buildArkGenerationUrl('https://ark.cn-beijing.volces.com/api/v3'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
  })

  it('结尾带斜杠也正常', () => {
    expect(buildArkGenerationUrl('https://ark.cn-beijing.volces.com/api/v3/'))
      .toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
  })

  it('留空时用默认地址', () => {
    expect(buildArkGenerationUrl('')).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations')
  })
})

describe('第三方中转（OpenAI 兼容 /v1）', () => {
  const relay = 'https://relay.example.com/v1'

  it('中转地址已到 /v1 时直接接 images/generations', () => {
    expect(buildArkGenerationUrl(relay)).toBe('https://relay.example.com/v1/images/generations')
  })

  it('中转只填域名时补 /v1（不能补成 /api/v3）', () => {
    expect(buildArkGenerationUrl('https://relay.example.com'))
      .toBe('https://relay.example.com/v1/images/generations')
  })

  it('已经填到 images/generations 时原样使用', () => {
    expect(buildArkGenerationUrl(`${relay}/images/generations`))
      .toBe('https://relay.example.com/v1/images/generations')
  })

  it('按地址判断是否官方直连', () => {
    expect(isArkOfficialBaseUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(true)
    expect(isArkOfficialBaseUrl('')).toBe(true)
    expect(isArkOfficialBaseUrl(relay)).toBe(false)
  })

  it('中转上把官方日期 ID 换成展示名（拿官方 ID 会被 403 未开通）', () => {
    expect(resolveArkModelId('doubao-seedream-4-5-251128', relay)).toBe('Doubao-seedream-4.5')
    expect(resolveArkModelId('Doubao-seedream-4.5', relay)).toBe('Doubao-seedream-4.5')
    expect(resolveArkModelId('', relay)).toBe('Doubao-seedream-4.5')
  })

  it('官方直连上把展示名换回日期 ID', () => {
    expect(resolveArkModelId('Doubao-seedream-4.5', 'https://ark.cn-beijing.volces.com/api/v3'))
      .toBe('doubao-seedream-4-5-251128')
    expect(resolveArkModelId('', 'https://ark.cn-beijing.volces.com/api/v3'))
      .toBe('doubao-seedream-4-5-251128')
  })

  it('4.0 也双向换算', () => {
    expect(resolveArkModelId('Doubao-seedream-4.0', '')).toBe('doubao-seedream-4-0-250828')
    expect(resolveArkModelId('doubao-seedream-4-0-250828', relay)).toBe('Doubao-seedream-4.0')
  })

  it('不认识的模型名原样透传，不自作主张改写', () => {
    expect(resolveArkModelId('Doubao-Seedream-5.0-lite', relay)).toBe('Doubao-Seedream-5.0-lite')
  })

  it('中转请求体里就是展示名', () => {
    const body = buildArkRequestBody(opts(), profile({ baseUrl: relay }))
    expect(body.model).toBe('Doubao-seedream-4.5')
  })

  it('中转报「未开通模型」时把原文带出来', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: '当前账号未开通模型 xxx', type: 'model_not_allowed', code: 'model_not_allowed' } }),
    })
    await expect(callArkImageApi(opts(), profile({ baseUrl: relay }))).rejects.toThrow(/当前账号未开通模型 xxx/)
  })

  it('404 时追加地址排查提示', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    await expect(callArkImageApi(opts(), profile({ baseUrl: relay }))).rejects.toThrow(/官方填到 \/api\/v3/)
  })
})

describe('请求体（对齐 Seedream 4.5 的实际要求）', () => {
  it('关水印 + 要 base64 + 尺寸换算', () => {
    const body = buildArkRequestBody(opts({ params: { ...DEFAULT_PARAMS, size: '1536x2048' } }), profile())
    expect(body.watermark).toBe(false)
    expect(body.response_format).toBe('b64_json')
    expect(body.model).toBe('doubao-seedream-4-5-251128')
    // 1536×2048 低于 4.5 的像素下限，必须换算后才能发
    expect(body.size).not.toBe('1536x2048')
    expect(String(body.size)).toMatch(/^\d+x\d+$/)
  })

  it('auto 尺寸传档位', () => {
    const body = buildArkRequestBody(opts({ params: { ...DEFAULT_PARAMS, size: 'auto' } }), profile())
    expect(body.size).toBe('2K')
  })

  it('没有参考图时不带 image 字段（纯文生图）', () => {
    const body = buildArkRequestBody(opts(), profile())
    expect('image' in body).toBe(false)
  })

  it('有参考图时放 image 数组（不是 OpenAI 的 image[] 编辑接口）', () => {
    const body = buildArkRequestBody(opts({ inputImageDataUrls: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'] }), profile())
    expect(body.image).toEqual(['data:image/png;base64,AAA', 'data:image/png;base64,BBB'])
  })

  it('不发 n / quality 这些方舟不认的参数', () => {
    const body = buildArkRequestBody(opts({ params: { ...DEFAULT_PARAMS, n: 3, quality: 'high' } }), profile())
    expect('n' in body).toBe(false)
    expect('quality' in body).toBe(false)
  })

  it('imageGenerationModel 优先于 model', () => {
    const body = buildArkRequestBody(opts(), profile({ model: 'old', imageGenerationModel: 'doubao-seedream-4-5-251128' }))
    expect(body.model).toBe('doubao-seedream-4-5-251128')
  })
})

describe('调用与结果解析', () => {
  it('成功时返回 data URL，并把实际尺寸与 jpeg 记进 actualParams', async () => {
    apiFetch.mockResolvedValue(okResponse('1728x2304'))
    const result = await callArkImageApi(opts({ params: { ...DEFAULT_PARAMS, size: '1536x2048' } }), profile())
    expect(result.images).toEqual(['data:image/jpeg;base64,AAAA'])
    expect(result.actualParams?.size).toBe('1728x2304')
    // 4.5 只出 jpeg，不能让界面继续显示 png
    expect(result.actualParams?.output_format).toBe('jpeg')
  })

  it('请求带上 Bearer Key 与 JSON 头', async () => {
    apiFetch.mockResolvedValue(okResponse())
    await callArkImageApi(opts(), profile({ apiKey: 'secret' }))
    const [, init] = apiFetch.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    })
  })

  it('接口报错时把方舟的 message 带出来（尺寸不合规之类）', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'InvalidParameter', message: 'size 不满足最小像素要求' } }),
    })
    await expect(callArkImageApi(opts(), profile())).rejects.toThrow(/size 不满足最小像素要求/)
  })

  it('没有遮罩能力时明确报错，不静默忽略', async () => {
    await expect(callArkImageApi(opts({ maskDataUrl: 'data:image/png;base64,MMM' }), profile()))
      .rejects.toThrow(/不支持「局部重绘」/)
  })

  it('返回里没有图片时给出可排查的错误', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) })
    await expect(callArkImageApi(opts(), profile())).rejects.toThrow(/接口没有返回图片数据/)
  })
})

describe('错误信息提取', () => {
  it('优先取 error.message，并补上 code', () => {
    expect(getArkErrorMessage({ error: { message: '余额不足', code: 'QuotaExceeded' } }, '兜底'))
      .toBe('余额不足（QuotaExceeded）')
  })

  it('只有 message 时用它', () => {
    expect(getArkErrorMessage({ message: '参数错误' }, '兜底')).toBe('参数错误')
  })

  it('都取不到时用兜底文案', () => {
    expect(getArkErrorMessage({}, '兜底')).toBe('兜底')
    expect(getArkErrorMessage(null, '兜底')).toBe('兜底')
  })
})
