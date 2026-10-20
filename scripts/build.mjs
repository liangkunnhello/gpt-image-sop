#!/usr/bin/env node
/**
 * 构建生产包。
 *
 * esbuild 会在系统临时目录里建临时文件再删掉，Windows 上常被安全删除守卫拦下
 * （Access is denied）。这里把临时目录换到项目内的 .tmp-build，构建就不会中断。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const tmp = path.resolve('.tmp-build')
mkdirSync(tmp, { recursive: true })

const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
})
process.exit(result.status ?? 1)
