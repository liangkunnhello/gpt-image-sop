/**
 * 素材台账 / 素材报表的「按文件名搜索」。
 *
 * 为什么单独抽一层：文件名分散在三个地方，展示层各写一遍必然不一致。
 * - `TaskRecord.deliveredFileNames`：交付时实际写出的文件名（图片 id → 文件名）
 * - `TaskRecord.deliverFolder`：交付文件夹名，报表里常以「文件夹/文件名」出现
 * - `AssetRecord.reportNames` / `platformIds`：报表里出现过的图片名与平台素材 ID
 *
 * 归一化直接复用报表导入那一套（`normalizeAssetName`：去扩展名、去空格、转小写），
 * 这样「用户输入 xxx.jpg」和「报表里写 xxx」能对上。
 */

import type { TaskRecord } from '../types'
import type { AssetRecord } from './trackDb'
import { normalizeAssetName } from './reportImport'

/** 一张任务卡对应的交付文件信息 */
export interface AssetFileInfo {
  /** 交付文件名（原样，带扩展名） */
  names: string[]
  /** 交付文件夹名 */
  folder: string
}

/**
 * 建立「任务卡 id → 交付文件信息」索引。
 *
 * 只收真的交付过的卡：没交付就没有文件名，按文件名搜不到它们本来就是对的。
 */
export function buildAssetFileIndex(
  tasks: Array<Pick<TaskRecord, 'id' | 'deliveredFileNames' | 'deliverFolder'>>,
): Map<string, AssetFileInfo> {
  const index = new Map<string, AssetFileInfo>()
  for (const task of tasks) {
    const names = Object.values(task.deliveredFileNames ?? {}).filter(Boolean)
    if (!names.length) continue
    index.set(task.id, { names, folder: (task.deliverFolder ?? '').trim() })
  }
  return index
}

/** 搜索关键字归一化：空串表示不筛 */
export function normalizeKeyword(keyword: string): string {
  return normalizeAssetName(keyword ?? '')
}

/**
 * 这条素材是否命中关键字。
 *
 * 命中任一即算：交付文件名、`文件夹/文件名`、报表里出现过的图片名、平台素材 ID、素材 id。
 * 全部用「包含」匹配，即时过滤；关键字为空时一律通过。
 */
export function matchAssetKeyword(
  asset: Pick<AssetRecord, 'id' | 'reportNames' | 'platformIds' | 'taskId'>,
  info: AssetFileInfo | undefined,
  keyword: string,
): boolean {
  const text = normalizeKeyword(keyword)
  if (!text) return true

  if (info) {
    for (const name of info.names) {
      if (normalizeAssetName(name).includes(text)) return true
      if (info.folder && normalizeAssetName(`${info.folder}/${name}`).includes(text)) return true
    }
  }
  for (const name of asset.reportNames ?? []) {
    if (normalizeAssetName(name).includes(text)) return true
  }
  for (const platformId of asset.platformIds ?? []) {
    if (platformId.toLowerCase().includes(text)) return true
  }
  return asset.id.toLowerCase().includes(text)
}

/**
 * 报表行用的命中判断。
 *
 * 报表行可能没有 `assetId`（未挂接本地图的平台素材），这时只能按行里的平台 ID 兜底；
 * 有 `assetId` 的走上面的同一套规则，保证台账和报表口径一致。
 */
export function matchReportRowKeyword(
  row: { assetId?: string; key: string },
  asset: Pick<AssetRecord, 'id' | 'reportNames' | 'platformIds' | 'taskId'> | undefined,
  info: AssetFileInfo | undefined,
  keyword: string,
): boolean {
  const text = normalizeKeyword(keyword)
  if (!text) return true
  if (asset && matchAssetKeyword(asset, info, keyword)) return true
  // 未匹配行：key 是 `pid:平台素材ID`
  const platformId = row.key.startsWith('pid:') ? row.key.slice(4) : row.key
  return platformId.toLowerCase().includes(text)
}
