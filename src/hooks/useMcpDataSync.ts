import { useEffect } from 'react'

import { startMcpBridge } from '../lib/mcpBridge'
import { startMcpDataSync } from '../lib/mcpDataSync'

/**
 * MCP 的两条通道：
 * - 数据变更（startMcpDataSync）：外部 Agent 直接改了库，界面要把内存里的旧值换掉；
 * - 指令执行（startMcpBridge）：出图 / 重试 / 停止这类操作交给界面跑，
 *   等价于人工点一遍，任务卡和进度都留在界面上。
 *
 * 都只在客户端里有意义：网页版没有 MCP 服务，两个 start 都会直接返回空函数。
 */
export function useMcpDataSync() {
  useEffect(() => startMcpDataSync(), [])
  useEffect(() => startMcpBridge(), [])
}
