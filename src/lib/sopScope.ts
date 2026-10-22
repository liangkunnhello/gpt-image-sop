import type { SopDirectionNode } from '../types'

type TreeNode = Pick<SopDirectionNode, 'id' | 'parentId'>

/**
 * 自身 → 父 → 祖父 → 根 的 id 链。
 *
 * 提示词库、卖点、风格都是「按产品存」的，但用户经常先把配置放在产品上、
 * 之后再往下建方向。方向要为空的配置取到产品那份，就得沿这条链往上找。
 * 脏数据里父子成环时在环处截断，不会死循环。
 */
export function scopeChain(nodes: TreeNode[], nodeId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const chain: string[] = []
  const seen = new Set<string>()
  let cursor = byId.get(nodeId)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.push(cursor.id)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain.length ? chain : [nodeId]
}

/**
 * 这个节点「配置该存在哪一层」：叶子归到父级（方向归到产品），容器留给自己。
 *
 * 只看层级深度会把「产品 → 方向」这种两层的树误判成「类目 → 产品」
 * （用户不一定建满三层），所以这里用「有没有子节点」判断：
 * - 有子节点 → 它本身就是共享层（产品 / 类目），配置存自己
 * - 没子节点且有父级 → 叶子（方向），配置归到父产品，兄弟方向才能共用
 */
export function nearestScopeId(nodes: TreeNode[], nodeId: string): string {
  if (nodes.some((node) => node.parentId === nodeId)) return nodeId
  return scopeChain(nodes, nodeId)[1] ?? nodeId
}

/**
 * 展示 / 新增配置时用的作用域：就近找第一个已经有内容的层，都没有才用最近的存储层。
 *
 * 例：产品下配了 3 条系统提示词，新建的方向打开提示词库时应该看到这 3 条
 * （并继续往里加），而不是看到空列表然后以为是「未设置」。
 */
export function scopeWithItems(
  nodes: TreeNode[],
  nodeId: string,
  has: (scopeId: string) => boolean,
): string {
  return scopeChain(nodes, nodeId).find(has) ?? nearestScopeId(nodes, nodeId)
}
