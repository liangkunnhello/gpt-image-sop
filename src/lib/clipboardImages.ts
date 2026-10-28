/**
 * 从粘贴板/拖拽的 HTML 里捞出图片，转成 File 走正常上传流程。
 *
 * 为什么要这一步：在浏览器里复制网页上的图，剪贴板里**没有 image/* 项**，
 * 只有一段 `text/html`（里面一个 `<img src="...">`）和纯文本。
 * 输入框是 contentEditable，不拦的话浏览器会把那张图当富文本直接插进提示词 ——
 * 结果就是「图跑到输入框里了」，既没进图片区、也不会传给接口。
 */
export function imageFilesFromHtml(html: string): File[] {
  if (!html || !/<img/i.test(html)) return []
  const urls = extractImageSrcs(html)
  const files: File[] = []
  for (const src of urls) {
    const file = fileFromDataUrl(src)
    if (file) files.push(file)
  }
  return files
}

/** html 里有没有任何 <img>（哪怕是远程地址）—— 有就说明这是一次「粘图」而不是粘文字 */
export function hasImageTag(html: string): boolean {
  return /<img[\s>]/i.test(html)
}

/** 取出 html 里所有 <img src>，含远程地址（用于判断「有图要上传」） */
export function allImageSrcs(html: string): string[] {
  const out: string[] = []
  const pattern = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi
  let match = pattern.exec(html)
  while (match) {
    out.push(match[1].trim())
    match = pattern.exec(html)
  }
  return out
}

/**
 * 只认 data: 图片。
 * 远程 URL（http/https）不直接取：跨域 canvas 会污染、剪贴板里的地址也常常需要鉴权，
 * 强行拉取大概率失败或者拿到一张裂图，交给页面自己决定更稳妥。
 */
export function extractImageSrcs(html: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const pattern = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi
  let match = pattern.exec(html)
  while (match) {
    const src = match[1].trim()
    if (/^data:image\//i.test(src) && !seen.has(src)) {
      seen.add(src)
      out.push(src)
    }
    match = pattern.exec(html)
  }
  return out
}

/** dataURL → File；格式不对返回 null */
export function fileFromDataUrl(dataUrl: string, fallbackName = 'pasted-image'): File | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(dataUrl.trim())
  if (!match) return null
  const mime = match[1].toLowerCase()
  if (!mime.startsWith('image/')) return null
  const isBase64 = Boolean(match[2])
  const body = match[3]
  try {
    const bytes = isBase64 ? base64ToBytes(body) : new TextEncoder().encode(decodeURIComponent(body))
    if (!bytes.length) return null
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    return new File([bytes as BlobPart], `${fallbackName}.${ext}`, { type: mime })
  } catch {
    return null
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * 纯文本里直接是 dataURL 的情况（从 Excel、部分工具复制图片时会出现）。
 * 这种文本如果当文字插进输入框，会变成一大串 base64，比插图更糟。
 */
export function imageFilesFromText(text: string): File[] {
  const trimmed = text.trim()
  if (!/^data:image\//i.test(trimmed)) return []
  const file = fileFromDataUrl(trimmed)
  return file ? [file] : []
}

/**
 * 远程图片 URL → File（尽量取回来当图片上传）。
 *
 * 网页上右键复制图片时，剪贴板 html 里的 src 是 http(s) 地址。
 * 直接插进输入框就会变成一张富文本图片；所以这里尝试 fetch 回来转成 File，
 * 取不到（跨域、鉴权、失效）就返回 null，由调用方退化成「不插入任何东西」——
 * 至少不会在提示词里留一张源头在别人的图。
 */
export async function fileFromRemoteUrl(url: string): Promise<File | null> {
  if (!/^https?:\/\//i.test(url) && !/^blob:/i.test(url)) return null
  try {
    const res = await fetch(url, { credentials: 'omit' })
    if (!res.ok) return null
    // 用 arrayBuffer 自己拼 Blob（不依赖 Response.blob，环境差异小）
    const bytes = await res.arrayBuffer()
    if (!bytes.byteLength) return null
    const headerType = (res.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase()
    // 不能只信 Content-Type，也不能靠大小猜：小尺寸的 jpeg/gif 经常只有几 KB。
    // 类型不对时看文件头魔数（PNG/JPEG/GIF/WEBP/BMP），认不出来才放弃
    const mime = headerType.startsWith('image/')
      ? headerType
      : sniffImageMime(bytes.slice(0, Math.min(16, bytes.byteLength)))
    if (!mime) return null
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    return new File([new Uint8Array(bytes)], `pasted-image.${ext}`, { type: mime })
  } catch (err) {
    console.warn('远程图片转文件失败：', err)
    return null
  }
}

/**
 * html → 可上传的图片文件。
 *
 * 先收 data: 图片（本地就有），再把远程地址尽力抓回来。
 * 一个都拿不到时返回空数组 —— 调用方必须**照样阻止默认行为**，
 * 否则浏览器又会把那张远程图插进提示词。
 */
export async function imageFilesFromHtmlAsync(html: string): Promise<File[]> {
  if (!html || !hasImageTag(html)) return []
  const files = imageFilesFromHtml(html)
  const remote = allImageSrcs(html).filter((src) => !/^data:/i.test(src))
  for (const src of remote.slice(0, 6)) {
    const file = await fileFromRemoteUrl(src)
    if (file) files.push(file)
  }
  return files
}

/** 按文件头认图片类型；认不出来返回空串 */
export function sniffImageMime(head: ArrayBuffer): string {
  const b = new Uint8Array(head)
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  return ''
}
