import { listen } from '@tauri-apps/api/event'

import { isTauri } from './platform'
import { useSopStore } from './sopStore'
import { loadTauriStorage } from './tauriStorage'

/** 与 Rust 侧 mcp::CHANGED_EVENT 一致 */
const CHANGED_EVENT = 'mcp-data-changed'
/** 一次操作可能连写多个键，合并成一次刷新 */
const RELOAD_DELAY_MS = 250

/**
 * 外部 Agent 通过 MCP 改了库数据后，界面内存里还是旧值；
 * 这里重新从 SQLite 读一遍并回填，避免下次界面写入把 Agent 的改动覆盖掉。
 */
async function reloadFromStorage() {
  await loadTauriStorage()
  await useSopStore.persist.rehydrate()

  // store 与这里互相引用，用动态 import 打破循环
  const [{ useStore }, { getAllTasks }] = await Promise.all([
    import('../store'),
    import('./db'),
  ])
  const stored = await getAllTasks()
  const current = useStore.getState().tasks
  // 正在跑的任务保留内存里的状态，其余以库为准
  const running = current.filter((task) => task.status === 'running')
  const rest = stored.filter((task) => !running.some((item) => item.id === task.id))
  useStore.getState().setTasks([...running, ...rest])
}

/** 挂上 MCP 数据变更监听，返回取消函数 */
export function startMcpDataSync(): () => void {
  if (!isTauri) return () => {}

  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const subscription = listen(CHANGED_EVENT, () => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      void reloadFromStorage().catch((err) => {
        console.error('MCP 改动后重新载入失败：', err)
      })
    }, RELOAD_DELAY_MS)
  })

  return () => {
    disposed = true
    clearTimeout(timer)
    void subscription.then((fn) => fn()).catch(() => {})
  }
}
