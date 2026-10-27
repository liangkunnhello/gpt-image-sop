import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shortTaskId, taskIdCopyText, taskIdLabel } from './taskId'

const showToast = vi.fn()
const copyTextToClipboard = vi.fn()

vi.mock('../store', () => ({
  useStore: { getState: () => ({ showToast }) },
}))
vi.mock('./clipboard', () => ({
  copyTextToClipboard: (...args: unknown[]) => copyTextToClipboard(...args),
  getClipboardFailureMessage: (fallback: string) => fallback,
}))

describe('任务 ID 展示', () => {
  it('长 id 只取尾部，短 id 原样返回', () => {
    // m3k2j1a5f3x2q 共 13 位，尾部 6 位是 5f3x2q
    expect(shortTaskId('m3k2j1a5f3x2q')).toBe('5f3x2q')
    expect(shortTaskId('m3k2j1a5f3x2q')).toHaveLength(6)
    expect(shortTaskId('abcdef', 6)).toBe('abcdef')
    expect(shortTaskId('abc', 6)).toBe('abc')
  })

  it('先 trim，空 id 返回空串，长度兜底至少 1 位', () => {
    expect(shortTaskId('  abcdefgh  ')).toBe('cdefgh')
    expect(shortTaskId('')).toBe('')
    expect(shortTaskId('   ')).toBe('')
    // 长度传 0 / 负数时不能返回空串，否则卡片上会剩一个空标签
    expect(shortTaskId('abcdef', 0)).toBe('f')
    expect(shortTaskId('abcdef', -2)).toBe('f')
  })

  it('展示形态带 # 前缀，复制内容是完整 id', () => {
    expect(taskIdLabel('m3k2j1a5f3x2q')).toBe('#5f3x2q')
    expect(taskIdLabel('')).toBe('')
    expect(taskIdCopyText('  m3k2j1a5f3x2q ')).toBe('m3k2j1a5f3x2q')
  })
})

describe('复制任务 ID', () => {
  beforeEach(() => {
    showToast.mockReset()
    copyTextToClipboard.mockReset()
  })

  it('复制成功时提示里带完整 id', async () => {
    copyTextToClipboard.mockResolvedValue(undefined)
    const { copyTaskIdToClipboard } = await import('./copyTaskId')

    expect(await copyTaskIdToClipboard('m3k2j1a5f3x2q')).toBe(true)
    expect(copyTextToClipboard).toHaveBeenCalledWith('m3k2j1a5f3x2q')
    expect(showToast).toHaveBeenCalledWith('已复制任务 ID：m3k2j1a5f3x2q', 'success')
  })

  it('复制失败时提示错误，不抛给调用方', async () => {
    copyTextToClipboard.mockRejectedValue(new Error('denied'))
    const { copyTaskIdToClipboard } = await import('./copyTaskId')

    expect(await copyTaskIdToClipboard('abc123')).toBe(false)
    expect(showToast).toHaveBeenCalledWith('复制任务 ID 失败，请手动选中复制', 'error')
  })

  it('空 id 不碰剪贴板', async () => {
    const { copyTaskIdToClipboard } = await import('./copyTaskId')

    expect(await copyTaskIdToClipboard('  ')).toBe(false)
    expect(copyTextToClipboard).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })
})
