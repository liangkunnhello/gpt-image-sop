/**
 * SOP 模式图生图：三个图片池的分工，以及写进提示词的「底图说明」。
 *
 * - 参考图：只用于反推 SOP。用存档 SOP 时不反推，它完全不参与生图。
 * - 固定图：整批共用，每条提示词都带同一组，是画面基底。
 * - 变量图：每条轮换一张，跨卡接着往下轮（第一张卡用了 5 张，第二张从第 6 张继续）。
 *
 * 分配策略直接复用变量模式那套（planVariableImageAssignments），
 * 两个模式的差别只在「谁来写提示词」，图片在请求里的角色是一样的。
 */

import type { ImageFidelity, InputImage } from '../types'
import { planVariableImageAssignments, withVariableImageHint, type VariableImagePlan } from './variableImages'

export const IMAGE_FIDELITY_OPTIONS: Array<{ value: ImageFidelity; label: string; hint: string }> = [
  {
    value: 'layout',
    label: '保版式',
    hint: '构图、版式、文字区位置照底图，只把图上文字换成本批文案',
  },
  {
    value: 'product',
    label: '保产品',
    hint: '产品与包装照底图，场景、构图、光线按提示词重画',
  },
  {
    value: 'style',
    label: '只借风格',
    hint: '内容全部重画，只借底图的配色与质感',
  },
]

export const DEFAULT_IMAGE_FIDELITY: ImageFidelity = 'layout'

/** 存到任务上的值可能是老数据 / 脏值，一律退回默认档 */
export function normalizeImageFidelity(value: unknown): ImageFidelity {
  return value === 'layout' || value === 'product' || value === 'style'
    ? value
    : DEFAULT_IMAGE_FIDELITY
}

export function imageFidelityLabel(value: unknown): string {
  const fidelity = normalizeImageFidelity(value)
  return IMAGE_FIDELITY_OPTIONS.find((item) => item.value === fidelity)?.label ?? '保版式'
}

/** 这批到底有没有底图：两个池都空就是纯文生图，提示词里不该出现任何底图说明 */
export function hasSopBaseImages(fixedImages?: InputImage[], variableImages?: InputImage[]): boolean {
  return Boolean(fixedImages?.length || variableImages?.length)
}

/**
 * 第 index 张卡的变量图从哪一张开始。
 *
 * 跨卡累计而不是每卡从头：一批图里有 12 张变量图、每卡出 5 条，
 * 第二张卡应该从第 6 张继续，而不是又把前 5 张轮一遍 —— 否则后面的图永远用不上。
 * 用「计划条数」算，不依赖上一张卡实际出了几条（那种依赖会让并发下的结果不可预测）。
 */
export function sopVariableImageOffset(cardIndex: number, promptsPerCard: number): number {
  const index = Math.max(0, Math.floor(cardIndex) || 0)
  const perCard = Math.max(0, Math.floor(promptsPerCard) || 0)
  return index * perCard
}

/** 每条提示词带哪组图：固定图全带 + 1 张变量图轮换 */
export function planSopImages(
  fixedImages: InputImage[],
  variableImages: InputImage[],
  promptCount: number,
  offset = 0,
): VariableImagePlan {
  return planVariableImageAssignments(fixedImages, variableImages, promptCount, offset)
}

export interface SopImageHintInput {
  fixedCount: number
  variableCount: number
  fidelity?: ImageFidelity
}

/**
 * 底图说明：拼在每条提示词最前面。
 *
 * 两处都要用 ——
 * 1. 写提示词时作为约束（模型据此决定哪些东西不写、哪些要写）；
 * 2. 发送前再拼一次（写出来的提示词可能漏掉这层，模型也常常忘）。
 *
 * 「用户要求优先」这一条必须写在最显眼的位置：底图是参考，不是命令。
 * 用户写了新文案、指定了场景，就不该为了贴合底图把要求让掉。
 */
export function buildSopImageHint({ fixedCount, variableCount, fidelity = DEFAULT_IMAGE_FIDELITY }: SopImageHintInput): string {
  const fixed = Math.max(0, Math.floor(fixedCount) || 0)
  const variable = Math.max(0, Math.floor(variableCount) || 0)
  if (!fixed && !variable) return ''

  const lines: string[] = ['【底图说明】']
  if (fixed && variable) {
    lines.push(
      `前 ${fixed} 张是固定图，每条提示词都会带上同一组，产品外观、包装、品牌标识与版式骨架以它们为准。`,
      '最后 1 张是本次变量图，只取它的场景、构图、机位、光影或配色变化，不要把变量图里的产品当成必须保留的对象；两张冲突时以固定图为准。',
    )
  } else if (fixed) {
    lines.push(
      `提供的 ${fixed} 张都是固定图，每条提示词都会带上同一组，产品外观、包装、品牌标识与版式骨架以它们为准。`,
      '本次没有变量图，画面变化只来自提示词本身。',
    )
  } else {
    lines.push(
      '每条提示词会各带 1 张变量图，它是本次画面的主要参考。',
    )
  }

  const fidelityLine = fidelity === 'layout'
    ? '保留底图的版式结构、元素位置与视觉层级，只把画面上的文字换成本批文案；产品与场景保持原样。'
    : fidelity === 'product'
      ? '产品、包装与品牌标识必须与底图一致，场景、构图、光线与配色可以按提示词重新设计。'
      : '只借鉴底图的配色、质感与整体风格，产品、场景、版式都按提示词重新设计。'
  lines.push(fidelityLine)

  lines.push(
    '【优先级】用户给出的文案与额外要求优先级最高：与底图冲突时以用户要求为准，该改的地方就改，不要为了贴合底图牺牲用户要求。',
    '描述时只写「要在这张底图上改什么、加什么」，不要重复描述底图里已经确定的产品外形、包装文字、品牌标识与底纹，也不要写出与底图矛盾的结构。',
  )
  return lines.join('\n')
}

/** 把底图说明拼到提示词前面；没有说明时原样返回 */
export const withSopImageHint = withVariableImageHint
