/**
 * 每条提示词的画面差异分配。
 *
 * 为什么要有这个：只靠「多条之间要做出区分」这种自然语言约束，模型没有分配表，
 * 会在最顺手的两三个维度上打转，条数一多后半段就退化成前几条的变体。
 * 这里在代码里预先算出一组互不重复的「场景 / 机位 / 主体 / 色调」组合，
 * 每条提示词锁定一行，模型只负责把这一行展开成画面描述。
 */

export interface PromptVariation {
  /** 在哪拍 */
  scene: string
  /** 怎么拍 */
  angle: string
  /** 拍谁 */
  subject: string
  /** 什么色调 */
  tone: string
}

/**
 * 多条提示词之间怎么拉开差异：
 * - deepen（深化）：沿用原有做法，围绕同一份 SOP 自由做画面变化，风格最统一
 * - explore（探索）：每条锁定不同的场景/机位/主体/色调，差异最大
 */
export type SopVariationMode = 'deepen' | 'explore'

const SCENES = [
  '户外街景',
  '室内窗边',
  '居家客厅',
  '办公空间',
  '咖啡店',
  '城市夜景',
  '厨房餐桌',
  '医院走廊',
  '健身房',
  '地铁站台',
  '公园草坪',
  '阳台一角',
]

const ANGLES = [
  '平视中景',
  '俯拍特写',
  '仰拍全身',
  '侧面近景',
  '过肩镜头',
  '广角远景',
]

const SUBJECTS = [
  '单人青年',
  '双人家庭',
  '亲子三口',
  '老年夫妇',
  '独立女性',
  '职场男性',
  '产品特写无人',
]

const TONES = [
  '暖阳橙',
  '清冷蓝',
  '柔和米白',
  '高对比黑金',
  '清新薄荷',
  '落日粉',
]

/**
 * 组合的重复周期是四个维度长度的最小公倍数（12/6/7/6 → 84），
 * 超过这个数量一定会撞组合，界面上限是 30，这里留足余量。
 */
export const MAX_VARIATIONS = 84

/**
 * 生成 count 组互不重复的组合。
 * 每个维度用不同的步长取模：步长与维度长度互质，保证该维度在整轮里均匀铺开，
 * 四个维度周期错开，前 84 组不会出现完全相同的组合。
 */
export function buildVariations(count: number): PromptVariation[] {
  const total = Math.max(0, Math.min(MAX_VARIATIONS, Math.round(count) || 0))
  const out: PromptVariation[] = []
  for (let i = 0; i < total; i += 1) {
    out.push({
      scene: SCENES[(i * 5) % SCENES.length],
      angle: ANGLES[(i * 5 + 2) % ANGLES.length],
      subject: SUBJECTS[(i * 3 + 1) % SUBJECTS.length],
      tone: TONES[(i + 3) % TONES.length],
    })
  }
  return out
}

/** 拼成给模型的表格；没有条目时返回空串，调用方据此决定要不要拼进请求 */
export function buildVariationTable(variations: PromptVariation[]): string {
  if (!variations.length) return ''
  const rows = variations.map(
    (item, index) =>
      `第 ${index + 1} 条：场景＝${item.scene}｜机位＝${item.angle}｜主体＝${item.subject}｜色调＝${item.tone}`,
  )
  return [
    '【每条的画面差异（已经分配好，必须照此执行）】',
    ...rows,
    '每条提示词只能使用自己那一行的四项取值，不得与其它行互换、合并或重复；除这四项以外，SOP 里的版式结构、文字层级和图上文字全部保持不变。',
  ].join('\n')
}
