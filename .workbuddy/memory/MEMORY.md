# 项目长期约定

## 代码提交（强制）

**gpt_image_playground 每次改动完成后必须立即提交并推送**，保证随时可回档。

```bash
cd C:/Users/admin/Videos/gpt_image_playground
git add -A
git commit -m "..."        # 中文，逐条写清改了什么
git push mine main
```

- 推送 remote 用 `mine`（`origin` 是上游 ghproxy 镜像，不要推）。
- 仓库：https://github.com/liangkunnhello/gpt-image-sop （PUBLIC）
- 提交信息按「feat: / fix: / style:」开头，正文用中文列出具体改动点。
- 改完先跑 `npx tsc -b` 确认类型通过再提交。
- 不要提交 `.env`、密钥、`node_modules`。

## 目录结构（2026-10-20 合并后）

全部收在 `C:/Users/admin/Videos/gpt_image_playground`：
- `src/`、`src-tauri/`：界面（React 19 + Vite + Tauri）
- `cli/app/`：本地验收服务（端口 7799，`cli/启动.bat` 启动）
- `cli/src/`：命令行生图
- `cli/tools/`：python 脚本（clip_similarity、push_to_client、qc 等）
- `scripts/`：发布辅助（git-api-push / git-release，走 GitHub API 绕过 502）
- 旧的 `C:/Users/admin/Videos/gpt-image-cli` 只剩 `.workbuddy` 和 MIGRATED.md

## 本地服务

`cd gpt_image_playground/cli && node app/server.mjs`（必须 run_in_background，用 `( ... &)` 会被回收）。

## 技术约束

- 项目代码规范见 `gpt_image_playground/AGENTS.md`：2 空格、单引号、无分号、中文注释。
- `db.ts` 是双后端（网页 IndexedDB / 客户端 SQLite），新增存储优先用 localStorage 或复用 `TaskRecord` 字段，避免改 schema。
- 渠道尺寸限制：短边 ≥ 1024、长边 ≤ 4096（`src/lib/sizeCapability.ts`）。
- 质检模型 `deepseek-v4.1-flash`，必须带 `thinking: {type:'disabled'}`（否则默认走思考模式）。
