/**
 * 给外部 Coding 工具用的 SKILL.md。
 *
 * 内容是写给「要操作这个生图工作台的 Agent」看的操作说明，不是给人类看的产品介绍：
 * 只讲什么时候用哪个工具、参数怎么填、有哪些坑。
 */

export const MCP_SKILL_FILE_NAME = 'SKILL.md'

export function buildSkillMarkdown(): string {
  return `---
name: gpt-image-sop
description: 通过 MCP 操作 GPT Image SOP 生图工作台——查方向树、卖点、风格、SOP 与任务卡，也能直接出图。当用户要按已有 SOP 批量出图、查历史任务卡、维护卖点与方向树时使用。
---

# GPT Image SOP

本机桌面应用「GPT Image SOP」通过 MCP 暴露了生图工作台的数据与出图能力。应用需要在运行中（服务跑在应用进程里）。

## 先搞清楚当前有什么

1. \`get_settings\` —— 看当前用哪个接口、哪个模型、出图尺寸。
2. \`get_library\` —— 看方向树、卖点、风格、系统提示词。默认只有名称摘要，要看正文传 \`include_content: true\`。
3. \`list_tasks\` —— 看历史任务卡，用 \`keyword\` / \`direction_id\` / \`status\` 过滤。

## 出图

\`generate_image\` 直接按提示词出图，返回本地文件路径。

- \`prompt\` 必须是一条完整、自洽的画面描述：版式、场景、人物、色调、光线，图上要出现的文字用「」包裹。
- 一次要出多张就传 \`count\`，但**多张共用同一条 prompt**，模型只是采样不同。要真正不同的构图，就分多次调用、每次写不同的 prompt。
- 出图可能耗时一到几分钟，别在同一轮里连续堆十几个调用。
- 只有 OpenAI 兼容接口能通过 MCP 出图；用 fal.ai 等渠道时先在应用里切换配置，或改用应用界面出图。

## 维护库数据

- \`upsert_direction\`：不传 \`id\` 是新建，传 \`id\` 是修改。层级由 \`parent_id\` 决定，顶层分类才是 \`null\`；\`product\` 和 \`direction\` 必须挂在父节点下。
- \`upsert_preset\`：卖点（\`kind: point\`）和风格（\`kind: style\`）都挂在产品节点下，同一产品所有方向共享。**卖点是要逐字印在图上的文字，改写会直接改到出图上**，改动前先跟用户确认。
- \`delete_direction\` 是伪删除，进回收站，可在应用里恢复。
- \`delete_task\` 是真删除，不可恢复，执行前必须跟用户确认。

## 注意

- 改动库数据会立即影响应用里正在使用它的界面，写之前先确认改的是对的节点。
- 不要把 API 密钥写进提示词或卖点里。
- 任务卡的出图记录里只有图片 id，需要图片文件时用应用界面导出。
`
}
