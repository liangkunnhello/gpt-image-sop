import { useEffect, useRef } from 'react'

/**
 * 全局 Delete / Backspace 栈，语义同 useCloseOnEscape：只有栈顶那层响应。
 *
 * 为什么必须是栈：详情页开着、灯箱也开着时，按 Delete 只应该动「当前正在看的那张图」，
 * 不能同时触发下层、更不能把两层都关掉。
 */
const deleteStack: Array<{ id: number; handler: () => void }> = []
let nextId = 0

function globalKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  if (deleteStack.length === 0) return
  // 正在输入框里按退格不能当成删除图片
  const target = e.target as HTMLElement | null
  if (target) {
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
  }
  e.preventDefault()
  deleteStack[deleteStack.length - 1].handler()
}

let listenerAttached = false
function ensureListener() {
  if (listenerAttached) return
  listenerAttached = true
  window.addEventListener('keydown', globalKeyDown)
}

/**
 * 注册「按删除键」的处理。
 *
 * @param enabled 是否生效（没选中图片、正在生成时传 false）
 * @param onDelete 按下时的动作
 */
export function useDeleteKey(enabled: boolean, onDelete: () => void) {
  const idRef = useRef<number | null>(null)
  const handlerRef = useRef(onDelete)
  handlerRef.current = onDelete

  useEffect(() => {
    if (!enabled) {
      if (idRef.current !== null) {
        const idx = deleteStack.findIndex((item) => item.id === idRef.current)
        if (idx !== -1) deleteStack.splice(idx, 1)
        idRef.current = null
      }
      return
    }
    ensureListener()
    const id = nextId++
    idRef.current = id
    deleteStack.push({ id, handler: () => handlerRef.current() })
    return () => {
      const idx = deleteStack.findIndex((item) => item.id === id)
      if (idx !== -1) deleteStack.splice(idx, 1)
      idRef.current = null
    }
  }, [enabled])
}
