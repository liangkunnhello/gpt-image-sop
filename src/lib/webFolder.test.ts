import { describe, expect, it } from 'vitest'

import { writeFilesToWebFolder } from './webFolder'

/** 用假句柄模拟浏览器的目录 API：只关心重名判断和写了几个文件 */
function createFakeRoot(existing: string[]) {
  const folders = new Set(existing)
  const created: string[] = []
  const written: Record<string, string[]> = {}

  const makeFolder = (name: string) => ({
    name,
    async getDirectoryHandle() {
      throw new DOMException('not found', 'NotFoundError')
    },
    async getFileHandle(fileName: string) {
      written[name] = [...(written[name] ?? []), fileName]
      return {
        async createWritable() {
          return {
            async write(blob: Blob) {
              written[name] = [...(written[name] ?? []), `data:${await blob.text()}`]
            },
            async close() {},
          }
        },
      }
    },
  })

  const root = {
    name: 'root',
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      if (!options?.create) {
        if (folders.has(name)) return makeFolder(name) as unknown as FileSystemDirectoryHandle
        throw new DOMException('not found', 'NotFoundError')
      }
      folders.add(name)
      created.push(name)
      return makeFolder(name) as unknown as FileSystemDirectoryHandle
    },
  }

  return { root: root as unknown as FileSystemDirectoryHandle, created, written }
}

describe('writeFilesToWebFolder', () => {
  it('没有重名时直接用原名建文件夹并写文件', async () => {
    const { root, created, written } = createFakeRoot([])
    const name = await writeFilesToWebFolder(root, '20261021-百万医疗险', [
      { name: '01.png', blob: new Blob(['a']) },
      { name: '02.png', blob: new Blob(['b']) },
    ])
    expect(name).toBe('20261021-百万医疗险')
    expect(created).toEqual(['20261021-百万医疗险'])
    expect(written['20261021-百万医疗险']).toEqual(['01.png', 'data:a', '02.png', 'data:b'])
  })

  it('重名时按 -02、-03 递增，不覆盖已有文件夹', async () => {
    const { root, created } = createFakeRoot(['海报', '海报-02'])
    const name = await writeFilesToWebFolder(root, '海报', [{ name: '01.png', blob: new Blob(['x']) }])
    expect(name).toBe('海报-03')
    expect(created).toEqual(['海报-03'])
  })
})
