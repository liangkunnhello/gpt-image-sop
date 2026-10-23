import { useState } from 'react'
import type { SopDirectionNode } from '../types'
import { directionPath, useSopStore } from '../lib/sopStore'
import { isTauri } from '../lib/platform'
import { pickDirectoryPath, openDirectoryPath } from '../lib/deliveryDirPicker'
import { hasOwnDeliveryDir } from '../lib/deliveryDir'
import { useStore } from '../store'

interface Props {
  /** 要配置的节点：业务线 / 产品 / 方向 三级都可配 */
  node: SopDirectionNode
  onClose: () => void
}

const KIND_LABEL: Record<SopDirectionNode['kind'], string> = {
  category: '业务线',
  product: '产品',
  direction: '方向',
}

/**
 * 配置交付地址。
 *
 * 继承规则（与用户要求逐字对齐）：下层级配了只用专属的，没配才向上复用；
 * 三层都没配则回退到默认保存地址。所以这里同时展示「继承自哪一层」，
 * 避免用户以为没配就没有、重复在每层都填一遍。
 */
export default function DeliveryDirModal({ node, onClose }: Props) {
  const directions = useSopStore((s) => s.directions)
  const deliveryDirs = useSopStore((s) => s.deliveryDirs)
  const setDeliveryDir = useSopStore((s) => s.setDeliveryDir)
  const showToast = useStore((s) => s.showToast)

  const [value, setValue] = useState(deliveryDirs[node.id] ?? '')
  const [picking, setPicking] = useState(false)

  const own = hasOwnDeliveryDir(deliveryDirs, node.id)
  /** 父级链上第一个配过的层（不含自己），用于提示「继承自」 */
  const inherited = (() => {
    let cursor = directions.find((item) => item.id === node.parentId)
    while (cursor) {
      const path = deliveryDirs[cursor.id]?.trim()
      if (path) return { node: cursor, path }
      cursor = directions.find((item) => item.id === cursor?.parentId)
    }
    return null
  })()

  const handlePick = async () => {
    if (!isTauri) return
    setPicking(true)
    try {
      const picked = await pickDirectoryPath()
      if (picked) setValue(picked)
    } catch (err) {
      showToast(typeof err === 'string' ? err : '选择目录失败', 'error')
    } finally {
      setPicking(false)
    }
  }

  const handleOpen = async () => {
    const target = value.trim() || inherited?.path
    if (!target) return
    try {
      await openDirectoryPath(target)
    } catch (err) {
      showToast(typeof err === 'string' ? err : '打开目录失败', 'error')
    }
  }

  const submit = () => {
    setDeliveryDir(node.id, value)
    showToast(value.trim() ? '已保存交付地址' : '已清除交付地址，将向上级复用', 'success')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">交付地址</h2>
          <span className="truncate rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-white/10 dark:text-gray-400">
            {KIND_LABEL[node.kind]}：{node.name}
          </span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.06]">
            取消
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          <div>
            <div className="mb-1 text-sm text-gray-600 dark:text-gray-300">出图后自动把成品图复制到这里</div>
            <div className="flex gap-2">
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={inherited ? `留空则继承：${inherited.path}` : '例如 D:\\交付\\百万医疗险'}
                spellCheck={false}
                disabled={!isTauri}
                className="w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 font-mono text-xs text-gray-700 outline-none transition-all hover:bg-black/[0.07] focus:border-blue-400 focus:bg-white disabled:opacity-60 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1] dark:focus:bg-white/[0.09]"
              />
              {isTauri && (
                <button
                  type="button"
                  onClick={() => void handlePick()}
                  disabled={picking}
                  className="shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] disabled:opacity-50 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                >
                  {picking ? '选择中…' : '选择…'}
                </button>
              )}
              {(value.trim() || inherited) && (
                <button
                  type="button"
                  onClick={() => void handleOpen()}
                  className="shrink-0 rounded-xl border border-transparent bg-black/[0.04] px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                >
                  打开
                </button>
              )}
            </div>
          </div>

          <div className="rounded-xl bg-black/[0.03] px-3 py-2.5 text-[11px] leading-relaxed text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
            继承规则：下层级配了就只用它，没配才向上级复用（方向 → 产品 → 业务线）。
            {own
              ? '当前这一层已配置专属地址，下面的方向不会再沿用上层的。'
              : inherited
                ? `当前没配，会继承「${KIND_LABEL[inherited.node.kind]}：${inherited.node.name}」的地址。`
                : '当前三级都没配，会自动交付到设置里的「默认保存地址」。'}
            <div className="mt-1">交付是复制一份，应用里的原图始终保留；进回收站的图片不交付。</div>
          </div>

          <div data-selectable-text className="break-all text-[11px] text-gray-400">
            路径：{node.id ? directionPath(directions, node.id) : node.name}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={() => setValue('')}
            className="rounded-lg px-2 py-1 text-[11px] text-gray-500 transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.06]"
          >
            清空（改回继承）
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-600"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
