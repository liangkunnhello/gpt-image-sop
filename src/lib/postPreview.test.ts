import { beforeEach, describe, expect, it } from 'vitest'

import { postTemplateRatioKey } from './postTemplate'
import { useSopStore } from './sopStore'

const reset = () => {
  useSopStore.setState({ postPreviewImages: {} })
}

const preview = (productId: string) => useSopStore.getState().postPreviewImages[productId]

describe('后处理模板预览底图', () => {
  beforeEach(reset)

  it('按产品 + 比例档存，同比例的多套模板共用一张', () => {
    const store = useSopStore.getState()
    store.setPostPreviewImage('prod-1', '9:16', 'img-a')
    store.setPostPreviewImage('prod-1', '16:9', 'img-b')

    expect(preview('prod-1')).toEqual({ '9:16': 'img-a', '16:9': 'img-b' })
    // 同一比例再取一次还是那张，不会被别的比例覆盖
    expect(preview('prod-1')['9:16']).toBe('img-a')
  })

  it('不同产品的底图互不影响', () => {
    const store = useSopStore.getState()
    store.setPostPreviewImage('prod-1', '1:1', 'img-a')
    store.setPostPreviewImage('prod-2', '1:1', 'img-b')

    expect(preview('prod-1')).toEqual({ '1:1': 'img-a' })
    expect(preview('prod-2')).toEqual({ '1:1': 'img-b' })
  })

  it('传 null 清掉该比例，没设置就是默认底色', () => {
    const store = useSopStore.getState()
    store.setPostPreviewImage('prod-1', '9:16', 'img-a')
    store.setPostPreviewImage('prod-1', '9:16', null)

    expect(preview('prod-1')).toBeUndefined()
  })

  it('只清掉一档时其它比例保留', () => {
    const store = useSopStore.getState()
    store.setPostPreviewImage('prod-1', '9:16', 'img-a')
    store.setPostPreviewImage('prod-1', '1:1', 'img-b')
    store.setPostPreviewImage('prod-1', '9:16', null)

    expect(preview('prod-1')).toEqual({ '1:1': 'img-b' })
  })

  it('比例档按尺寸归组，自定义尺寸归到 other', () => {
    expect(postTemplateRatioKey({ width: 1440, height: 2560 })).toBe('9:16')
    expect(postTemplateRatioKey({ width: 2560, height: 1440 })).toBe('16:9')
    expect(postTemplateRatioKey({ width: 1000, height: 300 })).toBe('other')
  })
})
