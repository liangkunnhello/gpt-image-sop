// @vitest-environment node

/**
 * 防回归：Rust 侧每个 #[tauri::command] 都必须在 capabilities 引用的 permissions 里授权。
 *
 * 起因：v1.2.0 新增 MCP 的 4 个命令时只注册进 invoke_handler，没加权限，
 * 打包版调用直接报 "Command mcp_status not allowed by ACL"，前端读不到状态、开关一直禁用。
 * 本机没有 Rust 工具链，这类问题编译期发现不了，只能靠这条静态检查兜住。
 *
 * 用 Vite 的 ?raw glob 读取源码，避免依赖 node:fs（项目没有装 @types/node）。
 */

import { describe, expect, it } from 'vitest'

const rustSources = import.meta.glob('../../src-tauri/src/**/*.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const permissionSources = import.meta.glob('../../src-tauri/permissions/*.toml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const capabilitySources = import.meta.glob('../../src-tauri/capabilities/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Rust 源码里所有 command 函数名 → 所在文件 */
function rustCommands(): Map<string, string> {
  const found = new Map<string, string>()
  for (const [path, text] of Object.entries(rustSources)) {
    const regex = /#\[tauri::command\][\s\S]{0,120}?\bfn\s+([a-z0-9_]+)/g
    for (const match of text.matchAll(regex)) {
      found.set(match[1], path.replace('../../src-tauri/', ''))
    }
  }
  return found
}

/** 每个 permission 文件允许的命令 */
function permissionCommands(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const [path, text] of Object.entries(permissionSources)) {
    const identifier = text.match(/identifier\s*=\s*"([^"]+)"/)?.[1] ?? path.split('/').pop()!.replace('.toml', '')
    const allowed = new Set<string>()
    // commands.allow = [ "a", "b" ]，可能跨行
    for (const block of text.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const item of block[1].matchAll(/"([a-z0-9_]+)"/g)) allowed.add(item[1])
    }
    map.set(identifier, allowed)
  }
  return map
}

/** capability 里启用了哪些 permission（只看字符串形式的自定义权限） */
function enabledPermissions(): string[] {
  const enabled: string[] = []
  for (const text of Object.values(capabilitySources)) {
    const parsed = JSON.parse(text) as { permissions?: unknown[] }
    for (const item of parsed.permissions ?? []) {
      if (typeof item === 'string') enabled.push(item)
    }
  }
  return enabled
}

describe('Tauri 命令权限', () => {
  it('每个 #[tauri::command] 都在已启用的 permission 里授权', () => {
    const commands = rustCommands()
    expect(commands.size).toBeGreaterThan(20)

    const byPermission = permissionCommands()
    const allowed = new Set<string>()
    for (const permission of enabledPermissions()) {
      for (const command of byPermission.get(permission) ?? []) allowed.add(command)
    }

    const missing = [...commands.entries()]
      .filter(([name]) => !allowed.has(name))
      .map(([name, file]) => `${name}（${file}）`)

    expect(
      missing,
      `以下命令没在 capabilities 的权限里授权，打包版会报 not allowed by ACL：\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it('permission 文件都被 capability 引用，避免写了却没生效', () => {
    const enabled = new Set(enabledPermissions())
    const unused = [...permissionCommands().keys()].filter((name) => !enabled.has(name))
    expect(unused, `这些 permission 没被任何 capability 引用：${unused.join(', ')}`).toEqual([])
  })

  it('MCP 的四个命令确实在 mcp 权限里', () => {
    const allowed = permissionCommands().get('mcp')
    expect(allowed).toBeDefined()
    for (const name of ['mcp_status', 'mcp_set_enabled', 'mcp_set_port', 'mcp_rotate_token']) {
      expect(allowed?.has(name), `${name} 不在 mcp 权限里`).toBe(true)
    }
  })
})
