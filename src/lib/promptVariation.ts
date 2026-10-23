/**
 * 四维变量池：作为反推 SOP 时的候选，由模型结合参考图取舍、补充后写进 SOP 的「变量池」小节。
 *
 * 这里不再负责「给第几条分配哪组」——发散规则已经固化进 SOP 本身，
 * 写提示词阶段读 SOP 里的变量池和互斥规则即可，不需要外部再注入差异表。
 */

export const SCENE_CANDIDATES = [
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

export const ANGLE_CANDIDATES = [
  '平视中景',
  '俯拍特写',
  '仰拍全身',
  '侧面近景',
  '过肩镜头',
  '广角远景',
]

export const SUBJECT_CANDIDATES = [
  '单人青年',
  '双人家庭',
  '亲子三口',
  '老年夫妇',
  '独立女性',
  '职场男性',
  '产品特写无人',
]

export const TONE_CANDIDATES = [
  '暖阳橙',
  '清冷蓝',
  '柔和米白',
  '高对比黑金',
  '清新薄荷',
  '落日粉',
]

/**
 * 拼成反推阶段用的一段候选说明。
 * 明确要求「取舍」，否则模型会把十二个场景全抄进 SOP，换个产品就不适用。
 */
export function variationCandidates(): string {
  return [
    '【可用的变量候选（请取舍，不要照抄）】',
    `场景：${SCENE_CANDIDATES.join(' / ')}`,
    `机位：${ANGLE_CANDIDATES.join(' / ')}`,
    `主体：${SUBJECT_CANDIDATES.join(' / ')}`,
    `色调：${TONE_CANDIDATES.join(' / ')}`,
  ].join('\n')
}
