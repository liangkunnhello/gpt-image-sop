// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import {
  folderImagesFromFiles,
  formatBytes,
  isFolderPathLike,
  isImageFileName,
  summarizeVerdicts,
} from './folderImages'

/**
 * 文件夹质检的纯逻辑部分。
 * 读盘在 Rust 侧，这里只锁住「哪些算图片」「路径像不像路径」「结果怎么汇总」。
 */
describe('文件夹里的图片识别', () => {
  it('认常见图片扩展名，大小写不敏感', () => {
    expect(isImageFileName('a.jpg')).toBe(true)
    expect(isImageFileName('A.JPEG')).toBe(true)
    expect(isImageFileName('b.png')).toBe(true)
    expect(isImageFileName('c.webp')).toBe(true)
  })

  it('非图片与没有扩展名的不算', () => {
    expect(isImageFileName('说明.txt')).toBe(false)
    expect(isImageFileName('设计稿.psd')).toBe(false)
    expect(isImageFileName('README')).toBe(false)
    expect(isImageFileName('.jpg')).toBe(false)
  })
})

describe('路径形态判断', () => {
  it('UNC 网络共享路径', () => {
    expect(isFolderPathLike('\\\\192.168.202.11\\设计素材交付专用\\能力中心\\20261102')).toBe(true)
  })

  it('盘符路径', () => {
    expect(isFolderPathLike('D:\\交付\\20261102')).toBe(true)
    expect(isFolderPathLike('D:/交付/20261102')).toBe(true)
  })

  it('POSIX 绝对路径', () => {
    expect(isFolderPathLike('/Users/me/Pictures')).toBe(true)
  })

  it('裸目录名 / 空串 / 只有盘符不算', () => {
    expect(isFolderPathLike('20261102')).toBe(false)
    expect(isFolderPathLike('')).toBe(false)
    expect(isFolderPathLike('D:\\')).toBe(false)
  })
})

describe('体积与汇总', () => {
  it('体积按 KB / MB 显示', () => {
    expect(formatBytes(0)).toBe('0 KB')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('结论按 过 / 不过 / 待人工 / 出错 计数', () => {
    expect(summarizeVerdicts(['pass', 'pass', 'fail', 'unsure', 'error'])).toEqual({
      pass: 2,
      fail: 1,
      unsure: 1,
      error: 1,
    })
  })
})

describe('网页版兜底：从 File 列表取图', () => {
  const make = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })

  it('只保留图片并按文件名排序', async () => {
    const images = await folderImagesFromFiles([make('b.png'), make('说明.txt'), make('a.jpg')])
    expect(images.map((item) => item.name)).toEqual(['a.jpg', 'b.png'])
    expect(images[0]!.dataUrl.startsWith('data:')).toBe(true)
  })

  it('按上限截断', async () => {
    const images = await folderImagesFromFiles([make('a.png'), make('b.png'), make('c.png')], 2)
    expect(images).toHaveLength(2)
  })
})
