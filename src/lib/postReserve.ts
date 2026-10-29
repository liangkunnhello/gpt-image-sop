/**
 * 后处理预留区 → 提示词避让说明。
 *
 * 后处理模板里的 Logo、警示语位置是固定的，出图后才会叠上去。
 * 生图时如果主体或文字正好压在这些位置，成品就会糊成一团，
 * 所以这里把位置换算成「画面预留区」写进提示词，让模型主动避开。
 */

import { imageSizeFromDataUrl } from './imageDimensions'
import { SIZE_PATTERN } from './size'
import {
  elementBox,
  elementInCanvas,
  elementLabel,
  pickTemplateForImage,
  regionName,
  type PostElement,
  type PostTemplate,
} from './postTemplate'
import type { TaskRecord } from '../types'

export interface AvoidZone {
  /** 方位，例如「左上角」 */
  region: string
  /** 这块后期要叠什么，例如「Logo」 */
  label: string
  /** 0~1 的相对坐标 */
  box: { x0: number; y0: number; x1: number; y1: number }
}

const percent = (value: number) => `${Math.round(value * 100)}%`

/** 参与避让的元素：文字要有内容，logo 要真的选过图 */
function avoidableElements(template: PostTemplate): PostElement[] {
  return template.elements.filter((element) => {
    if (element.avoid === false) return false
    return element.kind === 'logo' ? Boolean(element.text) : Boolean(element.text.trim())
  })
}

/** 算出这套模板的预留区；模板关掉了自动避让或没有可用元素时返回空数组 */
export function collectAvoidZones(template: PostTemplate | null): AvoidZone[] {
  if (!template) return []
  if (template.avoidOverlay === false) return []
  return avoidableElements(template).flatMap((element, index) => {
    const box = elementBox(element, template.width, template.height)
    // 整块被推到画布外：成品图上没有它，不能让模型去避开一个看不见的框
    if (!elementInCanvas(box)) return []
    return [{ region: regionName(box), label: elementLabel(element, index), box }]
  })
}

/**
 * 把预留区写成给生图模型看的中文说明。
 * 没有预留区时返回空串，调用方直接跳过。
 */
export function buildAvoidHint(template: PostTemplate | null): string {
  const zones = collectAvoidZones(template)
  if (!zones.length) return ''

  const items = zones.map((zone, index) => (
    `${index + 1}. ${zone.region}：横向约 ${percent(zone.box.x0)}~${percent(zone.box.x1)}、`
    + `纵向约 ${percent(zone.box.y0)}~${percent(zone.box.y1)}，这里后期要叠加「${zone.label}」`
  ))

  return [
    '【画面预留区】这张图出图后会在下面的固定位置叠加后期内容，这些区域必须保持干净、简洁的背景或留白，'
    + '不要安排主体人物、产品、标题文字、图标或任何重要细节：',
    items.join('；'),
    '主体、主要文字和关键视觉请全部安排在上述预留区之外；画面里也不要自己生成 Logo、水印、二维码或免责声明文字。',
    '这些区域也不要画占位形状（空胶囊、空长条、色块、边框）来「预留」——空白形状在成图里就是一块没有内容的装饰块。',
  ].join('\n')
}

/**
 * 预留区的短摘要，给「反推 SOP」用：让 SOP 的版式结构一开始就把这些位置让出来，
 * 而不是等写提示词时再强行避让（两头打架时模型很容易画个空块占位）。
 * 例如「左上角（后期叠Logo）、底部居中（后期叠警示语）」。
 */
export function avoidZoneSummary(template: PostTemplate | null): string {
  return collectAvoidZones(template)
    .map((zone) => `${zone.region}（后期叠${zone.label}）`)
    .join('、')
}

/** 提示词末尾追加避让说明，已经在里面就不重复加 */
export function withAvoidHint(prompt: string, hint: string): string {
  const trimmed = String(prompt || '').trimEnd()
  const value = String(hint || '').trim()
  if (!value || !trimmed) return prompt
  if (trimmed.includes(value)) return prompt
  return `${trimmed}\n\n${value}`
}

/**
 * 从「目标尺寸（如 1024x1024 / auto）+ 参考图」推断出图比例，
 * 用来在生图之前就挑出会套用的那套后处理模板。
 */
export function resolveOutputSize(
  size: string | undefined,
  referenceDataUrls: string[] = [],
): { width: number; height: number } | null {
  const value = String(size || '').trim()
  if (value && value !== 'auto') {
    const match = value.match(SIZE_PATTERN)
    if (!match) return null
    const width = Number(match[1])
    const height = Number(match[2])
    return width > 0 && height > 0 ? { width, height } : null
  }
  for (const url of referenceDataUrls) {
    const ref = imageSizeFromDataUrl(url)
    if (ref && ref.width > 0 && ref.height > 0) return { width: ref.width, height: ref.height }
  }
  return null
}

/**
 * 按方向和出图比例挑出会套用的模板。
 * 比例拿不到时，只有这个产品只启用了一套模板才用它，避免猜错。
 */
export function pickAvoidTemplate(
  templates: PostTemplate[],
  size: string | undefined,
  referenceDataUrls: string[] = [],
  channel?: string,
): PostTemplate | null {
  const enabled = templates.filter((item) => item.enabled)
  if (!enabled.length) return null
  const resolved = resolveOutputSize(size, referenceDataUrls)
  if (resolved) return pickTemplateForImage(enabled, resolved.width, resolved.height, channel)
  // 比例拿不到时只在一套模板里猜：指定渠道就只看该渠道 + 通用，避免套到别的渠道口径
  if (channel) {
    const scoped = enabled.filter((item) => !item.channel || item.channel === channel)
    return scoped.length === 1 ? scoped[0] : null
  }
  return enabled.length === 1 ? enabled[0] : null
}

/**
 * 出图前给某条任务算好避让说明。
 * 任务没归属方向、方向所属产品没配模板、或模板关了自动避让时都返回空串。
 */
export function buildAvoidHintForTask(
  task: Pick<TaskRecord, 'sopDirectionId' | 'params' | 'channel'>,
  templates: PostTemplate[],
  referenceDataUrls: string[] = [],
): string {
  if (!templates.length) return ''
  const template = pickAvoidTemplate(templates, task.params?.size, referenceDataUrls, task.channel)
  return buildAvoidHint(template)
}
