/**
 * 火山方舟（Volcengine Ark）Seedream 系列的专用适配。
 *
 * 为什么不走「OpenAI 兼容」那条通用路径：
 * - 参考图放 `image` 字段（数组），**不支持** `/images/edits` multipart；
 * - 尺寸有硬性像素下限（4.5 最小 368 万像素），需要换算；
 * - 输出固定 jpeg，`response_format` 需要显式指定；
 * - 水印默认可能开着，必须显式关掉；
 * - baseUrl 是 `/api/v3`，用通用拼接会被补成 `/api/v3/v1/...`。
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

/** 方舟默认地址（到 /api/v3 为止） */
export const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** 4.5 的模型 ID（带版本号的那个） */
export const DEFAULT_ARK_MODEL = 'doubao-seedream-4-5-251128'

/**
 * 拼出图片生成地址。
 *
 * 用户可能只填域名，也可能已经填到 /api/v3 —— 两种都要能对上，
 * 不能像 OpenAI 那条路径那样自动补 /v1。
 */
export function buildArkGenerationUrl(baseUrl: string): string {
  const base = (baseUrl || DEFAULT_ARK_BASE_URL).trim().replace(/\/+$/, '')
  if (!base) return `${DEFAULT_ARK_BASE_URL}/images/generations`
  if (/\/api\/v\d+$/i.test(base)) return `${base}/images/generations`
  return `${base}/api/v3/images/generations`
}

/** 请求体（抽出来为了能单测，不用真的发请求） */
export function buildArkRequestBody(opts: CallApiOptions, profile: ApiProfile): Record<string, unknown> {
  const model = (profile.imageGenerationModel || profile.model || DEFAULT_ARK_MODEL).trim() || DEFAULT_ARK_MODEL
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
      throw new Error(message || (await getApiErrorMessage(response)))
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
