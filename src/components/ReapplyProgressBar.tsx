import { usePostReapplyProgress } from '../lib/postProgress'

/**
 * 「再次后处理」的进度条。
 *
 * 单独做成组件只为了隔离重渲染：进度一张一更新，如果放在详情页里，
 * 几百张缩略图会跟着刷新几百次（几百张的卡实测会卡到白屏）。
 * 这里只订阅进度 store，详情页不参与。
 */
export default function ReapplyProgressBar() {
  const progress = usePostReapplyProgress((s) => s.progress)
  if (!progress) return null

  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-[11px] text-amber-600 dark:text-amber-400">
        <span>
          正在用 AI 原图重新后处理
          {progress.total ? `（${progress.done}/${progress.total} 张）` : '…'}
        </span>
        {Boolean(progress.total) && <span className="tabular-nums">{percent}%</span>}
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-amber-100 dark:bg-amber-500/20">
        <div
          className="h-full rounded-full bg-amber-500 transition-all duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
