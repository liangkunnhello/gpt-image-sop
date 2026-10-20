# gpt-image-cli

GPT Image 2 的命令行生图工具，无第三方依赖（Node 18+ 内置 `fetch`/`FormData`），可直接被 WorkBuddy Skill 调用。

> 不是 `CookSleep/gpt_image_playground` 的 fork。playground 是纯前端 SPA，本工具按它调用的同一套 OpenAI 接口协议重写为命令行形态，砍掉了只能在图形界面存在的功能（见「能力边界」）。

## 快速开始

```bash
cd gpt-image-cli
cp .env.example .env          # 填 BASE_URL / API_KEY（Windows 可直接新建 .env）
node src/cli.mjs config       # 确认配置生效、Key 已脱敏
node src/cli.mjs gen "一只戴耳机的橘猫，扁平插画风" --ratio 16:9 --res 2k
```

产物默认落在 `./out/<时间戳>-01.png`，历史写入 `~/.gpt-image-cli/history.jsonl`。

## 常用命令

| 需求 | 命令 |
|---|---|
| 文生图 | `gpt-image gen "提示词" --size 1024x1024 --quality high` |
| 指定比例 | `gpt-image gen "提示词" --ratio 16:9 --res 2k` |
| 参考图改图 | `gpt-image edit "改成水彩风格" -i photo.png` |
| 多图合成 | `gpt-image edit "把这两个产品合成一张海报" -i a.png -i b.png` |
| 局部重绘 | `gpt-image edit "把背景换成海边" -i room.png --mask mask.png` |
| 批量出图 | `gpt-image gen --prompt-file prompts.txt --n 2 --concurrency 15` |
| 多配置切换 | `gpt-image gen "..." --profile relay` |
| 看历史 | `gpt-image list --limit 10` |
| 只验请求不发网络 | `gpt-image gen "..." --dry-run --json` |

## 配置优先级

`CLI 参数` > `进程环境变量` > `当前目录 .env` > `~/.gpt-image-cli/.env` > `~/.gpt-image-cli/config.json` 的 profile > 默认值

环境变量名：`GPT_IMAGE_BASE_URL` / `GPT_IMAGE_API_KEY` / `GPT_IMAGE_MODEL` / `GPT_IMAGE_API_MODE` / `GPT_IMAGE_SIZE` / `GPT_IMAGE_QUALITY` / `GPT_IMAGE_OUT`（兼容 `OPENAI_API_BASE`、`OPENAI_API_KEY`）。

多供应商可写 `~/.gpt-image-cli/config.json`：

```json
{
  "default": "main",
  "profiles": {
    "main":  { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "gpt-image-2" },
    "relay": { "baseUrl": "https://your-relay.example/v1", "apiKey": "sk-...", "model": "gpt-image-2", "quality": "medium" }
  }
}
```

## 与 GPT Image Playground 客户端共用数据

本机客户端（`%LOCALAPPDATA%\GPT Image Playground\`）用 SQLite 存历史，CLI 可直接把记录写进去：

```bash
gpt-image sync --dry-run    # 先看计划
gpt-image sync              # 执行（自动备份 data.db）
```

- **单向**：CLI → 客户端。客户端里的历史不会反向进入 CLI。
- 图片按 **SHA-256 命名**（与客户端一致），同图重复同步不会占两份空间；任务按 `prompt + createdAt` 去重，可反复执行。
- 只做 `INSERT OR IGNORE`，不 UPDATE / 不 DELETE。写入前备份到 `data\backup-pre-cli-sync\<时间戳>\`。
- 客户端在运行也能写（WAL 模式），但**界面需重启或切页刷新**才显示新记录。
- 依赖 Python + Pillow（生成同尺寸 webp 缩略图）；无 Pillow 时加 `--skip-thumb`，缩略图由客户端自行补。
- 客户端数据库 schema 版本为 2（`tasks / images / thumbnails / kv / meta`），升级客户端后若改表需同步调整脚本。

回滚：关闭客户端 → 用备份目录里的 `data.db`、`data.db-wal`、`data.db-shm` 覆盖回 `data\`。

## 尺寸规则

- `--size` 支持 `1024x1024` 或 `1k` / `2k` / `4k` 方形
- `--ratio 16:9 --res 2k` 按面积等值换算（16:9@2k → `2736x1536`）
- 所有尺寸自动规整为 **16 的倍数** 并夹取到 **512~4096**
- 4K + high 单张常见 60~180 秒，`--timeout` 默认 300 秒

## 并发

`--concurrency N` 控制同时在途的请求数，默认 1（串行）。当前中转站（`ai-claude-code-hub.jetmobo.com`）实测支持 **15 并发**，超过易触发 429。

参考基线：1024x1536 / high，单张 22~36 秒；10 张以并发 3 跑完约 1 分 50 秒。

## 批量命名

`--prompt-file` 模式下每条提示词的产出自动带序号后缀：`--name sweet10` → `sweet10-01-01.png … sweet10-10-01.png`（前者是提示词序号，后者是 `--n` 的图序号），不会互相覆盖。

## 能力边界（相对 playground 砍掉的部分）

| playground 有 | 本 CLI 处理方式 |
|---|---|
| 画板标注（画笔/文字/图形/橡皮擦） | 不支持，需先在外部生成 `mask.png` |
| 可视化遮罩编辑器 | 传 `--mask` 现成 PNG，透明区为可编辑区 |
| 瀑布流画廊、拖拽框选 | `gpt-image list` 文本历史 |
| 流式中间图预览 | 无，只有最终结果与耗时 |
| IndexedDB 加密去重 | 文件落盘 + `history.jsonl` |
| fal.ai / sub2api 异步队列 | v0.1 未实现，仅 OpenAI 兼容的 Images / Responses |

## 排错

| 现象 | 原因 |
|---|---|
| `401` | Key 错误，或无该模型权限 |
| `403` | 组织未完成验证，gpt-image 系模型通常要求 verified org |
| `404` | Base URL 少写 `/v1`，或该供应商不提供 `/images/edits` |
| `400 size` | 供应商限制了尺寸集合，改用 `--size 1024x1024` 试 |
| 响应无图片 | 用 `--json` 看原始返回，可能是内容审核拦截 |
