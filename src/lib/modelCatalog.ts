import type { ApiProfile } from '../types'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { apiFetch } from './platform'

export interface ModelCatalog {
  text: string[]
  image: string[]
  video: string[]
}

function classify(id: string): keyof ModelCatalog {
  const name = id.toLowerCase()
  if (/video|veo|sora|kling|hailuo|seedance|-i2v|-t2v|-r2v|wan\d/.test(name)) return 'video'
  if (/image|dall-e|seedream|flux|imagen|midjourney|nano-banana/.test(name)) return 'image'
  return 'text'
}

/** 从当前渠道拉取可用模型，按文本 / 图片 / 视频粗分 */
export async function fetchModelCatalog(profile: ApiProfile): Promise<ModelCatalog> {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const url = buildApiUrl(profile.baseUrl, 'models', proxyConfig, useApiProxy)

  let ids: string[] = []
  try {
    const res = await apiFetch(url, {
      headers: { Authorization: `Bearer ${profile.apiKey}` },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { data?: Array<{ id?: string }> }
    ids = (json.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id))
  } catch {
    // 多数中转站的 /models 不开放跨域，交给本地服务转发一次
    const res = await fetch('http://127.0.0.1:7799/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: profile.baseUrl, apiKey: profile.apiKey }),
    })
    if (!res.ok) throw new Error('模型列表拉取失败：该渠道未开放跨域，且本地服务未启动')
    const json = await res.json() as { data?: Array<{ id?: string }>; error?: string }
    if (json.error) throw new Error(json.error)
    ids = (json.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id))
  }

  const catalog: ModelCatalog = { text: [], image: [], video: [] }
  for (const id of ids.sort()) catalog[classify(id)].push(id)
  return catalog
}
