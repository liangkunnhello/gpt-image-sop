// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, getActiveApiProfile } from '../lib/apiProfiles'
import { useStore } from '../store'
import SopEditorModal from './SopEditorModal'

const SOP = ['## SOP 名称', '月亮夜景', '', '## 版式结构', '左侧人物，右侧大字标题。', '', '## 必守与禁忌', '不画按钮。'].join('\n')
const REWRITTEN = SOP.replace('左侧人物', '右侧人物')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement

function setProfile(apiKey: string) {
  // 注意 apiKey 要同时写在顶层：getActiveApiProfile 里顶层字段优先于 profile
  useStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      apiKey,
      baseUrl: 'https://api.example.com/v1',
      profiles: [{ ...DEFAULT_SETTINGS.profiles[0], apiKey, baseUrl: 'https://api.example.com/v1' }],
      activeProfileId: DEFAULT_SETTINGS.profiles[0].id,
    },
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  setProfile('sk-test')
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

/** 让内嵌的模型请求返回指定正文 */
function stubModel(content: string) {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function render(onSave = vi.fn()) {
  await act(async () => {
    root!.render(<SopEditorModal title="月亮夜景" value={SOP} onClose={vi.fn()} onSave={onSave} />)
  })
  return { onSave }
}

const body = () => container.querySelector('textarea') as HTMLTextAreaElement
const aiInput = () => container.querySelector('input[placeholder^="让 AI 怎么改"]') as HTMLInputElement
const findButton = (text: string) => [...container.querySelectorAll('button')]
  .find((btn) => btn.textContent?.trim() === text) as HTMLButtonElement | undefined
const aiButton = () => findButton('AI 修改')!

async function setInput(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 点 AI 修改，等正文出现期望内容 */
async function runAi(expectText: string, timeoutMs = 2000) {
  await setInput(aiInput(), '改一下')
  await act(async () => { aiButton().click() })
  const start = Date.now()
  while (!body().value.includes(expectText) && Date.now() - start < timeoutMs) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  }
}

describe('SOP 编辑弹窗里的 AI 修改', () => {
  it('接口配置里的 Key 在测试环境下是有效的', () => {
    expect(getActiveApiProfile(useStore.getState().settings)?.apiKey).toBe('sk-test')
  })

  it('默认有 AI 输入框和按钮，没填要求时按钮不可点', async () => {
    await render()
    expect(aiInput()).toBeTruthy()
    expect(aiButton().disabled).toBe(true)
  })

  it('填了要求后按钮可用', async () => {
    await render()
    await setInput(aiInput(), '改成白天')
    expect(aiButton().disabled).toBe(false)
  })

  it('改写成功后正文被替换，并出现「撤回改写」', async () => {
    const fetchMock = stubModel(REWRITTEN)
    await render()
    await runAi('右侧人物')
    expect(fetchMock).toHaveBeenCalled()
    expect(body().value).toContain('右侧人物')
    expect(findButton('撤回改写')).toBeTruthy()
  })

  it('「撤回改写」恢复成原文', async () => {
    stubModel(REWRITTEN)
    await render()
    await runAi('右侧人物')
    await act(async () => { findButton('撤回改写')!.click() })
    expect(body().value).toBe(SOP)
  })

  it('保存时写回改写后的正文', async () => {
    stubModel(REWRITTEN)
    const { onSave } = await render()
    await runAi('右侧人物')
    await act(async () => { findButton('保存')!.click() })
    expect(onSave).toHaveBeenCalledWith(expect.stringContaining('右侧人物'))
  })

  it('接口没有 Key 时不发请求', async () => {
    setProfile('')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await render()
    await setInput(aiInput(), '改一下')
    await act(async () => { aiButton().click() })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
