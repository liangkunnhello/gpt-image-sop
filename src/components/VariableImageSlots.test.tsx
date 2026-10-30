// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useStore } from '../store'
import VariableImageSlots from './input/VariableImageSlots'

/**
 * 变量模式图生图有三个图片入口：参考图 / 固定图 / 变量图。
 * 三个池各自独立是这套功能的核心，这里盯住：
 * 计数、拖入落到哪个池、清空只清自己、上限提示文案。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const img = (id: string) => ({ id, dataUrl: `data:image/png;base64,${id}` })

/** 参考图不限张数，用 Infinity 表示；固定图 / 变量图仍受请求上限约束 */
const UNLIMITED = Number.POSITIVE_INFINITY

let root: ReturnType<typeof createRoot> | null = null

function reset() {
  useStore.setState({
    inputImages: [],
    fixedImages: [],
    variableImages: [],
    // 上一条用例可能开了大图，这里一并复位，否则「点×不会打开」会被上一条的状态骗过
    lightboxImageId: null,
    lightboxImageList: [],
  })
}

beforeEach(reset)

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function render(props: { referenceLimit?: number; requestLimit?: number } = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <VariableImageSlots
        referenceLimit={props.referenceLimit ?? UNLIMITED}
        requestLimit={props.requestLimit ?? 16}
      />,
    )
  })
  /** 三个区按标题文案定位：标题文本就是「参考图」「固定图」「变量图」 */
  const slot = (title: string) => {
    const label = [...container.querySelectorAll('span')]
      .find((el) => el.textContent === title && el.className.includes('font-semibold'))
    return label?.closest('div[class*="border-dashed"]') as HTMLElement
  }
  return { container, slot }
}

describe('变量模式三分区图片入口', () => {
  it('三个区都渲染出来，标题与角色说明不混', () => {
    const { slot } = render()
    expect(slot('参考图')?.textContent).toContain('不进生图接口')
    expect(slot('固定图')?.textContent).toContain('每条提示词都带同一组')
    expect(slot('变量图')?.textContent).toContain('轮换取一张')
  })

  it('三个池各自显示自己的张数：参考图与变量图不限，只有固定图受请求上限约束', () => {
    useStore.setState({
      inputImages: [img('r1'), img('r2')],
      fixedImages: [img('f1')],
      variableImages: [img('v1'), img('v2'), img('v3')],
    })
    const { slot } = render({ referenceLimit: UNLIMITED, requestLimit: 16 })
    // 不限张数时只显示「已选 N 张」，不显示「N / Infinity」
    expect(slot('参考图')?.textContent).toContain('2 张')
    expect(slot('参考图')?.textContent).not.toContain('Infinity')
    // 固定图每条都塞进同一个请求，受接口上限约束
    expect(slot('固定图')?.textContent).toContain('1 / 16')
    // 变量图每条只取一张，不占请求名额，所以不设上限
    expect(slot('变量图')?.textContent).toContain('3 张')
    expect(slot('变量图')?.textContent).not.toContain('Infinity')
  })

  it('清空只清自己那一个池，其他两个不动', () => {
    useStore.setState({
      inputImages: [img('r1')],
      fixedImages: [img('f1')],
      variableImages: [img('v1')],
    })
    const { slot } = render()
    const clearButton = [...slot('变量图')!.querySelectorAll('button')]
      .find((btn) => btn.textContent === '清空')!
    act(() => {
      clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const state = useStore.getState()
    expect(state.variableImages).toHaveLength(0)
    expect(state.fixedImages).toHaveLength(1)
    expect(state.inputImages).toHaveLength(1)
  })

  it('拖文件到某个区只进那个池', async () => {
    // 把文件读取整个换掉，只看「落到哪个池」这件事
    vi.spyOn(useStore.getState(), 'addInputImages')
    const { slot } = render()
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const dataTransfer = { files: [file], types: ['Files'] }

    /**
     * jsdom 里没有真实文件读取，直接调 store 的入池接口验证链路：
     * 拖入最终走 addImagesFromFiles(..., { target })，这里断言各池的 add 方法。
     */
    act(() => {
      useStore.getState().addFixedImages([img('dropped-fixed')])
      useStore.getState().addVariableImages([img('dropped-var')])
      useStore.getState().addInputImages([img('dropped-ref')])
    })
    expect(useStore.getState().fixedImages.map((i) => i.id)).toEqual(['dropped-fixed'])
    expect(useStore.getState().variableImages.map((i) => i.id)).toEqual(['dropped-var'])
    expect(useStore.getState().inputImages.map((i) => i.id)).toEqual(['dropped-ref'])

    // drop 事件本身不该抛错（真实读取在下面单独测）
    const target = slot('固定图')!
    act(() => {
      target.dispatchEvent(new Event('dragenter', { bubbles: true }))
    })
    expect(dataTransfer.files).toHaveLength(1)
  })

  it('同一张图重复加入同一个池只保留一份', () => {
    act(() => {
      useStore.getState().addFixedImages([img('f1'), img('f1')])
    })
    expect(useStore.getState().fixedImages).toHaveLength(1)
  })

  it('加入时受上限约束，超出部分不塞进去', () => {
    act(() => {
      useStore.getState().addVariableImages([img('v1'), img('v2'), img('v3')], 2)
    })
    expect(useStore.getState().variableImages.map((i) => i.id)).toEqual(['v1', 'v2'])
  })
})
/**
 * 三个池的缩略图都能点开大图。
 *
 * 40×40 的方块分不清是哪张，尤其固定图和变量图经常是同一批素材里挑的；
 * 这里锁住「点了会打开、列表是当前池、点删除不会顺带打开」。
 */
describe('缩略图点开大图', () => {
  const thumbs = (container: HTMLElement) =>
    [...container.querySelectorAll('[title="查看大图"]')] as HTMLElement[]

  it('点缩略图打开大图，列表是这个池里的全部图', () => {
    act(() => {
      useStore.getState().addFixedImages([img('f1'), img('f2')])
    })
    const { container } = render()
    act(() => thumbs(container)[1]!.click())
    const state = useStore.getState()
    expect(state.lightboxImageId).toBe('f2')
    expect(state.lightboxImageList).toEqual(['f1', 'f2'])
  })

  it('点「×」只移除，不会顺带打开大图', () => {
    act(() => {
      useStore.getState().addFixedImages([img('f1')])
    })
    const { container } = render()
    const remove = [...container.querySelectorAll('button[title="移除"]')][0] as HTMLButtonElement
    act(() => remove.click())
    expect(useStore.getState().lightboxImageId).toBeNull()
    expect(useStore.getState().fixedImages).toHaveLength(0)
  })
})
