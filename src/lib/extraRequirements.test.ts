import { describe, expect, it } from 'vitest'
import {
  BUILTIN_EXTRAS,
  DEFAULT_EXTRA_IDS,
  EXTRA_ID,
  extraContents,
  hasExtra,
  pickExtraRequirements,
  resolveExtraIds,
  type ExtraRequirement,
} from './extraRequirements'

const custom: ExtraRequirement = { id: 'extra-mine', name: '不画人物正面', content: '禁止出现正面人脸，只画侧脸或背影。' }

describe('额外要求', () => {
  it('内置四条都带名字和正文，id 不重复', () => {
    expect(BUILTIN_EXTRAS).toHaveLength(4)
    for (const item of BUILTIN_EXTRAS) {
      expect(item.name.trim()).not.toBe('')
      expect(item.content.trim()).not.toBe('')
      expect(item.builtin).toBe(true)
    }
    expect(new Set(BUILTIN_EXTRAS.map((item) => item.id)).size).toBe(4)
    expect(DEFAULT_EXTRA_IDS).toEqual(BUILTIN_EXTRAS.map((item) => item.id))
  })

  it('按 id 挑出选中的那几条，顺序跟着库走', () => {
    const all = [...BUILTIN_EXTRAS, custom]
    const picked = pickExtraRequirements(all, [custom.id, EXTRA_ID.noCta])
    expect(picked.map((item) => item.id)).toEqual([EXTRA_ID.noCta, custom.id])
  })

  it('正文为空的那条不算生效（勾了也不会有内容）', () => {
    const blank: ExtraRequirement = { id: 'extra-blank', name: '空条目', content: '   ' }
    expect(pickExtraRequirements([blank], [blank.id])).toEqual([])
    expect(extraContents([blank], [blank.id])).toEqual([])
  })

  it('拼给提示词时只给正文，按库里的顺序', () => {
    const all = [...BUILTIN_EXTRAS, custom]
    const lines = extraContents(all, [custom.id, EXTRA_ID.noLogo])
    expect(lines[0]).toContain('品牌 logo')
    expect(lines[1]).toBe(custom.content)
  })

  it('行为按 id 认，改名不影响（用户可以在库里改措辞）', () => {
    const renamed = BUILTIN_EXTRAS.map((item) => (
      item.id === EXTRA_ID.noCta ? { ...item, name: '绝对不要按钮' } : item
    ))
    expect(hasExtra(renamed, [EXTRA_ID.noCta], 'strip-cta')).toBe(true)
    expect(hasExtra(renamed, [], 'strip-cta')).toBe(false)
    expect(hasExtra(renamed, [EXTRA_ID.avoidOverlay], 'avoid-overlay')).toBe(true)
  })

  it('某条被删掉后，它的行为也跟着关掉', () => {
    const withoutNoCta = BUILTIN_EXTRAS.filter((item) => item.id !== EXTRA_ID.noCta)
    expect(hasExtra(withoutNoCta, [EXTRA_ID.noCta], 'strip-cta')).toBe(false)
  })

  it('方向没配过就用默认那几条；配过（哪怕是空数组）就按配的来', () => {
    expect(resolveExtraIds({}, 'dir-1')).toEqual(DEFAULT_EXTRA_IDS)
    expect(resolveExtraIds({}, undefined)).toEqual(DEFAULT_EXTRA_IDS)
    expect(resolveExtraIds({ 'dir-1': ['extra-mine'] }, 'dir-1')).toEqual(['extra-mine'])
    // 用户把这对勾全取消了，不该又冒出默认的四条
    expect(resolveExtraIds({ 'dir-1': [] }, 'dir-1')).toEqual([])
  })
})
