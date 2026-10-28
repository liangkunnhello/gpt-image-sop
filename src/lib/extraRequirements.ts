/**
 * 额外要求：写进提示词、影响出图的一组「规则」文本。
 *
 * 为什么单独做一份库：以前这些规则（不参考 logo、不要按钮、卖点只认选择器、避开预留区）
 * 是代码里写死的开关，措辞改不了、也加不了新规则。现在它们变成可编辑的条目：
 * 在提示词库里增删改，按方向多选，选中哪几条就拼哪几条。
 *
 * 其中两条除了文案还牵动代码行为（按 id 认，改名不影响）：
 * - strip-cta：写提示词时把 SOP 里「留出按钮位置」这类句子剔掉
 * - avoid-overlay：把后处理模板的预留区坐标告诉模型
 */

export interface ExtraRequirement {
  id: string
  /** 名字要短，会出现在输入区与详情页 */
  name: string
  /** 正文：直接拼进提示词，模型照着做 */
  content: string
  /** 内置条目：可改名、可改内容、可删除，但删掉就没有对应行为了 */
  builtin?: boolean
  /** 需要代码配合的行为，按 id 认 */
  behavior?: 'strip-cta' | 'avoid-overlay'
}

/** 内置条目的 id：代码里按它认行为，不要改 */
export const EXTRA_ID = {
  noLogo: 'extra-no-logo',
  noCta: 'extra-no-cta',
  pointSelector: 'extra-point-selector',
  avoidOverlay: 'extra-avoid-overlay',
} as const

/** 默认就带上的四条，等价于改造前那四个勾选「默认开启」的状态 */
export const BUILTIN_EXTRAS: ExtraRequirement[] = [
  {
    id: EXTRA_ID.noLogo,
    name: '不参考 logo 与合规文案',
    content: '参考图上的品牌 logo、水印、免责声明、风险提示、「请见条款及投保须知」「本素材纯属广告创意」这类合规小字，一律不要写进 SOP，也不要要求在生成的图上出现。',
    builtin: true,
  },
  {
    id: EXTRA_ID.noCta,
    name: '不要按钮 / 引导点击的设计',
    content: [
      '参考图里的按钮、悬浮球、进度条、返回箭头、开关、卡片跳转等「仿系统界面 / 可点击」的设计元素，一律不要写进 SOP；',
      'SOP 里要明确列为禁忌：不画按钮、不画手指点击示意、不加指向性的箭头或手势，',
      '也不写「立即领取」「点击查看」「滑动解锁」「下载App」这类引导点击的文案。',
      '也不要写「留出按钮位置」「按钮槽位」「CTA 区」「空按钮」这类要求：按钮位不是版面元素，',
      '画面上出现空白胶囊、空白长条、带描边的空白圆角块，就等于画了一只没有文字的按钮。',
      '卖点列表下面直接收尾，用留白或装饰图形结束，不要给按钮留坑。',
    ].join(''),
    builtin: true,
    behavior: 'strip-cta',
  },
  {
    id: EXTRA_ID.pointSelector,
    name: '卖点只以选择器为准',
    content: '不要从参考图上提取或复用卖点文案。SOP 的文字规范只描述文字的层级、字号与排布方式，具体文案以用户提供的卖点为准。',
    builtin: true,
  },
  {
    id: EXTRA_ID.avoidOverlay,
    name: '提示词避开 Logo / 警示语位置',
    content: '版式结构里必须给后期预留区留出干净背景，把这些位置让出来、不安排主体、标题文字、图标或装饰块。注意是让版式自然避开，不是画一个空白边框或空块去「占位」。',
    builtin: true,
    behavior: 'avoid-overlay',
  },
]

/** 没配过时默认全选（与改造前四个勾选全开的默认值一致） */
export const DEFAULT_EXTRA_IDS: string[] = BUILTIN_EXTRAS.map((item) => item.id)

/** 从一整套额外要求里挑出选中的那几条，顺序按库里的顺序，方便稳定拼提示词 */
export function pickExtraRequirements(all: ExtraRequirement[], ids: string[]): ExtraRequirement[] {
  const wanted = new Set(ids)
  return all.filter((item) => wanted.has(item.id) && item.content.trim())
}

/** 选中的额外要求拼成一段，喂给提示词包 */
export function extraContents(all: ExtraRequirement[], ids: string[]): string[] {
  return pickExtraRequirements(all, ids).map((item) => item.content.trim())
}

/** 某条内置行为有没有被选中（改名不影响，按 id 认） */
export function hasExtra(all: ExtraRequirement[], ids: string[], behavior: NonNullable<ExtraRequirement['behavior']>) {
  return pickExtraRequirements(all, ids).some((item) => item.behavior === behavior)
}

/** 某个方向当前生效的额外要求 id：没配过就用默认那几条 */
export function resolveExtraIds(extraPick: Record<string, string[]>, directionId: string | undefined): string[] {
  if (!directionId) return DEFAULT_EXTRA_IDS
  const picked = extraPick[directionId]
  return Array.isArray(picked) ? picked : DEFAULT_EXTRA_IDS
}
