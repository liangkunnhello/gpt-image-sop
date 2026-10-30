import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createUserAbortError,
  isUserAbort,
  linkAbortSignal,
  maybeAppendSizeHint,
  maybeAppendStreamingHint,
  SIZE_UNSUPPORTED_HINT,
  STREAMING_UNSUPPORTED_HINT,
} from './imageApiShared'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('停止生成：中止信号合并', () => {
  it('外部停止立刻 abort，不用等超时', () => {
    const controller = new AbortController()
    const external = new AbortController()
    const cleanup = linkAbortSignal(controller, external.signal, 60_000, () => new Error('timeout'))

    expect(controller.signal.aborted).toBe(false)
    external.abort(createUserAbortError())
    expect(controller.signal.aborted).toBe(true)
    expect((controller.signal.reason as Error).message).toBe('已停止生成')
    cleanup()
  })

  it('超时也会 abort，且原因带超时标识', () => {
    const controller = new AbortController()
    const cleanup = linkAbortSignal(controller, undefined, 5_000, () => new Error('请求超时'))

    vi.advanceTimersByTime(4_999)
    expect(controller.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(controller.signal.aborted).toBe(true)
    expect((controller.signal.reason as Error).message).toBe('请求超时')
    cleanup()
  })

  it('外部信号已经停止时，注册就立刻中止（点了停止才发起请求的竞态）', () => {
    const controller = new AbortController()
    const external = new AbortController()
    external.abort(createUserAbortError())
    const cleanup = linkAbortSignal(controller, external.signal, 60_000, () => new Error('timeout'))
    expect(controller.signal.aborted).toBe(true)
    cleanup()
  })

  it('清理后不再响应外部停止，也不再有定时器', () => {
    const controller = new AbortController()
    const external = new AbortController()
    const cleanup = linkAbortSignal(controller, external.signal, 1_000, () => new Error('timeout'))
    cleanup()

    external.abort(createUserAbortError())
    expect(controller.signal.aborted).toBe(false)
    vi.advanceTimersByTime(2_000)
    expect(controller.signal.aborted).toBe(false)
  })

  it('不传外部信号也能正常工作（只有超时）', () => {
    const controller = new AbortController()
    const cleanup = linkAbortSignal(controller, undefined, 1_000, () => new Error('timeout'))
    vi.advanceTimersByTime(1_000)
    expect(controller.signal.aborted).toBe(true)
    cleanup()
  })
})

describe('区分「用户停止」与「请求失败」', () => {
  it('用户停止的错误能被认出来', () => {
    expect(isUserAbort(createUserAbortError())).toBe(true)
  })

  it('超时不算用户停止（否则会静默吞掉真正的失败）', () => {
    const timeout = new Error('请求超时')
    timeout.name = 'AbortError'
    expect(isUserAbort(timeout)).toBe(false)
  })

  it('普通报错不算用户停止', () => {
    expect(isUserAbort(new Error('接口返回 500'))).toBe(false)
    expect(isUserAbort('字符串错误')).toBe(false)
    expect(isUserAbort(null)).toBe(false)
  })

  it('用户停止的错误名是 AbortError，方便上层按中止处理', () => {
    expect(createUserAbortError().name).toBe('AbortError')
  })
})

/**
 * 「不允许的图片尺寸」是出图尺寸参数被拒，不是参考图太大。
 * 原来这种 400 会被追加「不支持下流式」的提示，方向完全跑偏。
 */
describe('尺寸被拒时给对提示', () => {
  const sizeError = '不允许的图片尺寸 (cch_session_id: sess_abc)'

  it('识别尺寸错误并追加正确提示', () => {
    const message = maybeAppendSizeHint(sizeError)
    expect(message).toContain(SIZE_UNSUPPORTED_HINT)
    expect(message).toContain('与参考图本身的大小无关')
  })

  it('不是尺寸错误时原样返回', () => {
    const other = '模型未开通 (request id: 123)'
    expect(maybeAppendSizeHint(other)).toBe(other)
  })

  it('流式开启时也不会被「不支持下流式」的提示盖掉', () => {
    const message = maybeAppendStreamingHint(sizeError, 400, true)
    expect(message).toContain(SIZE_UNSUPPORTED_HINT)
    expect(message).not.toContain(STREAMING_UNSUPPORTED_HINT)
  })

  it('其它 400 仍然照旧给流式提示', () => {
    const message = maybeAppendStreamingHint('请求参数有误', 400, true)
    expect(message).toContain(STREAMING_UNSUPPORTED_HINT)
  })
})
