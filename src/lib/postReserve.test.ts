import { describe, expect, it } from 'vitest'

import { createPostTemplate, newPostElement, type PostTemplate } from './postTemplate'
import {
  buildAvoidHint,
  buildAvoidHintForTask,
  collectAvoidZones,
  pickAvoidTemplate,
  withAvoidHint,
} from './postReserve'

const make = (width: number, height: number, patch: Partial<PostTemplate> = {}): PostTemplate => ({
  ...createPostTemplate(width, height, `${width}x${height}`),
  enabled: true,
  ...patch,
})

const text = (patch: Partial<ReturnType<typeof newPostElement>> = {}) => ({
  ...newPostElement('text', 1),
  ...patch,
})

describe('collectAvoidZones', () => {
  it('把文字位置换算成预留区，并认出警示语', () => {
    const template = make(1440, 2560, {
      elements: [
        { ...text({ text: '免赔额、赔付比例、费率等请见保险条款及投保须知', x: 0.06, y: 0.93, fontSize: 28 }), label: '警示语' },
      ],
    })
    const zones = collectAvoidZones(template)
    expect(zones).toHaveLength(1)
    expect(zones[0].region).toBe('左下角')
    expect(zones[0].label).toBe('警示语')
    expect(zones[0].box.y0).toBeCloseTo(0.93, 2)
    expect(zones[0].box.y1).toBeGreaterThan(zones[0].box.y0)
  })

  it('横向铺满的算通栏', () => {
    const template = make(1440, 2560, {
      elements: [{ ...text({ text: '本素材纯属广告创意，具体以保险条款为准', x: 0.05, y: 0.05, fontSize: 60 }) }],
    })
    const zones = collectAvoidZones(template)
    expect(zones[0].region).toBe('顶部通栏')
  })

  it('关掉避让的元素、空文字、没选图的 logo 都不参与', () => {
    const template = make(1440, 2560, {
      elements: [
        text({ text: '要避让', avoid: true }),
        text({ text: '不用避让', avoid: false }),
        text({ text: '   ' }),
        { ...newPostElement('logo', 4), text: '' },
      ],
    })
    expect(collectAvoidZones(template)).toHaveLength(1)
  })

  it('模板关掉自动避让时返回空', () => {
    const template = make(1440, 2560, { elements: [text({ text: '要避让' })], avoidOverlay: false })
    expect(collectAvoidZones(template)).toHaveLength(0)
    expect(buildAvoidHint(template)).toBe('')
  })
})

describe('buildAvoidHint', () => {
  it('输出带位置和内容的避让说明', () => {
    const template = make(1440, 2560, {
      elements: [
        { ...newPostElement('logo', 1), text: 'data:image/png;base64,xx', x: 0.06, y: 0.06, width: 0.14, aspect: 0.4, label: 'Logo' },
        { ...text({ text: '免赔额请见保险条款', x: 0.06, y: 0.93, fontSize: 28 }), label: '警示语' },
      ],
    })
    const hint = buildAvoidHint(template)
    expect(hint).toContain('画面预留区')
    expect(hint).toContain('左上角')
    expect(hint).toContain('「Logo」')
    expect(hint).toContain('「警示语」')
    expect(hint).toContain('横向约')
  })

  it('没有模板时返回空串', () => {
    expect(buildAvoidHint(null)).toBe('')
  })
})

describe('withAvoidHint', () => {
  const hint = '【画面预留区】测试'

  it('追加到提示词末尾', () => {
    expect(withAvoidHint('一只猫', hint)).toBe(`一只猫\n\n${hint}`)
  })

  it('已经有了就不重复追加', () => {
    const once = withAvoidHint('一只猫', hint)
    expect(withAvoidHint(once, hint)).toBe(once)
  })

  it('提示词为空或说明为空时原样返回', () => {
    expect(withAvoidHint('', hint)).toBe('')
    expect(withAvoidHint('一只猫', '')).toBe('一只猫')
  })
})

describe('pickAvoidTemplate', () => {
  it('按尺寸挑比例一致的模板', () => {
    const templates = [make(1440, 2560, { label: '竖版' }), make(2048, 2048, { label: '方图' })]
    expect(pickAvoidTemplate(templates, '1440x2560')?.label).toBe('竖版')
    expect(pickAvoidTemplate(templates, '2048x2048')?.label).toBe('方图')
  })

  it('比例未知且有多套时不猜，只有一套才用', () => {
    const one = [make(1440, 2560)]
    expect(pickAvoidTemplate(one, 'auto')?.id).toBe(one[0].id)
    const many = [make(1440, 2560), make(2048, 2048)]
    expect(pickAvoidTemplate(many, 'auto')).toBeNull()
  })

  it('未启用的模板不参与避让', () => {
    expect(pickAvoidTemplate([make(1440, 2560, { enabled: false })], '1440x2560')).toBeNull()
  })
})

describe('buildAvoidHintForTask', () => {
  it('有模板有尺寸时给出说明，没模板时为空', () => {
    const template = make(1440, 2560, { elements: [text({ text: '警示语在这里' })] })
    expect(buildAvoidHintForTask({ sopDirectionId: 'dir', params: { size: '1440x2560' } as never }, [template]))
      .toContain('画面预留区')
    expect(buildAvoidHintForTask({ sopDirectionId: 'dir', params: { size: 'auto' } as never }, [])).toBe('')
  })
})
