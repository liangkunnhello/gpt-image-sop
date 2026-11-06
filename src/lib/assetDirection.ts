/**
 * 外部素材（NAS 接进来的）按「分类路径」自动归属方向。
 *
 * 为什么不用 OCR / CLIP 去猜：设计部的采集工具已经用视觉模型把每张图分好类了，
 * 落到 NAS 上的目录结构就是 `业务线/产品/方向/横竖版`（如 `保险/京东保/图标/横版`）。
 * 再去 OCR 图上的字、或跑 CLIP 相似度，等于把已经做过的判断重做一遍，
 * 还多一份模型成本和误判 —— 只有 `未知` / `_待确认` 目录才真的没有信号，
 * 那部分交给人工改归属就行。
 *
 * 这里的匹配是纯函数，只做「路径段 → 树节点」的对照，便于直接测：
 * 树是用户手建的，名字不一定和采集工具的目录名完全一致（`3D插画` vs `3D插画-京东硬广`），
 * 所以要先精确匹配，再退一步做「前綴匹配」，且必须限定在同一个产品下。
 */
import type { SopDirectionNode } from '../types'
import type { AssetRecord } from './trackDb'

/** 归一化节点名/目录名：去空白、统一大小写、全角括号转半角 */
export function normalizeNodeName(name: string): string {
  return (name ?? '')
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase()
}

export interface DirectionMatch {
  directionId: string
  /** 命中的产品名与方向名，界面上用来解释「自动归到哪了」 */
  productName: string
  directionName: string
  /** exact = 目录名与方向名完全一致；prefix = 目录名是「方向名-xxx」 */
  kind: 'exact' | 'prefix'
}

/**
 * 从 NAS 分类路径里找出方向。
 *
 * 路径段里混着业务线、产品、方向、横竖版，节点树里业务线可能压根没有
 * （比如 `卡券`、`APP-拉新` 下的很多产品），所以**只在产品层做锚点**：
 * 先找哪一段是某个产品名，再看它的子方向里有没有对上后面某一段的。
 *
 * @param dirPath 如 ['保险','京东保','图标','横版']
 */
export function matchDirectionByPath(
  dirPath: string[] | undefined,
  directions: SopDirectionNode[],
): DirectionMatch | null {
  const segments = (dirPath ?? []).map(normalizeNodeName).filter(Boolean)
  if (!segments.length) return null
  const alive = directions.filter((node) => !node.deletedAt)
  const products = alive.filter((node) => node.kind === 'product')
  if (!products.length) return null

  const directionsOf = (productId: string) =>
    alive.filter((node) => node.kind === 'direction' && node.parentId === productId)

  // 产品和方向都按「路径里出现的位置」走，这样才能处理
  // 「产品名恰好也是某个方向名」这种撞名（比如两个产品都有「图标」）
  for (let index = 0; index < segments.length; index += 1) {
    const product = products.find((node) => normalizeNodeName(node.name) === segments[index])
    if (!product) continue
    const children = directionsOf(product.id)
    // 先在同一位置之后的段里找精确匹配，再退前缀匹配
    for (const kind of ['exact', 'prefix'] as const) {
      for (let cursor = index + 1; cursor < segments.length; cursor += 1) {
        const segment = segments[cursor]
        const hit = children.find((child) => {
          const name = normalizeNodeName(child.name)
          if (!name) return false
          return kind === 'exact' ? name === segment : segment.startsWith(`${name}-`)
        })
        if (hit) {
          return {
            directionId: hit.id,
            productName: product.name,
            directionName: hit.name,
            kind,
          }
        }
      }
    }
  }
  return null
}

/**
 * 算出「哪些素材应该改归属」。
 *
 * 只动两类：还没归属的、上次自动归属过的。人工改过（`directionSource === 'manual'`）
 * 一律不碰 —— 用户手点的方向比目录名权威，重算不能把他的手动作废。
 *
 * 返回的是要写库的完整记录，调用方原样 `trackPutMany` 即可。
 */
export function planAutoDirections(
  assets: AssetRecord[],
  directions: SopDirectionNode[],
): AssetRecord[] {
  const updates: AssetRecord[] = []
  for (const asset of assets) {
    if (asset.directionSource === 'manual') continue
    if (!asset.dirPath?.length) continue
    const hit = matchDirectionByPath(asset.dirPath, directions)
    if (!hit) continue
    // 已经归对了就不写，避免每次加载都产生一批无意义的更新
    if (asset.directionId === hit.directionId && asset.directionSource === 'auto') continue
    updates.push({ ...asset, directionId: hit.directionId, directionSource: 'auto' })
  }
  return updates
}

/** 采集工具里表示「没判出来」的目录名，不能拿来建节点 */
const SKIP_SEGMENTS = new Set(['未知', '待确认', '_待确认', 'api失败', '横版', '竖版', '方形'])

export interface MissingNodesPlan {
  /** 需要新建的业务线（category） */
  categories: string[]
  /** 需要新建的产品：业务线名 → 产品名 */
  products: Array<{ category: string; name: string }>
  /** 需要新建的方向：产品名 → 方向名 */
  directions: Array<{ category: string; product: string; name: string }>
  /** 有多少素材因为这些缺失而归属不了 */
  assetCount: number
}

/**
 * 找出「按分类路径本该能归属、但树里没有节点」的那些产品 / 方向。
 *
 * 为什么需要：采集工具的分类目录比手建的树细得多（`卡券/QQ阅读-25元/插画`、
 * `APP-拉新/淘宝联盟/购物`）。这些素材的名字能对上报表、消耗也是真的，就是没地方挂。
 * 这里只**算计划**，是否真的建由用户点确认 —— 悄悄往树里塞十几个节点很吓人。
 *
 * 未知 / _待确认 / 横竖版 这些段一律跳过：它们不是分类，建出来只会变成垃圾节点。
 */
export function planMissingNodes(
  assets: Array<{ dirPath?: string[]; directionId?: string; directionSource?: 'auto' | 'manual' }>,
  directions: SopDirectionNode[],
): MissingNodesPlan {
  const alive = directions.filter((node) => !node.deletedAt)
  const byName = (kind: SopDirectionNode['kind'], parentId: string | null) =>
    alive.filter((node) => node.kind === kind && (node.parentId ?? null) === parentId)

  const categories = new Set<string>()
  const products = new Map<string, { category: string; name: string }>()
  const dirs = new Map<string, { category: string; product: string; name: string }>()
  let assetCount = 0

  for (const asset of assets) {
    if (asset.directionSource === 'manual') continue
    if (matchDirectionByPath(asset.dirPath, alive)) continue
    const parts = (asset.dirPath ?? []).map((item) => item.trim()).filter(Boolean)
    if (parts.length < 3) continue
    const [categoryName, productName, directionName] = parts
    if (SKIP_SEGMENTS.has(categoryName.toLowerCase()) || SKIP_SEGMENTS.has(productName.toLowerCase())) continue
    if (SKIP_SEGMENTS.has(directionName.toLowerCase())) continue
    assetCount += 1

    // 业务线：已有就不建（树的业务线可能叫得不一样，按名字精确认）
    const categoryNode = byName('category', null).find((node) => normalizeNodeName(node.name) === normalizeNodeName(categoryName))
    if (!categoryNode) categories.add(categoryName)

    // 产品：同名的产品在任何业务线下存在，就不重复建（避免「百万医疗险」建两遍）
    const productNode = alive.find((node) => (
      node.kind === 'product' && normalizeNodeName(node.name) === normalizeNodeName(productName)
    ))
    if (!productNode) {
      products.set(`${categoryName}/${productName}`, { category: categoryName, name: productName })
    }

    // 方向：产品已存在时，看它下面有没有这个方向；产品要新建的话，方向跟着一起建
    const ownerProductId = productNode?.id
    const hasDirection = ownerProductId
      ? alive.some((node) => (
        node.kind === 'direction'
        && node.parentId === ownerProductId
        && normalizeNodeName(node.name) === normalizeNodeName(directionName)
      ))
      : false
    if (!hasDirection) {
      dirs.set(`${productName}/${directionName}`, { category: categoryName, product: productName, name: directionName })
    }
  }

  return {
    categories: [...categories],
    products: [...products.values()],
    directions: [...dirs.values()],
    assetCount,
  }
}
