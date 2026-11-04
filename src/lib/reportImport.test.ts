import { describe, expect, it } from 'vitest'
import {
  buildNameIndex,
  buildSpendRecords,
  detectMapping,
  normalizeAssetName,
  normalizeDate,
  parseCsv,
  parseSheetXml,
  toNumber,
  type SheetTable,
} from './reportImport'

/**
 * 这里的用例全部来自真实报表（`素材报表明细.xlsx`，7885 行 / 19 列）。
 * 编造的数据测不出真正会踩的坑 —— 下面第一条就是只有真实数据才暴露的。
 */
describe('parseSheetXml 单元格解析', () => {
  it('自闭合的空单元格不能吞掉紧随其后的单元格', () => {
    /**
     * 真实报表里大量存在 `<c r="I5" t="inlineStr" />`（`/` 前有个空格）。
     * 早期用贪婪的 `([^>]*)(?:\/>|>...)` 匹配时，会把 ` /` 一起吃掉、
     * 走 `>` 分支一路匹配到**下一个** `</c>`，把紧邻的「消耗」整格吞掉。
     * 后果：3889 行消耗读成 0，全表合计从 396474.89 掉到 205211.81。
     */
    const xml = '<row r="5"><c r="I5" t="inlineStr" /><c r="J5" t="n"><v>7499.14</v></c></row>'
    const rows = parseSheetXml(xml, [])
    expect(rows).toHaveLength(1)
    // I 列（索引 8）是空串，J 列（索引 9）必须保住 7499.14
    expect(rows[0][8]).toBe('')
    expect(rows[0][9]).toBe('7499.14')
  })

  it('自闭合标签不带空格也要正确', () => {
    const xml = '<row r="2"><c r="A2"/><c r="B2"><v>7</v></c></row>'
    const rows = parseSheetXml(xml, [])
    expect(rows[0][0]).toBe('')
    expect(rows[0][1]).toBe('7')
  })

  it('inlineStr 文本、数字、缺失列都能对齐到正确列位', () => {
    const xml = [
      '<row r="1">',
      '<c r="A1" t="inlineStr"><is><t>ID</t></is></c>',
      '<c r="C1" t="inlineStr"><is><t>消耗</t></is></c>',
      '</row>',
    ].join('')
    const rows = parseSheetXml(xml, [])
    expect(rows[0][0]).toBe('ID')
    // B 列缺失，要补空串占位，否则 C 会挪到 B 的位置
    expect(rows[0][1]).toBe('')
    expect(rows[0][2]).toBe('消耗')
  })

  it('共享字符串索引能正确取值', () => {
    const xml = '<row r="2"><c r="A2" t="s"><v>1</v></c></row>'
    const rows = parseSheetXml(xml, ['零号', '一号'])
    expect(rows[0][0]).toBe('一号')
  })

  it('整行为空的行被跳过（xlsx 末尾常有）', () => {
    const xml = '<row r="2"><c r="A2"></c></row><row r="3"><c r="A3" t="n"><v>1</v></c></row>'
    const rows = parseSheetXml(xml, [])
    expect(rows).toHaveLength(1)
  })
})

describe('detectMapping 列识别', () => {
  /** 真实报表的表头，顺序一致 */
  const HEADERS = [
    'ID', '预览地址', '产品ID', '产品名称', '图片名称', '创意库文件名', '标签', '设计', '优化师', '消耗',
    '上传时间', '企业微信客服率（人数）', '上新计划数', '减少此类作品数', '互动数', '日期', '媒体', '数据平台', '是否异常',
  ]

  it('真实表头能识别出全部关键列', () => {
    const mapping = detectMapping(HEADERS)
    expect(mapping.platformId).toBe(0)   // ID
    expect(mapping.assetKey).toBe(4)     // 图片名称
    expect(mapping.spend).toBe(9)        // 消耗
    expect(mapping.date).toBe(15)        // 日期
    expect(mapping.media).toBe(16)       // 媒体
    expect(mapping.designer).toBe(7)     // 设计
    expect(mapping.optimizer).toBe(8)    // 优化师
    expect(mapping.abnormal).toBe(18)    // 是否异常
  })

  it('ID 必须精确匹配，不能抢到「产品ID」', () => {
    // 「产品ID」在 ID 后面，若用包含匹配「id」会先撞上它
    const headers = ['产品ID', '素材描述', 'ID', '消耗']
    expect(detectMapping(headers).platformId).toBe(2)
  })

  it('日期不能被「上传时间」抢走', () => {
    // 上传时间是素材上架时间，不是投放日；用它是错的
    const mapping = detectMapping(['上传时间', '日期', '消耗'])
    expect(mapping.date).toBe(1)
  })

  it('同一列不会被两个字段同时占用', () => {
    const mapping = detectMapping(HEADERS)
    const used = Object.values(mapping).filter((v) => v >= 0)
    expect(new Set(used).size).toBe(used.length)
  })
})

describe('normalizeDate', () => {
  it('识别常见写法', () => {
    expect(normalizeDate('2026-11-03')).toBe('2026-11-03')
    expect(normalizeDate('2026/11/3')).toBe('2026-11-03')
    expect(normalizeDate('2026.11.03')).toBe('2026-11-03')
    expect(normalizeDate('20261103')).toBe('2026-11-03')
  })

  it('Excel 日期序列号能换算', () => {
    expect(normalizeDate('46350')).toBe('2026-11-24')
  })

  it('读不出来时返回空串，交给上层跳过', () => {
    expect(normalizeDate('')).toBe('')
    expect(normalizeDate('第三季度')).toBe('')
  })
})

describe('toNumber', () => {
  it('容忍千分位与货币符号', () => {
    expect(toNumber('8,045.47')).toBe(8045.47)
    expect(toNumber('¥1234.5')).toBe(1234.5)
    expect(toNumber(' 12 ')).toBe(12)
  })

  it('空值和乱码按 0 处理，不抛错', () => {
    expect(toNumber('')).toBe(0)
    expect(toNumber('无')).toBe(0)
  })
})

describe('normalizeAssetName', () => {
  it('去扩展名与空白、统一小写，让报表名和交付文件名对得上', () => {
    // 报表「图片名称」不带扩展名，交付记录里带，必须归一后才能匹配
    expect(normalizeAssetName('20260913-百万医疗险-大图-182.JPG')).toBe(
      normalizeAssetName('20260913-百万医疗险-大图-182'),
    )
    expect(normalizeAssetName(' A b .png ')).toBe('ab')
  })
})

describe('buildNameIndex + buildSpendRecords 匹配与幂等', () => {
  const table: SheetTable = {
    headers: ['ID', '图片名称', '消耗', '日期'],
    rows: [
      ['1001', '海报A', '100.5', '2026-11-03'],
      // 同一素材同一天再出现一行（不同计划），消耗要合并而不是覆盖
      ['1001', '海报A', '50.25', '2026-11-03'],
      ['1002', '对不上的图', '30', '2026-11-03'],
    ],
  }
  const mapping = { date: 3, spend: 2, platformId: 0, assetKey: 1, media: -1, productName: -1, designer: -1, optimizer: -1, abnormal: -1, previewUrl: -1 }

  const nameIndex = buildNameIndex([
    { deliveredFileNames: { 'hash-a': '海报A.jpg' }, deliverFolder: '卡1' },
  ])

  it('按交付文件名匹配到图片哈希', () => {
    expect(nameIndex.get('海报a')).toBe('hash-a')
    // 文件夹名 + 文件名 的组合也能匹配
    expect(nameIndex.get('卡1/海报a')).toBe('hash-a')
  })

  it('同素材同日多行合并成一条，消耗相加', () => {
    const preview = buildSpendRecords(table, mapping, nameIndex, 'imp-1')
    const target = preview.records.filter((r) => r.platformId === '1001')
    expect(target).toHaveLength(1)
    expect(target[0].spend).toBe(150.75)
    expect(target[0].assetId).toBe('hash-a')
    expect(target[0].date).toBe('2026-11-03')
  })

  it('匹配不上的进未匹配，并留下待认领样本', () => {
    const preview = buildSpendRecords(table, mapping, nameIndex, 'imp-1')
    expect(preview.matchedCount).toBe(1)
    expect(preview.unmatchedCount).toBe(1)
    expect(preview.unmatchedSamples[0].assetName).toBe('对不上的图')
  })

  it('合计等于所有行之和（真实报表可据此对账）', () => {
    const preview = buildSpendRecords(table, mapping, nameIndex, 'imp-1')
    expect(preview.totalSpend).toBe(180.75)
  })

  it('预览地址列能被识别，并原样存进流水（将来按图匹配与人工看图都要用）', () => {
    const withPreview: SheetTable = {
      headers: ['ID', '预览地址', '图片名称', '消耗', '日期'],
      rows: [['2001', 'https://example.com/a.jpg', '海报C', '12', '2026-11-03']],
    }
    const m = detectMapping(withPreview.headers)
    expect(m.previewUrl).toBe(1)
    const preview = buildSpendRecords(withPreview, m, nameIndex, 'imp-3')
    expect(preview.records[0].previewUrl).toBe('https://example.com/a.jpg')
  })

  it('缺日期的行被跳过并记录原因，不静默丢弃', () => {
    const bad: SheetTable = { headers: table.headers, rows: [['1003', '海报B', '10', '']] }
    const preview = buildSpendRecords(bad, mapping, nameIndex, 'imp-2')
    expect(preview.records).toHaveLength(0)
    expect(preview.skipped).toHaveLength(1)
    expect(preview.skipped[0].reason).toContain('日期')
  })

  it('主键是「平台ID + 日期」，同一份报表重复导入不会翻倍', () => {
    const once = buildSpendRecords(table, mapping, nameIndex, 'imp-1')
    const twice = buildSpendRecords(table, mapping, nameIndex, 'imp-2')
    expect(once.records.map((r) => r.id).sort()).toEqual(twice.records.map((r) => r.id).sort())
  })
})

describe('parseCsv', () => {
  it('支持引号内逗号与换行', () => {
    const table = parseCsv('名称,消耗\n"海报, 大图",12.5\n"多\n行",3')
    expect(table.headers).toEqual(['名称', '消耗'])
    expect(table.rows[0][0]).toBe('海报, 大图')
    expect(table.rows[1][0]).toBe('多\n行')
  })

  it('去掉 BOM，否则首列表头会带不可见字符', () => {
    const table = parseCsv('\uFEFFID,消耗\n1,2')
    expect(table.headers[0]).toBe('ID')
  })
})
