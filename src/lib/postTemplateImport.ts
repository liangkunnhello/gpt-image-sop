/**
 * 从别的产品 / 方向导入后处理模板。
 *
 * 模板按节点 id 分键存在 `postTemplates` 里，所以「导入」就是把源节点的模板
 * 复制一份挂到目标节点上，并换掉 id —— id 相同会让 React 列表 key 撞车，
 * 也会让「删掉自己这套」误删到源节点那套的引用。
 *
 * logo 元素的图是 dataURL（存在 element.text 里），跟着模板一起复制即可，不用重新上传。
 */

export interface PostTemplateSource {
  /** 源节点 id（产品或方向） */
  id: string
  /** 源节点显示名 */
  name: string
  /** 所属层级，用来在导入面板里分组 */
  kind: 'product' | 'direction'
  /** 它的父级名字（方向才有），用于展示「产品 / 方向」 */
  parentName?: string
}

export interface PostTemplateSourceGroup {
  /** 业务线名，用来分组显示 */
  categoryName: string
  /** 该业务线下有模板的产品与方向 */
  sources: PostTemplateSource[]
}

/**
 * 列出可以作为导入来源的节点。
 *
 * 只收「自己配了模板」的节点 —— 列出空节点让用户点进去看到一片空白没有意义。
 * 排除目标节点自己（导自己的没有意义）。
 * 按业务线分组、产品排在它自己的方向前面，跟左侧树的结构一致。
 */
export function collectPostTemplateSources(
  templates: Record<string, unknown[] | undefined>,
  directions: Array<{ id: string; name: string; parentId: string | null }>,
  options: { excludeId?: string } = {},
): PostTemplateSourceGroup[] {
  const byId = new Map(directions.map((node) => [node.id, node]))

  /** 往上找到顶层业务线的名字，找不到就算未分类 */
  const categoryNameOf = (nodeId: string): string => {
    const seen = new Set<string>([nodeId])
    let cursor = byId.get(nodeId)
    while (cursor?.parentId && !seen.has(cursor.parentId)) {
      seen.add(cursor.parentId)
      const parent = byId.get(cursor.parentId)
      if (!parent) break
      if (!parent.parentId) return parent.name
      cursor = parent
    }
    return '未分类'
  }

  /** 节点层级：顶层 = 业务线，次层 = 产品，更深 = 方向 */
  const depthOf = (nodeId: string): number => {
    const seen = new Set<string>([nodeId])
    let depth = 0
    let cursor = byId.get(nodeId)
    while (cursor?.parentId && !seen.has(cursor.parentId)) {
      seen.add(cursor.parentId)
      cursor = byId.get(cursor.parentId)
      depth += 1
    }
    return depth
  }

  const groups = new Map<string, PostTemplateSourceGroup>()
  for (const [ownerId, list] of Object.entries(templates)) {
    if (!list?.length) continue
    if (ownerId === options.excludeId) continue
    const node = byId.get(ownerId)
    // 节点已被删除的模板不要出现在来源里，否则导入后挂在一个查不到的名字上
    if (!node) continue
    const depth = depthOf(ownerId)
    if (depth === 0) continue
    const categoryName = categoryNameOf(ownerId)
    const group = groups.get(categoryName) ?? { categoryName, sources: [] }
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    group.sources.push({
      id: ownerId,
      name: node.name,
      kind: depth === 1 ? 'product' : 'direction',
      parentName: depth > 1 ? parent?.name : undefined,
    })
    groups.set(categoryName, group)
  }

  // 产品排在自己的方向前面，组内按名字稳定排序
  for (const group of groups.values()) {
    group.sources.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'product' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  }
  return [...groups.values()].sort((a, b) => a.categoryName.localeCompare(b.categoryName, 'zh-Hans-CN'))
}

/**
 * 把选中的模板复制到目标节点，返回新的模板列表。
 *
 * - id 全部换新，避免与目标节点已有的模板撞 key
 * - 同渠道 + 同比例下已经有默认模板时，导入进来的不再抢「默认」，
 *   否则导一次就把用户原本设的默认顶掉了
 * - 原样保留 enabled / channel / 元素（含 logo 的 dataURL）
 */
export function importPostTemplates<T extends { id: string; width: number; height: number; channel?: string; isDefault: boolean }>(
  existing: T[],
  picked: T[],
  newId: (source: T, index: number) => string,
): T[] {
  if (!picked.length) return existing
  const out = [...existing]
  picked.forEach((template, index) => {
    const sameScopeDefault = out.some((item) => (
      item.isDefault
      && (item.channel ?? '') === (template.channel ?? '')
      && item.height > 0 && template.height > 0
      && Math.abs(item.width / item.height - template.width / template.height) < 0.02
    ))
    out.push({
      ...template,
      id: newId(template, index),
      isDefault: sameScopeDefault ? false : template.isDefault,
    })
  })
  return out
}
