import { UNASSIGNED_FILTER } from './sopStore'

/**
 * 业务树某一行的三种高亮状态。
 *
 * 为什么要把这段单独拎出来：`activeFilterId`（在看哪个节点）和
 * `activeDirectionId`（新生成的图归到哪）是两个概念，渲染时容易混。
 * 之前两者都用蓝色实底，结果点「全部任务」后筛选虽然清空了，
 * 「当前归属」那个方向还是蓝的 —— 用户看到「月亮」仍亮着，以为没取消选中。
 *
 * 现在的分工（视觉上互斥，不会再混）：
 * - selected：正在筛选这一行 → 唯一的蓝色实底
 * - current：当前归属，新图归到这里 → 左侧竖条 + 蓝字，不铺底色
 * - onPath：当前归属的祖先链 → 淡灰底，把路径连起来
 *
 * 「全部任务」「未归属」两个视图不按业务节点筛选，整棵树都不会有实底。
 * 归属信息不会丢，左上角「默认归属」卡片一直显示着。
 */
export interface TreeRowHighlight {
  /** 正在筛选这一行：唯一的蓝色实底 */
  selected: boolean
  /** 当前归属（新图归到这里）：左侧蓝条 + 蓝字，不铺底色 */
  current: boolean
  /** 当前归属的祖先链：淡底 */
  onPath: boolean
}

/** 是否在按某个具体业务节点筛选（「全部任务」「未归属」都算不筛） */
export function isFilteringTreeNode(activeFilterId: string | null): boolean {
  return Boolean(activeFilterId) && activeFilterId !== UNASSIGNED_FILTER
}

export function resolveTreeRowHighlight(input: {
  nodeId: string
  activeFilterId: string | null
  activeDirectionId: string
  /** 当前归属节点及其全部祖先的 id */
  currentPathIds: Set<string>
}): TreeRowHighlight {
  const filteringNode = isFilteringTreeNode(input.activeFilterId)
  const selected = filteringNode && input.activeFilterId === input.nodeId
  return {
    selected,
    // 「全部任务」「未归属」下一律不亮：用户说「选中了全部任务就应该没选方向了」。
    // 按某个节点筛选时，归属行用蓝字 + 竖条标出来（新图会归到这里）；
    // 但那一行自己正在被筛选时，实底已经表达清楚，不叠竖条。
    current: filteringNode && input.nodeId === input.activeDirectionId && !selected,
    // 淡底只给祖先链，不含归属行自己
    onPath: filteringNode
      && !selected
      && input.nodeId !== input.activeDirectionId
      && input.currentPathIds.has(input.nodeId),
  }
}

/**
 * 「全部任务」「未归属」这类非树节点的视图开关。
 *
 * 它们不参与归属高亮（current / onPath 恒为 false），只有选中态。
 */
export function resolveViewToggleHighlight(isSelected: boolean): TreeRowHighlight {
  return { selected: isSelected, current: false, onPath: false }
}
