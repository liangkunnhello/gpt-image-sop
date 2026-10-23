import { call } from './dbTauri'

/** 与 Rust 侧 McpStatus 对应 */
export interface McpStatus {
  /** 配置里是否勾了开启 */
  enabled: boolean
  /** 服务是否真的在监听 */
  running: boolean
  port: number
  /** 运行中时为 http://127.0.0.1:<port>/mcp，未运行为空 */
  url: string
  token: string
  requests: number
  lastRequestAt: number | null
  /** 启动失败的原因 */
  error: string | null
}

export function getMcpStatus(): Promise<McpStatus> {
  return call<McpStatus>('mcp_status')
}

export function setMcpEnabled(enabled: boolean): Promise<McpStatus> {
  return call<McpStatus>('mcp_set_enabled', { enabled })
}

export function setMcpPort(port: number): Promise<McpStatus> {
  return call<McpStatus>('mcp_set_port', { port })
}

export function rotateMcpToken(): Promise<McpStatus> {
  return call<McpStatus>('mcp_rotate_token')
}

/** 服务名：写进客户端配置的键名 */
export const MCP_SERVER_KEY = 'gpt-image-sop'

/** 带令牌的完整地址，客户端直接填这个 */
export function mcpEndpoint(status: McpStatus): string {
  if (!status.running) return ''
  return `${status.url}?token=${status.token}`
}

/** HTTP 形式的客户端配置 */
export function httpConfig(status: McpStatus): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_KEY]: {
          type: 'http',
          url: mcpEndpoint(status),
        },
      },
    },
    null,
    2,
  )
}

/**
 * stdio 形式的客户端配置。
 * 应用本身没有可当 stdio 用的可执行文件，用 npx 上的 mcp-remote 把 stdio 桥到本地 HTTP。
 */
export function stdioConfig(status: McpStatus): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_KEY]: {
          command: 'npx',
          args: ['-y', 'mcp-remote', mcpEndpoint(status)],
        },
      },
    },
    null,
    2,
  )
}

/** 把状态拼成一段能直接读的说明，复制失败时给用户兜底 */
export function plainEndpoint(status: McpStatus): string {
  if (!status.running) return '服务未启动'
  return mcpEndpoint(status)
}
