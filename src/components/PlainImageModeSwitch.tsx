import { useStore } from '../store'

/**
 * 普通模式的发图方式切换。
 * 批量 = 每张变量图各发一次请求；融图 = 一次请求带上整组图。
 */
export default function PlainImageModeSwitch() {
  const mode = useStore((s) => s.plainImageMode)
  const setMode = useStore((s) => s.setPlainImageMode)

  const chip = (value: 'batch' | 'merge', label: string, title: string) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      title={title}
      className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
        mode === value
          ? 'bg-blue-500 font-medium text-white'
          : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/[0.08]'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-gray-200 bg-white/70 px-1.5 py-1 dark:border-white/10 dark:bg-white/[0.04]">
      <span className="mr-0.5 text-gray-400 dark:text-gray-500">模式</span>
      {chip(
        'batch',
        '批量',
        '每个请求只带 1 张变量图，数量不够时循环使用参考图；固定图不参与',
      )}
      {chip(
        'merge',
        '融图',
        '数量 1 时所有图放一个请求；数量 N 时把变量图平均分成 N 组，每组再带上全部固定图',
      )}
    </div>
  )
}
