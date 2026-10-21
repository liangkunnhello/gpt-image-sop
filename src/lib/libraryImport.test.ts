import { describe, expect, it } from 'vitest'

import { uniqueImportName } from './libraryImport'

describe('uniqueImportName', () => {
  it('没有重名时原样使用', () => {
    expect(uniqueImportName(['A', 'B'], 'C')).toBe('C')
  })

  it('重名时带上来源产品名', () => {
    expect(uniqueImportName(['默认提示词'], '默认提示词', '京东保')).toBe('默认提示词（京东保）')
  })

  it('带上来源仍重名时补序号', () => {
    const existing = ['默认提示词', '默认提示词（京东保）', '默认提示词（京东保） 2']
    expect(uniqueImportName(existing, '默认提示词', '京东保')).toBe('默认提示词（京东保） 3')
  })

  it('名称为空时退回「未命名」', () => {
    expect(uniqueImportName([], '   ')).toBe('未命名')
    expect(uniqueImportName(['未命名'], '  ', '京东保')).toBe('未命名（京东保）')
  })
})
