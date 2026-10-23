import { useEffect } from 'react'

import { startMcpDataSync } from '../lib/mcpDataSync'

/**
 * 外部 Agent 通过 MCP 改了数据后，把界面里的库和任务卡重新载入。
 * 只在客户端里有意义，网页版没有 MCP 服务，startMcpDataSync 会直接返回空函数。
 */
export function useMcpDataSync() {
  useEffect(() => startMcpDataSync(), [])
}
