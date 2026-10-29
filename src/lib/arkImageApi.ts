/**
 * 火山方舟（Volcengine Ark）Seedream 系列的专用适配。
 *
 * 为什么不走「OpenAI 兼容」那条通用路径：
 * - 参考图放 `image` 字段（数组），**不支持** `/images/edits` multipart；
 * - 尺寸有硬性像素下限（4.5 最小 368 万像素），需要换算；
 * - 输出固定 jpeg，`response_format` 需要显式指定；
 * - 水印默认可能开着，必须显式关掉；
 * - baseUrl 有两种形态，拼接规则不同：
 *   - 官方直连：`https://ark.cn-beijing.volces.com/api/v3`（补 `/api/v3`）
 *   - 第三方中转：`https://xxx.com/v1`（OpenAI 兼容，直接接 `/images/generations`）
 *   用通用拼接会被补成 `/api/v3/v1/...` 或 `/v1/api/v3/...`，两边都 404。
 *
 * 另一处两边不一致的是**模型名**：
 * - 官方要带日期版本号，如 `doubao-seedream-4-5-251128`；
 * - 中转按展示名路由，如 `Doubao-seedream-4.5`（拿官方 ID 去问会 403「未开通模型」）。
 * 所以模型名按 baseUrl 自动换算，用户在哪边写哪种写法都能跑。
 */

import type { ApiProfile, TaskParams } from '../types'
import { toArkSize } from './arkSize'
import {
  linkAbortSignal,
  createRequestTimeoutError,
  assertImageInputPayloadSize,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
  isHttpUrl,
  mergeActualParams,
  normalizeBase64Image,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'
import { apiFetch } from './platform'

/** 方舟官方地址（到 /api/v3 为止） */
export const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** 官方直连的 4.5 模型 ID（带日期版本号） */
export const DEFAULT_ARK_MODEL = 'doubao-seedream-4-5-251128'

/** 第三方中转用的 4.5 模型名（不带日期，大小写按中转的模型列表） */
export const DEFAULT_ARK_RELAY_MODEL = 'Doubao-seedream-4.5'

/**
 * 是否官方直连。
 *
 * 官方和第三方中转对「模型名」「URL 拼接」的要求都不同，
 * 所有差异都从这一个判断派生，别处不要再各判一次。
 */
export function isArkOfficialBaseUrl(baseUrl?: string): boolean {
  const base = (baseUrl || '').trim()
  // 地址留空时走 DEFAULT_ARK_BASE_URL，也就是官方
  if (!base) return true
  return /volces\.com/i.test(base)
}

/**
 * 拼出图片生成地址。
 *
 * 用户可能填域名、填到 `/v1`、填到 `/api/v3`，甚至直接填到 `/images/generations`——
 * 四种都要能对上，不能像 OpenAI 那条路径那样无条件补 `/v1`。
 */
export function buildArkGenerationUrl(baseUrl?: string): string {
  const base = (baseUrl || DEFAULT_ARK_BASE_URL).trim().replace(/\/+$/, '')
  if (!base) return `${DEFAULT_ARK_BASE_URL}/images/generations`
  // 已经填完整了，别再补一层
  if (/\/images\/generations$/i.test(base)) return base
  // 已经到版本路径（官方 /api/v3、中转 /v1）→ 直接接 images/generations
  if (/\/v\d+$/i.test(base)) return `${base}/images/generations`
  // 官方域名但没带路径 → 补 /api/v3
  if (isArkOfficialBaseUrl(base)) return `${base}/api/v3/images/generations`
  // 其它（第三方中转）按 OpenAI 兼容约定补 /v1
  return `${base}/v1/images/generations`
}

/**
 * 同一代模型的两种写法。
 *
 * marker 是把模型名去掉非字母数字后用来识别的片段：
 * `doubao-seedream-4-5-251128` 和 `Doubao-seedream-4.5` 都会归一成含 `seedream45` 的串。
 */
interface ArkModelFamily {
  marker: string
  official: string
  relay: string
}

const ARK_MODEL_FAMILIES: ArkModelFamily[] = [
  { marker: 'seedream45', official: DEFAULT_ARK_MODEL, relay: DEFAULT_ARK_RELAY_MODEL },
  { marker: 'seedream40', official: 'doubao-seedream-4-0-250828', relay: 'Doubao-seedream-4.0' },
]

/**
 * 按地址形态把模型名换算成对方认的写法。
 *
 * 认识的代（4.5 / 4.0）双向换算；不认识的（比如中转上的 5.0-lite）原样透传，
 * 免得自作聪明改坏用户手填的名字。
 */
export function resolveArkModelId(model: string, baseUrl?: string): string {
  // 模型字段允许多个（逗号分隔），出图只用第一个
  const trimmed = (model || '').split(',')[0].trim()
  const official = isArkOfficialBaseUrl(baseUrl)
  const key = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '')
  const family = ARK_MODEL_FAMILIES.find((item) => key.includes(item.marker))
  if (family) return official ? family.official : family.relay
  if (trimmed) return trimmed
  return official ? DEFAULT_ARK_MODEL : DEFAULT_ARK_RELAY_MODEL
}

/** 请求体（抽出来为了能单测，不用真的发请求） */
export function buildArkRequestBody(opts: CallApiOptions, profile: ApiProfile): Record<string, unknown> {
  const model = resolveArkModelId(profile.imageGenerationModel || profile.model, profile.baseUrl)
  return {
    model,
    prompt: opts.prompt,
    // 尺寸按 4.5 的像素下限换算；auto 时传档位让模型自己定比例
    size: toArkSize(opts.params.size),
    // 直接要 base64：URL 有效期有限，拿到后还要再下载一次，多一层失败点
    response_format: 'b64_json',
    // 默认可能带水印，出图要交付必须显式关掉
    watermark: false,
    // 参考图：Ark 用 image 数组（0 张时整条不传，就是纯文生图）
    ...(opts.inputImageDataUrls.length ? { image: [...opts.inputImageDataUrls] } : {}),
  }
}

interface ArkResponseItem {
  b64_json?: unknown
  url?: unknown
  size?: unknown
}

interface ArkResponse {
  data?: unknown
  error?: unknown
  message?: unknown
}

/** 把方舟的错误结构尽量翻成人话 */
export function getArkErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const record = payload as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>
    const message = typeof err.message === 'string' ? err.message.trim() : ''
    const code = typeof err.code === 'string' ? err.code.trim() : ''
    if (message) return code ? `${message}（${code}）` : message
  }
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  return message || fallback
}

/**
 * 404 / 405 时补一句排查方向。
 *
 * 中转站对不存在的路径往往不返回 404，而是自己兜一句「所有供应商暂时不可用」，
 * 光看那句话完全想不到是地址拼错了 —— 所以这里只在状态码明确异常时才追加提示。
 */
function describeArkHttpFailure(status: number, message: string): string {
  if (status !== 404 && status !== 405) return message
  return `${message}（生图地址可能不对：官方填到 /api/v3，第三方中转填到 /v1）`
}

/**
 * 解析返回的图片。
 *
 * 优先 b64_json（我们请求的就是它），兼容只有 URL 的情况。
 * 返回的尺寸以接口给的为准 —— 换算过尺寸时，界面要显示实际值。
 */
async function parseArkImages(
  payload: unknown,
  fallbackMime: string,
  signal?: AbortSignal,
): Promise<{ images: string[]; rawImageUrls: string[]; sizes: string[] }> {
  const record = (payload ?? {}) as ArkResponse
  const items = Array.isArray(record.data) ? (record.data as ArkResponseItem[]) : []
  const images: string[] = []
  const rawImageUrls: string[] = []
  const sizes: string[] = []

  for (const item of items) {
    const size = typeof item.size === 'string' ? item.size : ''
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      images.push(normalizeBase64Image(item.b64_json.trim(), fallbackMime))
      sizes.push(size)
      continue
    }
    if (isHttpUrl(item.url)) {
      rawImageUrls.push(item.url)
      images.push(await fetchImageUrlAsDataUrl(item.url, fallbackMime, signal))
      sizes.push(size)
    }
  }

  return { images, rawImageUrls, sizes }
}

/**
 * 调方舟生成一张图。
 *
 * 说明：`n` 不在这里处理 —— 项目里多张图是按并发多请求拆开的（见 planPlainRequests），
 * 一次请求只要一张，这样失败范围也可控。
 */
export async function callArkImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  // 方舟没有遮罩参数，局部重绘在这里跑不了；静默忽略会让用户以为生效了
  if (opts.maskDataUrl) {
    throw new Error('火山方舟的 Seedream 模型不支持「局部重绘」遮罩，请改用其他服务商，或关闭遮罩后再生成。')
  }

  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0),
  )

  const controller = new AbortController()
  const timeoutMs = Math.max(1, profile.timeout || 600) * 1000
  const cleanupAbort = linkAbortSignal(controller, opts.signal, timeoutMs, () => createRequestTimeoutError(profile.timeout))

  try {
    const response = await apiFetch(buildArkGenerationUrl(profile.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(buildArkRequestBody(opts, profile)),
      signal: controller.signal,
    })

    if (!response.ok) {
      // 错误体里通常带具体原因（尺寸不合规、余额不足等），要原样带出来
      let payload: unknown = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      const message = getArkErrorMessage(payload, `请求失败（HTTP ${response.status}）`)
      throw new Error(describeArkHttpFailure(response.status, message || (await getApiErrorMessage(response))))
    }

    const payload = await response.json() as unknown
    // 4.5 只出 jpeg；按 jpeg 兜底，避免 b64 没带前缀时被当成 png
    const { images, rawImageUrls, sizes } = await parseArkImages(payload, 'image/jpeg', controller.signal)
    if (!images.length) {
      throw new Error(`接口没有返回图片数据：${getArkErrorMessage(payload, '响应里没有 data 字段')}`)
    }

    const actualParams: Partial<TaskParams> = {}
    const actualSize = sizes.find((item) => /^\d+x\d+$/.test(item))
    if (actualSize) actualParams.size = actualSize
    // 输出格式是模型定的，记录真实值，详情页才不会显示"png"
    actualParams.output_format = 'jpeg'

    return {
      images,
      actualParams: mergeActualParams(actualParams),
      actualParamsList: images.map(() => actualParams),
      revisedPrompts: images.map(() => undefined),
      ...(rawImageUrls.length ? { rawImageUrls } : {}),
    }
  } finally {
    cleanupAbort()
  }
}
