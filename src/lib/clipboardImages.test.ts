// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allImageSrcs,
  extractImageSrcs,
  fileFromDataUrl,
  fileFromRemoteUrl,
  hasImageTag,
  imageFilesFromHtml,
  imageFilesFromHtmlAsync,
  imageFilesFromText,
} from './clipboardImages'

/** 1×1 透明 PNG */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

afterEach(() => {
  vi.restoreAllMocks()
})

describe('粘贴图片 html 解析', () => {
  it('认出 html 里的 <img>（包括远程地址）', () => {
    expect(hasImageTag('<img src="https://x.test/a.png">')).toBe(true)
    expect(hasImageTag('<IMG SRC="a.png" />')).toBe(true)
    expect(hasImageTag('<p>纯文字</p>')).toBe(false)
    expect(hasImageTag('')).toBe(false)
  })

  it('取出全部 src（含远程），并单独挑出 dataURL', () => {
    const html = `<img src="${PNG_DATA_URL}"><img src='https://x.test/b.png'>`
    expect(allImageSrcs(html)).toHaveLength(2)
    expect(allImageSrcs(html)[1]).toBe('https://x.test/b.png')
    expect(extractImageSrcs(html)).toEqual([PNG_DATA_URL])
  })

  it('dataURL 能转成 File，名字和类型都对', () => {
    const file = fileFromDataUrl(PNG_DATA_URL)!
    expect(file).toBeTruthy()
    expect(file.type).toBe('image/png')
    expect(file.name).toBe('pasted-image.png')
    expect(file.size).toBeGreaterThan(0)
  })

  it('jpeg 的扩展名写成 jpg（不是 jpeg）', () => {
    const jpeg = PNG_DATA_URL.replace('image/png', 'image/jpeg')
    expect(fileFromDataUrl(jpeg)!.name).toBe('pasted-image.jpg')
  })

  it('不是图片的 dataURL / 坏数据返回 null', () => {
    expect(fileFromDataUrl('data:text/plain;base64,aGk=')).toBeNull()
    expect(fileFromDataUrl('https://x.test/a.png')).toBeNull()
    expect(fileFromDataUrl('data:image/png;base64,')).toBeNull()
    expect(fileFromDataUrl('乱七八糟')).toBeNull()
  })

  it('html 里的 dataURL 图片会被收成文件', () => {
    const files = imageFilesFromHtml(`<img src="${PNG_DATA_URL}">`)
    expect(files).toHaveLength(1)
    expect(files[0].type).toBe('image/png')
  })

  it('html 里没有图时返回空数组', () => {
    expect(imageFilesFromHtml('<p>只有文字</p>')).toEqual([])
    expect(imageFilesFromHtml('')).toEqual([])
  })

  it('纯文本直接是 dataURL 时也当图片（否则会把一大串 base64 插进提示词）', () => {
    expect(imageFilesFromText(PNG_DATA_URL)).toHaveLength(1)
    expect(imageFilesFromText('  ' + PNG_DATA_URL + '  ')).toHaveLength(1)
    expect(imageFilesFromText('描述你想生成的图片')).toEqual([])
  })

  it('远程图片：取回来就转成 File', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })))
    const file = await fileFromRemoteUrl('https://x.test/a.png')
    expect(file).toBeTruthy()
    expect(file!.type).toBe('image/png')
    expect(file!.name).toBe('pasted-image.png')
  })

  it('没有 content-type 时按文件头认类型（小图不能被当成非图片）', async () => {
    // 真实场景：某些图床返回 application/octet-stream，图本身是几 KB 的小 jpeg
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(jpeg, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })))
    const file = await fileFromRemoteUrl('https://x.test/small.jpg')
    expect(file!.type).toBe('image/jpeg')
    expect(file!.name).toBe('pasted-image.jpg')
  })

  it('魔数认不出时放弃（不把 HTML 错误页当图传上去）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new TextEncoder().encode('<html>not an image</html>'),
      { status: 200, headers: { 'content-type': 'text/html' } },
    )))
    expect(await fileFromRemoteUrl('https://x.test/err')).toBeNull()
  })

  it('远程图片取不到时返回 null，不抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await fileFromRemoteUrl('https://x.test/missing.png')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('CORS') }))
    expect(await fileFromRemoteUrl('https://x.test/blocked.png')).toBeNull()
  })

  it('非 http/blob 地址不尝试抓取', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await fileFromRemoteUrl('file:///C:/a.png')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('async 版本：dataURL 与远程图一起收，全失败则空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      { status: 200, headers: { 'content-type': 'image/png' } },
    )))
    const files = await imageFilesFromHtmlAsync(`<img src="${PNG_DATA_URL}"><img src="https://x.test/b.png">`)
    expect(files).toHaveLength(2)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('CORS') }))
    const failed = await imageFilesFromHtmlAsync('<img src="https://x.test/b.png">')
    // 拿不到就返回空，调用方照样要阻止默认插入（否则图会变成富文本）
    expect(failed).toEqual([])
  })

  it('没有 <img> 的空 html 不触发网络请求', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await imageFilesFromHtmlAsync('<p>文字</p>')).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})
