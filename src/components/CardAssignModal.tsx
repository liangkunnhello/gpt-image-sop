import { assignTasksChannel, assignTasksDirection, useStore } from '../store'
import { useSopStore } from '../lib/sopStore'
import AssignDirectionModal from './AssignDirectionModal'

/**
 * 单张任务卡改归属的弹窗。
 *
 * 逻辑本身复用 AssignDirectionModal（树形选择 + 「不归属」），
 * 这里只负责接 store 状态。放在 App 层是因为归属按钮在任务卡上，
 * 弹窗要盖在整个界面上，不适合塞进卡片内部。
 */
export default function CardAssignModal() {
  const taskIds = useStore((s) => s.assignPickerTaskIds)
  const closeAssignPicker = useStore((s) => s.closeAssignPicker)
  const showToast = useStore((s) => s.showToast)
  const dirtree = useSopStore((s) => s.directions)

  if (!taskIds?.length) return null

  // 弹窗里只列没用被删的节点，否则会把任务指到一个看不见的方向
  const aliveIds = new Set(dirtree.filter((node) => !node.deletedAt).map((node) => node.id))

  return (
    <AssignDirectionModal
      count={taskIds.length}
      onClose={closeAssignPicker}
      onConfirm={(directionId, channel) => {
        if (directionId && !aliveIds.has(directionId)) {
          showToast('这个方向已被删除，请另选一个', 'error')
          return
        }
        closeAssignPicker()
        void assignTasksDirection(taskIds, directionId)
        // undefined = 用户没碰渠道区，不要误清空；null = 明确要清空
        if (channel !== undefined) void assignTasksChannel(taskIds, channel)
      }}
    />
  )
}
