/**
 * 变量模式图生图的三分区图片入口。
 *
 * 参考图、固定图、变量图三者在生成里的角色完全不同，混在一个「参考图」区里
 * 用户没法表达「这几张每次都带、那几张换着用」。这里给三个独立入口：
 * 每个区各自能拖入、粘贴、点选，互相不串。
 */
import { useState } from 'react'
import { useStore, addImagesFromFiles } from '../../store'
import type { InputImage } from '../../types'
import InputThumbImage from './inputThumbImage'

type Slot = 'reference' | 'fixed' | 'variable'

interface SlotConfig {
  key: Slot
  title: string
  hint: string
  accent: string
  badge: string
}

/** 参考图的说明按模式切换，其余两池的语义两个模式完全一致 */
function slotsFor(mode: 'variable' | 'sop'): SlotConfig[] {
  return SLOTS.map((slot) => (
    slot.key === 'reference'
      ? {
        ...slot,
        hint: mode === 'sop'
          ? '只用来反推 SOP，不进生图接口；用存档 SOP 时请把图放进固定图区'
          : slot.hint,
      }
      : slot
  ))
}

const SLOTS: SlotConfig[] = [
  {
    key: 'reference',
    title: '参考图',
    hint: '只用来分析和提取策略，不进生图接口',
    accent: 'blue',
    badge: '分析',
  },
  {
    key: 'fixed',
    title: '固定图',
    hint: '每条提示词都带同一组',
    accent: 'emerald',
    badge: '每次都带',
  },
  {
    key: 'variable',
    title: '变量图',
    hint: '每条提示词轮换取一张',
    accent: 'amber',
    badge: '逐条更换',
  },
]

const ACCENT: Record<string, { ring: string; text: string; chip: string; dashed: string; solid: string }> = {
  blue: {
    ring: 'border-blue-300 dark:border-blue-500/40',
    text: 'text-blue-600 dark:text-blue-300',
    chip: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
    dashed: 'border-blue-300/70 dark:border-blue-500/30',
    solid: 'bg-blue-500',
  },
  emerald: {
    ring: 'border-emerald-300 dark:border-emerald-500/40',
    text: 'text-emerald-600 dark:text-emerald-300',
    chip: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    dashed: 'border-emerald-300/70 dark:border-emerald-500/30',
    solid: 'bg-emerald-500',
  },
  amber: {
    ring: 'border-amber-300 dark:border-amber-500/40',
    text: 'text-amber-600 dark:text-amber-300',
    chip: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    dashed: 'border-amber-300/70 dark:border-amber-500/30',
    solid: 'bg-amber-500',
  },
}

interface Props {
  /** 参考图上限（SOP / 变量模式下是 60） */
  referenceLimit: number
  /** 单次请求最多能带几张图：只有「固定图」受它约束，变量图每条只取一张、不占名额 */
  requestLimit: number
  /**
   * 当前模式。两个模式的三池结构一样，但参考图的用途不同：
   * - variable：参考图只用来提取变量策略
   * - sop：参考图只用来反推 SOP，用存档 SOP 时完全不参与
   * 不改文案的话，SOP 下会写着「提取策略」，看着像走错了模式。
   */
  mode?: 'variable' | 'sop'
}

/** 三个图片池的统一读写：都是 InputImage[]，只是存的位置不同 */
function useSlotImages(slot: Slot) {
  const inputImages = useStore((s) => s.inputImages)
  const fixedImages = useStore((s) => s.fixedImages)
  const variableImages = useStore((s) => s.variableImages)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const removeFixedImage = useStore((s) => s.removeFixedImage)
  const removeVariableImage = useStore((s) => s.removeVariableImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const clearFixedImages = useStore((s) => s.clearFixedImages)
  const clearVariableImages = useStore((s) => s.clearVariableImages)

  const images = slot === 'reference' ? inputImages : slot === 'fixed' ? fixedImages : variableImages
  const remove = slot === 'reference' ? removeInputImage : slot === 'fixed' ? removeFixedImage : removeVariableImage
  const clear = slot === 'reference' ? clearInputImages : slot === 'fixed' ? clearFixedImages : clearVariableImages
  return { images, remove, clear }
}

/**
 * 缩略图：点开大图（走全局 Lightbox）、可删。
 *
 * 三个池的图都会进生图接口或参与反推，光看 40×40 的分不清哪张是哪张 ——
 * 点一下就放大是最好用的确认方式，和普通模式的参考图保持一致。
 * 删按钮要 stopPropagation，否则点「×」会顺手把大图也打开。
 */
function SlotThumbs({ images, onRemove }: { images: InputImage[]; onRemove: (idx: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {images.map((img, idx) => (
        <div
          key={img.id}
          role="button"
          tabIndex={0}
          title="查看大图"
          onClick={() => useStore.getState().setLightboxImageId(img.id, images.map((item) => item.id))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            useStore.getState().setLightboxImageId(img.id, images.map((item) => item.id))
          }}
          className="group relative h-10 w-10 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:border-white/10"
        >
          <InputThumbImage
            imageId={img.id}
            fallbackSrc={img.dataUrl}
            alt={`${idx + 1}`}
            className="pointer-events-none h-full w-full object-cover transition-opacity group-hover:opacity-80"
          />
          {/* 悬停时给个「眼睛」，不然没人知道这张能点开 */}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
            <svg className="h-4 w-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.25 12s3.5-6 9.75-6 9.75 6 9.75 6-3.5 6-9.75 6S2.25 12 2.25 12z" />
              <circle cx="12" cy="12" r="2.75" strokeWidth={2} />
            </svg>
          </span>
          <span className="pointer-events-none absolute bottom-0 left-0 rounded-tr bg-black/55 px-1 text-[9px] leading-tight text-white">
            {idx + 1}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(idx)
            }}
            title="移除"
            className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-[10px] leading-none text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export default function VariableImageSlots({ referenceLimit, requestLimit, mode = 'variable' }: Props) {
  const slots = slotsFor(mode)
  // dragOverSlot 只用来做高亮：真正落图时由每个区的 drop 处理
  const [dragOverSlot, setDragOverSlot] = useState<Slot | null>(null)
  const [uploading, setUploading] = useState<Slot | null>(null)

  const reference = useSlotImages('reference')
  const fixed = useSlotImages('fixed')
  const variable = useSlotImages('variable')
  const bySlot: Record<Slot, ReturnType<typeof useSlotImages>> = {
    reference,
    fixed,
    variable,
  }

  const slotLimit = (slot: Slot) => {
    if (slot === 'reference') return referenceLimit
    // 固定图每一条都要塞进同一个请求，所以受接口张数上限约束
    if (slot === 'fixed') return requestLimit
    // 变量图每条只取一张、不和固定图挤进同一个请求，池子大小与接口上限无关。
    // 这里按 16 张卡它，会让「几百张场景图轮流用」这种用法直接做不了。
    return Number.POSITIVE_INFINITY
  }

  const dropFiles = async (slot: Slot, files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : []
    if (!list.length) return
    setUploading(slot)
    try {
      const { added, overflow, failed, discarded } = await addImagesFromFiles(list, {
        target: slot === 'reference' ? 'input' : slot,
        limit: slotLimit(slot),
      })
      const notes: string[] = [`已加入 ${added} 张`]
      if (overflow > 0) notes.push(`${overflow} 张超过该区上限`)
      if (discarded > 0) notes.push(`${discarded} 张不是图片`)
      if (failed > 0) notes.push(`${failed} 张读取失败`)
      useStore.getState().showToast(notes.join('，'), added > 0 ? 'success' : 'info')
    } catch (err) {
      useStore.getState().showToast(`添加失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setUploading(null)
    }
  }

  const renderSlot = (config: SlotConfig) => {
    const { images, clear } = bySlot[config.key]
    const accent = ACCENT[config.accent]!
    const limit = slotLimit(config.key)
    const isOver = dragOverSlot === config.key
    // 参考图不限张数：显示「已选 N 张」而不是「N / Infinity」
    const total = limit === Number.POSITIVE_INFINITY
      ? `${images.length} 张`
      : `${images.length} / ${limit}`

    return (
      <div
        key={config.key}
        onDragEnter={(e) => {
          if (!e.dataTransfer?.types.includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          setDragOverSlot(config.key)
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
          setDragOverSlot(config.key)
        }}
        onDragLeave={(e) => {
          e.stopPropagation()
          setDragOverSlot((prev) => (prev === config.key ? null : prev))
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOverSlot(null)
          void dropFiles(config.key, e.dataTransfer?.files ?? null)
        }}
        className={`flex min-h-[104px] flex-col rounded-xl border-2 border-dashed p-2 transition-colors ${
          isOver
            ? `${accent.ring} bg-white dark:bg-white/[0.06]`
            : 'border-gray-200 dark:border-white/[0.1]'
        }`}
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${accent.chip}`}>{config.badge}</span>
          <span className={`text-xs font-semibold ${accent.text}`}>{config.title}</span>
          <span className="ml-auto text-[10px] tabular-nums text-gray-400">{total}</span>
        </div>

        {images.length > 0 && (
          <div className="mb-1.5">
            <SlotThumbs images={images} onRemove={bySlot[config.key].remove} />
          </div>
        )}

        <div className="mt-auto flex items-center gap-1.5">
          <label
            className="flex cursor-pointer items-center gap-1 rounded-md border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-700 dark:border-white/10 dark:text-gray-400 dark:hover:border-white/20"
            title={`添加${config.title}`}
          >
            <span className="leading-none">+</span>
            <span>{uploading === config.key ? '读取中…' : '添加'}</span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files
                e.target.value = ''
                void dropFiles(config.key, files)
              }}
            />
          </label>
          {images.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="text-[10px] text-gray-400 transition-colors hover:text-red-500"
            >
              清空
            </button>
          )}
          <span className="ml-auto text-right text-[10px] leading-tight text-gray-400 dark:text-gray-500">
            {config.hint}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {slots.map(renderSlot)}
    </div>
  )
}
