/**
 * 投放报表解析与素材匹配。
 *
 * 支持 xlsx（用已有的 fflate 解 zip，再解析内部 XML）和 csv。
 * 不引入 xlsx 库的理由：报表结构固定（单 sheet、首行表头、无合并单元格），
 * 手写解析够用，也避免为一个格式增加依赖面。
 *
 * **列名不写死**：不同平台的导出列名不一样，报表结构也可能调整，
 * 所以表头只用来「猜一个默认映射」，最终由用户在导入界面上确认。
 */
import { strFromU8, unzipSync } from 'fflate'
import type { AssetRecord, SpendRecord } from './trackDb'
import { spendId } from './trackDb'

/** 一行的原始值，按列顺序 */
export type SheetRow = string[]

export interface SheetTable {
  headers: string[]
  rows: SheetRow[]
}

/** 列映射：每个业务字段对应报表里的第几列（-1 表示没选） */
export interface ColumnMapping {
  /** 投放日期 */
  date: number
  /** 消耗金额 */
  spend: number
  /** 平台素材 ID */
  platformId: number
  /** 素材标识（用于匹配本地素材，通常是「图片名称」） */
  assetKey: number
  /** 媒体渠道 */
  media: number
  /** 产品名称 */
  productName: number
  /** 设计 */
  designer: number
  /** 优化师 */
  optimizer: number
  /** 是否异常 */
  abnormal: number
  /** 预览地址（可选，用于兜底匹配与人工看图确认） */
  previewUrl: number
}

const EMPTY_MAPPING: ColumnMapping = {
  date: -1, spend: -1, platformId: -1, assetKey: -1,
  media: -1, productName: -1, designer: -1, optimizer: -1, abnormal: -1, previewUrl: -1,
}

/** 表头关键词 → 业务字段。顺序有讲究：先匹配更具体的词，避免「日期」被「上传时间」抢走 */
const HEADER_HINTS: Array<[keyof ColumnMapping, string[]]> = [
  ['assetKey', ['图片名称', '素材名称', '创意名称', '文件名称']],
  // 「=id」表示精确等于：平台导出的素材 ID 列常常就叫 ID，
  // 用包含匹配会先撞上「产品ID」「数据平台ID」这类列，拿错列整批都入不了库
  ['platformId', ['=id', '素材id', '素材编号', '创意id', '图片id']],
  ['date', ['日期', '投放日期', '统计日期', '数据日期']],
  ['spend', ['消耗', '花费', '消费']],
  ['productName', ['产品名称', '产品']],
  ['designer', ['设计', '设计师']],
  ['optimizer', ['优化师', '优化']],
  ['abnormal', ['异常']],
  ['previewUrl', ['预览地址', '预览链接', '素材链接', '图片链接']],
  ['media', ['媒体', '渠道']],
]

function decodeXml(text: string) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

/** A1 → 列索引（0 基）。只取字母部分 */
function columnIndex(ref: string) {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0]
  if (!letters) return -1
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 共享字符串表：每个 <si> 里的所有 <t> 拼起来（富文本会被拆成多段） */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match: RegExpExecArray | null
  while ((match = siRe.exec(xml))) {
    const parts: string[] = []
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let t: RegExpExecArray | null
    while ((t = tRe.exec(match[1]))) parts.push(decodeXml(t[1]))
    // 只有 <t/> 自闭合的空串也要占一个位置，否则后面索引全错位
    out.push(parts.join(''))
  }
  return out
}

/** 解析 sheet XML 成二维数组，缺失的单元格补空串，保证列位对齐 */
export function parseSheetXml(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(xml))) {
    const cells: string[] = []
    /**
     * 必须用非贪婪的 `[^>]*?` 且把 `\/>` 放在 `>` 前面分支。
     * 原来的写法 `([^>]*)(?:\/>|>...)` 里 `[^>]*` 是贪婪的，
     * 遇到自闭合的空单元格 `<c r="I5" t="inlineStr" />` 时会把 ` /` 一起吃掉，
     * 于是走了 `>` 分支、一路匹配到**下一个** `</c>`，把紧跟其后的那个单元格整个吞掉。
     * 真实报表里 3889 行有空单元格，结果紧邻的「消耗」全被吞成 0，
     * 合计从 396474.89 掉到 205211.81 —— 这种错只有拿真实数据跑才看得出来。
     */
    const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] ?? ''
      // group 2 是 `/>` 或 `>...`，group 3 才是单元格内容（自闭合时为空）
      const body = cellMatch[3] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? ''
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? ''
      const index = ref ? columnIndex(ref) : cells.length
      if (index < 0) continue

      let value = ''
      if (type === 's') {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
        value = shared[Number(raw)] ?? ''
      } else if (type === 'inlineStr') {
        value = decodeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? '')
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      }
      while (cells.length < index) cells.push('')
      cells[index] = value.trim()
    }
    // 整行空就跳过（xlsx 常在末尾留空行）
    if (cells.some((cell) => cell !== '')) rows.push(cells)
  }
  return rows
}

/** 读 xlsx：走 zip → 共享字符串 + 第一张 sheet */
export function parseXlsx(buffer: ArrayBuffer): SheetTable {
  const files = unzipSync(new Uint8Array(buffer))
  const read = (name: string) => (files[name] ? strFromU8(files[name]) : '')
  const sharedXml = read('xl/sharedStrings.xml')
  const shared = sharedXml ? parseSharedStrings(sharedXml) : []
  // 用 workbook.xml 的顺序找第一张表；找不到就退回 sheet1.xml
  const sheetEntry = Object.keys(files).find((name) => /^xl\/worksheets\/sheet1\.xml$/.test(name))
  if (!sheetEntry) throw new Error('这个文件里没有找到工作表，可能不是 xlsx')
  const rows = parseSheetXml(strFromU8(files[sheetEntry]), shared)
  if (!rows.length) throw new Error('工作表是空的')
  const [headers, ...body] = rows
  return { headers, rows: body }
}

/** 极简 CSV 解析：支持双引号包裹、引号内换行与逗号 */
export function parseCsv(text: string): SheetTable {
  const rows: SheetRow[] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const body = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { cell += '"'; i += 1 }
        else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(cell.trim()); cell = ''; continue }
    if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; continue }
    if (ch === '\r') continue
    cell += ch
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row) }
  const cleaned = rows.filter((item) => item.some((v) => v !== ''))
  if (!cleaned.length) throw new Error('文件是空的')
  const [headers, ...rest] = cleaned
  return { headers, rows: rest }
}

/** 按表头猜一个默认映射，用户可以在导入界面上改 */
export function detectMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = { ...EMPTY_MAPPING }
  const normalized = headers.map((h) => h.replace(/\s+/g, '').toLowerCase())
  const used = new Set<number>()
  for (const [field, hints] of HEADER_HINTS) {
    for (const hint of hints) {
      const exact = hint.startsWith('=')
      const needle = (exact ? hint.slice(1) : hint).toLowerCase()
      const index = normalized.findIndex((h, i) => {
        if (used.has(i)) return false
        return exact ? h === needle : h.includes(needle)
      })
      if (index >= 0) {
        mapping[field] = index
        used.add(index)
        break
      }
    }
  }
  return mapping
}

/** 文件名归一化：去扩展名、去首尾空白、统一小写。报表里通常不带扩展名 */
export function normalizeAssetName(value: string) {
  return value
    .trim()
    .replace(/\.(png|jpe?g|webp)$/i, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 建立「命名 → 图片哈希」索引，用于第 1 级匹配。
 *
 * 数据来源是任务卡的 `deliveredFileNames`（交付时实际写出的文件名，含扩展名）
 * 和 `deliverFolder`（卡文件夹名）。报表里的「图片名称」就是这两者的组合，
 * 所以两种形态都收进索引：
 * - 单独文件名
 * - 文件夹名 + 文件名
 */
export function buildNameIndex(
  tasks: Array<{
    deliveredFileNames?: Record<string, string>
    deliverFolder?: string
  }>,
): Map<string, string> {
  const index = new Map<string, string>()
  for (const task of tasks) {
    const names = task.deliveredFileNames
    if (!names) continue
    const folder = (task.deliverFolder ?? '').trim()
    for (const [imageId, fileName] of Object.entries(names)) {
      if (!fileName) continue
      const plain = normalizeAssetName(fileName)
      if (plain && !index.has(plain)) index.set(plain, imageId)
      const withFolder = normalizeAssetName(`${folder}/${fileName}`)
      if (folder && withFolder && !index.has(withFolder)) index.set(withFolder, imageId)
    }
  }
  return index
}

/** 字符串取数字，容忍千分位逗号、货币符号、空值 */
export function toNumber(value: string): number {
  const cleaned = (value ?? '').replace(/[,\s¥$€]/g, '')
  if (!cleaned) return 0
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : 0
}

/** 日期归一成 YYYY-MM-DD。识别 2026-11-03 / 2026/11/3 / 20261103 / Excel 序列号 */
export function normalizeDate(value: string): string {
  const text = (value ?? '').trim()
  if (!text) return ''
  const dashed = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text)
  if (dashed) {
    const [, y, m, d] = dashed
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  // Excel 的日期序列号（1900 起算，含著名的 1900 闰年 bug）
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text)
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400 * 1000)
      const date = new Date(ms)
      const y = date.getUTCFullYear()
      const m = String(date.getUTCMonth() + 1).padStart(2, '0')
      const d = String(date.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
  }
  return ''
}

export interface ImportPreview {
  /** 解析出来、可以入库的流水 */
  records: SpendRecord[]
  /** 匹配上本地素材的行数 */
  matchedCount: number
  /** 匹配不上的行数（进待认领） */
  unmatchedCount: number
  /** 报表消耗合计，用于和平台对账 */
  totalSpend: number
  /** 被跳过的问题行说明（日期缺失、消耗非数字等） */
  skipped: Array<{ row: number; reason: string }>
  /** 匹配不上时用于人工认领的候选：平台ID → 报表里的图片名称 */
  unmatchedSamples: Array<{ platformId: string; assetName: string; date: string; spend: number }>
}

/**
 * 把报表行转成可入库的消耗流水。
 *
 * 幂等：主键是「平台素材ID + 日期」，同一天重复导入会覆盖而不是叠加 ——
 * 平台常会把当天数据反复修正，用户也会重复导同一份文件。
 */
export function buildSpendRecords(
  table: SheetTable,
  mapping: ColumnMapping,
  nameIndex: Map<string, string>,
  importId: string,
): ImportPreview {
  const records: SpendRecord[] = []
  const skipped: Array<{ row: number; reason: string }> = []
  const unmatchedSamples: ImportPreview['unmatchedSamples'] = []
  let matchedCount = 0
  let unmatchedCount = 0
  let totalSpend = 0
  // 同一份报表里同一素材同一天可能出现多行（不同计划/广告位），消耗要合并
  const merged = new Map<string, SpendRecord>()

  table.rows.forEach((row, offset) => {
    const lineNo = offset + 2 // 表头占第 1 行
    const cell = (index: number) => (index >= 0 ? (row[index] ?? '') : '')
    const date = normalizeDate(cell(mapping.date))
    const platformId = cell(mapping.platformId).trim()
    const assetName = cell(mapping.assetKey).trim()
    const spend = toNumber(cell(mapping.spend))

    if (!date) {
      skipped.push({ row: lineNo, reason: '投放日期读不出来，已跳过' })
      return
    }
    // 没有平台 ID 时用素材名兜底，否则同一天多行会互相覆盖
    const key = platformId || `name:${assetName}`
    if (!key || key === 'name:') {
      skipped.push({ row: lineNo, reason: '既没有平台素材ID也没有图片名称，已跳过' })
      return
    }
    totalSpend += spend

    const id = spendId(key, date)
    const existing = merged.get(id)
    if (existing) {
      existing.spend += spend
      return
    }
    const assetId = assetName ? nameIndex.get(normalizeAssetName(assetName)) : undefined
    if (assetId) matchedCount += 1
    else {
      unmatchedCount += 1
      if (assetName && unmatchedSamples.length < 200) {
        unmatchedSamples.push({ platformId: key, assetName, date, spend })
      }
    }
    merged.set(id, {
      id,
      platformId: key,
      assetId,
      date,
      spend,
      media: cell(mapping.media) || undefined,
      productName: cell(mapping.productName) || undefined,
      designer: cell(mapping.designer) || undefined,
      optimizer: cell(mapping.optimizer) || undefined,
      abnormal: cell(mapping.abnormal) === '1' || cell(mapping.abnormal) === '是' ? true : undefined,
      previewUrl: cell(mapping.previewUrl) || undefined,
      importId,
    })
  })

  records.push(...merged.values())
  return {
    records,
    matchedCount,
    unmatchedCount,
    totalSpend: Math.round(totalSpend * 100) / 100,
    skipped,
    unmatchedSamples,
  }
}

/** 把导入结果回填到素材台账：记录平台 ID、报表名称、首次出现时间、最后消耗日 */
export function applyToAssets(
  assets: AssetRecord[],
  records: SpendRecord[],
): AssetRecord[] {
  const byId = new Map(assets.map((item) => [item.id, { ...item }]))
  const touched = new Map<string, AssetRecord>()

  for (const record of records) {
    if (!record.assetId) continue
    const asset = touched.get(record.assetId) ?? byId.get(record.assetId)
    // 台账里还没有这个素材（例如图片被删了但报表仍在跑）：跳过，不凭空造记录
    if (!asset) continue

    if (!asset.platformIds.includes(record.platformId)) {
      asset.platformIds = [...asset.platformIds, record.platformId]
    }
    if (!asset.lastSpendDate || record.date > asset.lastSpendDate) {
      asset.lastSpendDate = record.date
    }
    touched.set(asset.id, asset)
  }

  return [...touched.values()]
}
