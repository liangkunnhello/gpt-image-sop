/**
 * 变量模式的图生图：三个图片池。
 *
 * - 参考图：只用于反推 SOP / 提取变量策略，不进生图接口（沿用 inputImages）
 * - 固定图：每条提示词出图时都会带上，一次批量里始终是同一组
 * - 变量图：每条提示词轮换取一张，是「这一张和上一张哪里不一样」的来源
 *
 * 这里只做「哪一条提示词该带哪些图」的规划，读写 store 和调接口的放在别处。
 */

import type { InputImage } from '../types'
import { MAX_INPUT_IMAGES } from '../types'

export type VariableImageSlot = 'reference' | 'fixed' | 'variable'

export interface VariableImageAssignment {
  /** 这条提示词要发给接口的图，顺序是固定图在前、变量图在后 */
  images: InputImage[]
  /** 这条用到的变量图，没有变量图池时为 null */
  variableImage: InputImage | null
}

export interface VariableImagePlan {
  assignments: VariableImageAssignment[]
  /** 下一次接着从哪一张变量图开始，便于多张卡之间接着轮转 */
  nextOffset: number
}

function dedupeById(images: InputImage[]): InputImage[] {
  const seen = new Set<string>()
  const out: InputImage[] = []
  for (const image of images) {
    if (!image?.id || seen.has(image.id)) continue
    seen.add(image.id)
    out.push(image)
  }
  return out
}

/**
 * 每条提示词分配一组输入图。
 *
 * 固定图全部带上；变量图按顺序轮换（条数多于变量图数时循环取）。
 * 固定图与变量图是同一张图时只保留一次，否则接口会收到两张一样的图，
 * 既浪费位置也会让模型误以为有两种变化。
 *
 * 超过 MAX_INPUT_IMAGES 时按「固定图优先」截断：固定图是用户明确要求每次都带的，
 * 变量图少了只是少一种变化，固定图少了会直接改变画面基底。
 */
export function planVariableImageAssignments(
  fixedImages: InputImage[],
  variableImages: InputImage[],
  promptCount: number,
  offset = 0,
): VariableImagePlan {
  const count = Math.max(0, Math.floor(promptCount) || 0)
  const fixed = dedupeById(fixedImages)
  const variable = dedupeById(variableImages).filter((image) => !fixed.some((item) => item.id === image.id))
  if (!count) return { assignments: [], nextOffset: offset }

  const room = Math.max(0, MAX_INPUT_IMAGES - fixed.length)
  const pool = room > 0 ? variable : []

  const assignments: VariableImageAssignment[] = Array.from({ length: count }, (_, index) => {
    if (!pool.length) return { images: [...fixed], variableImage: null }
    const picked = pool[(((offset + index) % pool.length) + pool.length) % pool.length]
    return { images: [...fixed, picked], variableImage: picked }
  })

  return { assignments, nextOffset: pool.length ? offset + count : offset }
}

/** 固定图 + 1 张变量图会不会超过接口允许的图片数，超了要提前提示 */
export function variableImageOverflow(fixedCount: number, hasVariable: boolean): boolean {
  return fixedCount + (hasVariable ? 1 : 0) > MAX_INPUT_IMAGES
}

/**
 * 写进提示词的图片说明。
 *
 * 变量模式下模型看到多张图却不知道哪张「每次都一样」、哪张「每次都换」，
 * 很容易把变量图的产品细节也当成必须保留的东西，出来一堆不同的产品。
 * 这里把角色讲清楚：固定图是必须保持的基底，变量图只取它的变化部分。
 */
export function buildVariableImageHint(fixedCount: number, variableCount: number): string {
  const fixed = Math.max(0, Math.floor(fixedCount) || 0)
  const variable = Math.max(0, Math.floor(variableCount) || 0)
  if (!fixed && !variable) return ''

  const lines: string[] = ['【输入图片说明】']
  if (fixed && variable) {
    lines.push(
      `前 ${fixed} 张是固定图，${variable > 1 ? '这一批的每一条都会带上同一组固定图' : '每一条都会带上'}，`
      + '其中的产品外观、包装、品牌标识、版式骨架必须与它们一致，不得改写。',
      '最后 1 张是本次变量图，只取它的场景、构图、机位、光影或配色变化，'
      + '不要把变量图里的产品当成必须保留的对象；两张图冲突时一律以固定图为准。',
    )
  } else if (fixed) {
    lines.push(
      `提供的 ${fixed} 张都是固定图，每次都会带上同一组，`
      + '其中的产品外观、包装、品牌标识、版式骨架必须与它们一致。',
      '本次没有变量图，画面变化只来自提示词里的变量填词。',
    )
  } else {
    lines.push(
      '只提供了 1 张变量图，它的作用是与上一张图产生区别：'
      + '取它的场景、构图、机位、光影或配色变化，不要逐像素复刻它。',
    )
  }
  return lines.join('\n')
}

/** 把图片说明拼到提示词前面；没有说明时原样返回 */
export function withVariableImageHint(prompt: string, hint: string): string {
  const text = hint.trim()
  if (!text) return prompt
  return `${text}\n\n${prompt}`.trim()
}
