// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_PARAMS, type TaskParams } from '../../types'
import { DEFAULT_SETTINGS } from '../../lib/apiProfiles'
import InputParamsPanel from './inputParamsPanel'

/**
 * 「更多」面板里新增的「后处理」下拉：决定出图后要不要套后处理模板。
 * 这里只锁住界面这一层：这一行在不在、能不能改、摘要会不会跟着变。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

/** 提示气泡的占位状态，面板只读 visible / 事件 */
const hint = () => ({ visible: false, show: () => {}, hide: () => {}, clearTimer: () => {}, startTouch: () => {} })

function unmount() {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
}

function renderPanel({ postProcessEnabled = true, postProcessAvailable = true } = {}) {
  unmount()
  const patches: Array<Partial<TaskParams>> = []
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <InputParamsPanel
        params={DEFAULT_PARAMS}
        setParams={(patch) => patches.push(patch)}
        activeProfile={DEFAULT_SETTINGS.profiles[0]}
        modelOptions={[{ label: 'gpt-image-1', value: 'gpt-image-1' }]}
        onModelChange={() => {}}
        isFalProvider={false}
        isFalTextToImage={false}
        displaySize="auto"
        qualityOptions={[{ label: 'auto', value: 'auto' }]}
        selectClass=""
        transparentOutputAvailable={false}
        showTransparentOutputControl={false}
        transparentOutputEnabled={false}
        transparentOutputHint={hint()}
        onTransparentOutputMenuOpenChange={() => {}}
        compressionHint={hint()}
        compressionDisabled={false}
        outputCompressionInput=""
        setOutputCompressionInput={() => {}}
        commitOutputCompression={() => {}}
        moderationHint={hint()}
        moderationDisabled={false}
        postProcessEnabled={postProcessEnabled}
        postProcessAvailable={postProcessAvailable}
        postProcessHint={hint()}
        agentAutoImageCount={false}
        outputImageLimit={10}
        nInput="1"
        setNInputFocused={() => {}}
        commitN={() => {}}
        handleNInputChange={() => {}}
        handleNLimitIncreaseAttempt={() => {}}
        showAgentNHint={() => {}}
        hideNLimitHint={() => {}}
        startAgentNHintTouch={() => {}}
        clearAgentNHintTouchTimer={() => {}}
        nLimitHint={hint()}
        nLimitHintText=""
        streamConcurrentByN={false}
        streamConcurrentHint={hint()}
        sizeHint={hint()}
        qualityHint={hint()}
        onOpenSizePicker={() => {}}
        showBatch={false}
        batchEnabled={false}
        batchMode="queue"
        batchConcurrencyLimited={false}
        batchConcurrency={1}
        batchPromptCount={0}
        batchProgress={null}
        onBatchChange={() => {}}
        onStopBatch={() => {}}
      />,
    )
  })
  return { container, patches }
}

function click(element: Element | null) {
  expect(element).not.toBeNull()
  act(() => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** 展开「更多」弹层，返回后处理那一行 */
function openMore(container: HTMLElement) {
  click(container.querySelector('[aria-expanded]'))
  const label = [...container.querySelectorAll('span')].find((node) => node.textContent === '后处理')
  expect(label).toBeTruthy()
  return label!.closest('div') as HTMLElement
}

describe('InputParamsPanel 的「后处理」下拉', () => {
  it('「更多」里有后处理这一行，默认显示开启', () => {
    const { container } = renderPanel()
    const row = openMore(container)
    expect(row.textContent).toContain('开启')
  })

  it('选「关闭」时提交 post_process: false', () => {
    const { container, patches } = renderPanel()
    const row = openMore(container)
    click(row.querySelector('[class*="select-none"]'))
    click(container.querySelector('[data-option-value="off"]'))
    expect(patches).toEqual([{ post_process: false }])

    // 再切回开启要显式写 true，不能靠「字段不存在」来表达
    click(row.querySelector('[class*="select-none"]'))
    click(container.querySelector('[data-option-value="on"]'))
    expect(patches).toEqual([{ post_process: false }, { post_process: true }])
  })

  it('关掉后折叠状态的摘要有提示，开启时不占位', () => {
    expect(renderPanel({ postProcessEnabled: false }).container.textContent).toContain('后处理 关')
    expect(renderPanel({ postProcessEnabled: true }).container.textContent).not.toContain('后处理')
  })

  it('当前方向没有启用的模板时也照样能改（先设好，之后配了模板就生效）', () => {
    const { container, patches } = renderPanel({ postProcessAvailable: false })
    const row = openMore(container)
    click(row.querySelector('[class*="select-none"]'))
    click(container.querySelector('[data-option-value="off"]'))
    expect(patches).toEqual([{ post_process: false }])
  })
})
