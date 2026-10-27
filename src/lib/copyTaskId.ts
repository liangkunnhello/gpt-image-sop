import { copyTextToClipboard, getClipboardFailureMessage } from './clipboard'
import { taskIdCopyText } from './taskId'
import { useStore } from '../store'

/**
 * 复制任务 ID 并给出提示。
 *
 * 卡片和详情页都要用，放到这里而不是各自写一遍：
 * 复制失败在客户端和网页端的原因不一样（插件 / 权限 / 内嵌页面），
 * 提示文案必须统一走 getClipboardFailureMessage，不然用户只会看到「复制失败」。
 */
export async function copyTaskIdToClipboard(taskId: string): Promise<boolean> {
  const text = taskIdCopyText(taskId)
  if (!text) return false

  const showToast = useStore.getState().showToast
  try {
    await copyTextToClipboard(text)
    showToast(`已复制任务 ID：${text}`, 'success')
    return true
  } catch (err) {
    showToast(getClipboardFailureMessage('复制任务 ID 失败，请手动选中复制', err), 'error')
    return false
  }
}
