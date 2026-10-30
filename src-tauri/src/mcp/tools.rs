//! MCP 工具实现。
//!
//! 数据来源与应用本身完全一致：`tasks` 表存任务卡，`gpt-image-sop-store` 这个 kv
//! 存方向树 / 卖点 / 风格 / 系统提示词，`gpt-image-playground` 这个 kv 存接口配置。
//! 写入后发 `mcp-data-changed` 事件，让界面重新载入，避免内存里的旧数据把改动覆盖掉。

use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::mcp::bridge::Bridge;

use crate::storage::{ext_for_mime, file_stem, now_ms, FileMeta, Kind, Storage, TASKS};

/// 库数据的 kv 键（与前端 zustand persist 的 name 一致）
const SOP_KEY: &str = "gpt-image-sop-store";
const APP_KEY: &str = "gpt-image-playground";
/// 写入后通知前端重新载入
pub const CHANGED_EVENT: &str = "mcp-data-changed";

pub struct Ctx {
    pub storage: Option<Arc<Storage>>,
    pub app: Option<tauri::AppHandle>,
}

impl Ctx {
    /// 单元测试用：没有存储也没有窗口，工具调用会返回明确错误
    pub fn for_test() -> Self {
        Self {
            storage: None,
            app: None,
        }
    }

    fn storage(&self) -> Result<Arc<Storage>, String> {
        self.storage
            .clone()
            .ok_or_else(|| "数据目录不可用（存储未初始化），无法读写库数据".to_string())
    }

    fn notify(&self) {
        if let Some(app) = &self.app {
            let _ = app.emit(CHANGED_EVENT, json!({ "at": now_ms() }));
        }
    }
}

// ===== 参数读取小工具 =====

fn as_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn as_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn required(args: &Value, key: &str) -> Result<String, String> {
    as_str(args, key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("缺少必填参数 {key}"))
}

// ===== kv 读写 =====

/// 读一个 kv 并解析成 JSON；键不存在时返回 None
fn read_kv(storage: &Storage, key: &str) -> Result<Option<Value>, String> {
    let all = storage.kv_get_all().map_err(|e| e.to_string())?;
    match all.get(key) {
        None => Ok(None),
        Some(raw) => serde_json::from_str(raw)
            .map(Some)
            .map_err(|err| format!("{key} 的内容不是合法 JSON：{err}")),
    }
}

fn write_kv(storage: &Storage, key: &str, value: &Value) -> Result<(), String> {
    storage
        .kv_set(key, &value.to_string())
        .map_err(|e| e.to_string())
}

/// zustand persist 的格式是 { state, version }，改数据只动 state
fn sop_state(storage: &Storage) -> Result<Value, String> {
    let doc = read_kv(storage, SOP_KEY)?.unwrap_or_else(|| json!({ "state": {}, "version": 0 }));
    doc.get("state")
        .cloned()
        .ok_or_else(|| format!("{SOP_KEY} 里没有 state 字段，可能不是本应用的库数据"))
}

fn save_sop_state(storage: &Storage, mut doc: Value, state: Value) -> Result<(), String> {
    if doc.get("state").is_none() {
        doc = json!({ "state": {}, "version": 0 });
    }
    doc["state"] = state;
    write_kv(storage, SOP_KEY, &doc)
}

/// 取某个数组字段（找不到时返回空数组）
fn array_of(state: &Value, key: &str) -> Vec<Value> {
    state
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", now_ms())
}

// ===== 工具定义 =====

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "get_library",
            "description": "读取工作台的库数据：方向树、卖点与风格、系统提示词、后处理模板。默认只返回名称等摘要，需要正文时把 include_content 设为 true。postTemplates 以节点 id 为键：产品上的是通用模板，方向上的是方向专属模板（该方向配了专属模板后不再套用产品模板）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["all", "directions", "presets", "system_prompts", "post_templates"],
                        "description": "要读哪部分，默认 all"
                    },
                    "include_content": { "type": "boolean", "description": "是否带上正文（卖点/风格/系统提示词的 content）" }
                }
            }
        }),
        json!({
            "name": "list_tasks",
            "description": "列出任务卡（生图记录），按创建时间倒序。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "最多返回多少条，默认 20" },
                    "status": { "type": "string", "description": "只看某个状态：running / done / error" },
                    "direction_id": { "type": "string", "description": "只看某个方向下的任务卡" },
                    "keyword": { "type": "string", "description": "在提示词里做包含匹配" }
                }
            }
        }),
        json!({
            "name": "get_task",
            "description": "取单张任务卡的完整内容，包含提示词、参数、SOP 全文与出图 id。",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "任务卡 id" } },
                "required": ["id"]
            }
        }),
        json!({
            "name": "get_settings",
            "description": "查看当前出图配置（接口名称、模型、尺寸等）。不会返回密钥。",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "upsert_direction",
            "description": "新建或修改方向树节点。不传 id 就是新建，传 id 就是修改。层级由 parent_id 决定：顶层分类的 parent_id 留空或 null。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "要修改的节点 id；新建时不要传" },
                    "name": { "type": "string", "description": "节点名称" },
                    "parent_id": { "type": ["string", "null"], "description": "父节点 id，顶层为 null" },
                    "kind": { "type": "string", "enum": ["category", "product", "direction"], "description": "节点类型，新建时必填" }
                },
                "required": ["name"]
            }
        }),
        json!({
            "name": "delete_direction",
            "description": "把方向节点移进回收站（伪删除，可在应用里恢复）。",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "节点 id" } },
                "required": ["id"]
            }
        }),
        json!({
            "name": "upsert_preset",
            "description": "新建或修改卖点 / 风格预设。预设挂在产品节点下，同一产品所有方向共享。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "要修改的预设 id；新建时不要传" },
                    "kind": { "type": "string", "enum": ["point", "style"], "description": "point=卖点，style=风格" },
                    "name": { "type": "string", "description": "预设名称" },
                    "content": { "type": "string", "description": "预设正文" },
                    "product_id": { "type": "string", "description": "所属产品节点 id，新建时必填" }
                },
                "required": ["kind", "name", "content"]
            }
        }),
        json!({
            "name": "delete_task",
            "description": "删除一张任务卡（连同它的出图记录）。不可恢复。",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "任务卡 id" } },
                "required": ["id"]
            }
        }),
        json!({
            "name": "generate_image",
            "description": "直接用当前配置的接口出一张或多张图，图片存进应用图库并返回本地文件路径。只支持 OpenAI 兼容的 images 接口。出图可能需要一到几分钟。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "完整画面描述，图上文字用「」包裹" },
                    "count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "出几张，默认 1" },
                    "size": { "type": "string", "description": "尺寸，例如 1024x1024；不传用应用当前设置" },
                    "profile_id": { "type": "string", "description": "用哪个接口配置出图，不传用当前选中的" }
                },
                "required": ["prompt"]
            }
        }),
        // ===== 走界面流水线的操作 =====
        //
        // 下面这几个不是后端直接改库，而是让界面照常跑一遍（等价于人工点按钮）：
        // 会建任务卡、走同一套提示词拼装与渠道校验，用户在界面上能看到全过程。
        json!({
            "name": "submit_plain_image",
            "description": "普通模式出图：把提示词和参考图塞进输入框然后点发送（等价人工操作）。任务卡会出现在界面上，返回任务 id，出图结果用 list_tasks 查。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "提示词原文；图上文字用「」包裹" },
                    "image_ids": { "type": "array", "items": { "type": "string" }, "description": "参考图在图库里的 id；不传就是纯文生图" },
                    "count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "一次要几张，默认 1" },
                    "size": { "type": "string", "description": "尺寸，例如 1536x2048；不传用应用当前设置" },
                    "direction_id": { "type": "string", "description": "归属方向 id，出图会落到这个方向下" },
                    "copy_text": { "type": "string", "description": "本次文案（图上文字的唯一来源），会排进提示词" }
                },
                "required": ["prompt"]
            }
        }),
        json!({
            "name": "submit_sop_images",
            "description": "SOP 模式出图：按一份 SOP 先写 N 条提示词再逐条出图（等价人工点发送）。可以给存档 SOP 的 id，也可以直接传 SOP 正文；返回任务 id 列表，进度用 list_tasks 看。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "saved_sop_id": { "type": "string", "description": "SOP 库里某份存档的 id（get_library 能拿到）" },
                    "sop_text": { "type": "string", "description": "直接给 SOP 正文；和 saved_sop_id 二选一" },
                    "system_prompt_id": { "type": "string", "description": "用哪个系统提示词来反推（不给存档 SOP 时才用）" },
                    "point_preset_id": { "type": "string", "description": "卖点预设 id：卖点会逐字进提示词" },
                    "prompts_per_group": { "type": "integer", "minimum": 1, "maximum": 50, "description": "这一批写几条提示词，默认 1" },
                    "group_count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "参考图分成几张卡，默认 1" },
                    "image_ids": { "type": "array", "items": { "type": "string" }, "description": "参考图 id（只用于反推 SOP，不进生图接口）" },
                    "fixed_image_ids": { "type": "array", "items": { "type": "string" }, "description": "固定图 id：图生图的基底，每条提示词都带" },
                    "variable_image_ids": { "type": "array", "items": { "type": "string" }, "description": "变量图 id：图生图逐条轮换" },
                    "image_fidelity": { "type": "string", "enum": ["layout", "product", "style"], "description": "底图保真档：layout 保版式只换文案 / product 保产品 / style 只借风格，默认 layout" },
                    "direction_id": { "type": "string", "description": "归属方向 id" },
                    "copy_text": { "type": "string", "description": "本次文案（排在该方向卖点前面）" }
                }
            }
        }),
        json!({
            "name": "submit_variable_images",
            "description": "变量模式出图：按变量提示词提取骨架与取值，逐条填词后出图（等价人工点发送）。图生图可同时给固定图与变量图。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "variable_prompt_id": { "type": "string", "description": "变量提示词 id（get_library 能拿到）" },
                    "variable_prompt_text": { "type": "string", "description": "直接给变量提示词正文；和 id 二选一" },
                    "prompts_per_card": { "type": "integer", "minimum": 1, "maximum": 50, "description": "每张卡几条，默认 1" },
                    "group_count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "分几张卡，默认 1" },
                    "image_ids": { "type": "array", "items": { "type": "string" }, "description": "参考图 id（只用于提取策略）" },
                    "fixed_image_ids": { "type": "array", "items": { "type": "string" }, "description": "固定图 id：每条提示词都带上" },
                    "variable_image_ids": { "type": "array", "items": { "type": "string" }, "description": "变量图 id：逐条轮换" },
                    "direction_id": { "type": "string", "description": "归属方向 id" },
                    "copy_text": { "type": "string", "description": "本次文案" }
                }
            }
        }),
        json!({
            "name": "retry_task",
            "description": "重试一张失败/中断的任务卡（走界面的重试逻辑，按设置里「重试方式」决定覆盖还是新建）。",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string", "description": "任务 id" } },
                "required": ["task_id"]
            }
        }),
        json!({
            "name": "stop_task",
            "description": "停止一张正在生成的任务卡（真掐断请求，和界面上点停止一致）。",
            "inputSchema": {
                "type": "object",
                "properties": { "task_id": { "type": "string", "description": "任务 id" } },
                "required": ["task_id"]
            }
        }),
        json!({
            "name": "resume_tasks",
            "description": "断点继续：把中断 / 软件被关掉后没跑完的任务按原提示词、原参数接着跑（和列表顶部那条「继续」一致）。",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "get_skill",
            "description": "取这个工作台的 SKILL.md：三种模式（普通 / SOP / 变量）的使用方法、工具清单与踩坑提醒。第一次接入时先读它。",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

// ===== 分发 =====

pub fn call(ctx: &Ctx, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "get_library" => get_library(ctx, args),
        "list_tasks" => list_tasks(ctx, args),
        "get_task" => get_task(ctx, args),
        "get_settings" => get_settings(ctx),
        "upsert_direction" => upsert_direction(ctx, args),
        "delete_direction" => delete_direction(ctx, args),
        "upsert_preset" => upsert_preset(ctx, args),
        "delete_task" => delete_task(ctx, args),
        "generate_image" => generate_image(ctx, args),
        // 下面几个都交给界面执行：等价于人工在界面上点一遍，任务卡、日志、进度都留得下
        "submit_plain_image" => call_front(ctx, "submit_plain", args.clone()),
        "submit_sop_images" => call_front(ctx, "submit_sop", args.clone()),
        "submit_variable_images" => call_front(ctx, "submit_variable", args.clone()),
        "retry_task" => {
            let task_id = required(args, "task_id")?;
            call_front(ctx, "retry_task", json!({ "task_id": task_id }))
        }
        "stop_task" => {
            let task_id = required(args, "task_id")?;
            call_front(ctx, "stop_task", json!({ "task_id": task_id }))
        }
        "resume_tasks" => call_front(ctx, "resume_tasks", json!({})),
        "get_skill" => call_front(ctx, "get_skill", json!({})),
        other => Err(format!("未知工具：{other}")),
    }
}

/// 交给界面执行（等价于人工在界面上点一遍），返回界面给的结果。
///
/// 走这条路的工具都要依赖前端流水线：建任务卡、拼提示词、按渠道校验、落库。
/// 后端自己在 Rust 里重建一套，行为就会和界面慢慢分叉，用户也没法复盘。
fn call_front(ctx: &Ctx, action: &str, args: Value) -> Result<String, String> {
    let app = ctx
        .app
        .as_ref()
        .ok_or_else(|| "这个操作需要应用窗口在运行（当前没有界面可用）".to_string())?;
    let bridge = app.state::<Bridge>();
    let value = bridge.call(app, action, args)?;
    Ok(serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()))
}

// ===== 读 =====

fn get_library(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let state = sop_state(&storage)?;
    let kind = as_str(args, "kind").unwrap_or_else(|| "all".into());
    let with_content = args
        .get("include_content")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // 回收站里的节点不返回
    let alive = |list: Vec<Value>| -> Vec<Value> {
        list.into_iter()
            .filter(|item| item.get("deletedAt").map(Value::is_null).unwrap_or(true))
            .collect()
    };

    let directions = alive(array_of(&state, "directions"));
    let presets = alive(array_of(&state, "presets"));
    let prompts = alive(array_of(&state, "systemPrompts"));
    let templates = state
        .get("postTemplates")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let slim = |items: &[Value], keep: &[&str]| -> Vec<Value> {
        items
            .iter()
            .map(|item| {
                let mut obj = serde_json::Map::new();
                for key in keep {
                    if let Some(v) = item.get(*key) {
                        obj.insert((*key).to_string(), v.clone());
                    }
                }
                if with_content {
                    if let Some(v) = item.get("content") {
                        obj.insert("content".into(), v.clone());
                    }
                } else if let Some(text) = item.get("content").and_then(Value::as_str) {
                    let brief: String = text.chars().take(80).collect();
                    obj.insert("contentBrief".into(), json!(brief));
                }
                Value::Object(obj)
            })
            .collect()
    };

    let mut out = serde_json::Map::new();
    match kind.as_str() {
        "directions" => {
            out.insert("directions".into(), json!(directions));
        }
        "presets" => {
            out.insert("presets".into(), json!(slim(&presets, &["id", "productId", "kind", "name"])));
        }
        "system_prompts" => {
            out.insert("systemPrompts".into(), json!(slim(&prompts, &["id", "productId", "name"])));
        }
        "post_templates" => {
            out.insert("postTemplates".into(), templates);
        }
        _ => {
            out.insert("directions".into(), json!(directions));
            out.insert("presets".into(), json!(slim(&presets, &["id", "productId", "kind", "name"])));
            out.insert("systemPrompts".into(), json!(slim(&prompts, &["id", "productId", "name"])));
            out.insert("postTemplates".into(), templates);
        }
    }
    out.insert("includeContent".into(), json!(with_content));
    Ok(Value::Object(out).to_string())
}

fn read_tasks(storage: &Storage) -> Result<Vec<Value>, String> {
    let raw = storage
        .docs_get_all(TASKS)
        .map_err(|e| format!("读取任务失败：{e}"))?;
    serde_json::from_str::<Vec<Value>>(&raw).map_err(|err| format!("任务数据不是合法 JSON：{err}"))
}

fn list_tasks(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let mut tasks = read_tasks(&storage)?;
    // 回收站里的不返回
    tasks.retain(|t| t.get("trashedAt").map(Value::is_null).unwrap_or(true));

    if let Some(status) = as_str(args, "status") {
        tasks.retain(|t| t.get("status").and_then(Value::as_str) == Some(status.as_str()));
    }
    if let Some(direction) = as_str(args, "direction_id") {
        tasks.retain(|t| {
            t.get("sopDirectionId").and_then(Value::as_str) == Some(direction.as_str())
        });
    }
    if let Some(keyword) = as_str(args, "keyword") {
        tasks.retain(|t| {
            t.get("prompt")
                .and_then(Value::as_str)
                .map(|p| p.contains(&keyword))
                .unwrap_or(false)
        });
    }
    // 新的在前
    tasks.sort_by_key(|t| {
        std::cmp::Reverse(t.get("createdAt").and_then(Value::as_i64).unwrap_or(0))
    });
    let limit = as_i64(args, "limit").unwrap_or(20).clamp(1, 200) as usize;
    let total = tasks.len();
    let items: Vec<Value> = tasks
        .into_iter()
        .take(limit)
        .map(|t| {
            let prompt = t.get("prompt").and_then(Value::as_str).unwrap_or("");
            json!({
                "id": t.get("id"),
                "status": t.get("status"),
                "createdAt": t.get("createdAt"),
                "sopName": t.get("sopName"),
                "directionId": t.get("sopDirectionId"),
                "promptBrief": prompt.chars().take(120).collect::<String>(),
                "outputCount": t.get("outputImages").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                "error": t.get("error"),
            })
        })
        .collect();
    Ok(json!({ "total": total, "returned": items.len(), "tasks": items }).to_string())
}

fn get_task(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let id = required(args, "id")?;
    let tasks = read_tasks(&storage)?;
    tasks
        .into_iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .map(|t| t.to_string())
        .ok_or_else(|| format!("找不到任务卡 {id}"))
}

fn get_settings(ctx: &Ctx) -> Result<String, String> {
    let storage = ctx.storage()?;
    let doc = read_kv(&storage, APP_KEY)?.unwrap_or_else(|| json!({ "state": {} }));
    let state = doc.get("state").cloned().unwrap_or_else(|| json!({}));
    let settings = state.get("settings").cloned().unwrap_or_else(|| json!({}));
    let active = settings
        .get("activeProfileId")
        .and_then(Value::as_str)
        .unwrap_or("");

    let profiles: Vec<Value> = settings
        .get("profiles")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|p| {
                    json!({
                        "id": p.get("id"),
                        "name": p.get("name"),
                        "provider": p.get("provider"),
                        "model": p.get("model"),
                        // 只暴露域名，不带密钥
                        "baseUrl": p.get("baseUrl").and_then(Value::as_str).map(|u| {
                            u.split("//").nth(1).unwrap_or(u).split('/').next().unwrap_or(u).to_string()
                        }),
                        "active": p.get("id").and_then(Value::as_str) == Some(active),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "activeProfileId": active,
        "profiles": profiles,
        "params": state.get("params"),
    })
    .to_string())
}

// ===== 写 =====

fn upsert_direction(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let name = required(args, "name")?;
    let id = as_str(args, "id").filter(|v| !v.trim().is_empty());
    let parent_id = match args.get("parent_id") {
        Some(Value::String(v)) if !v.trim().is_empty() => Some(v.clone()),
        _ => None,
    };
    let kind = as_str(args, "kind");

    let doc = read_kv(&storage, SOP_KEY)?.unwrap_or_else(|| json!({ "state": {}, "version": 0 }));
    let mut state = doc.get("state").cloned().unwrap_or_else(|| json!({}));
    let mut directions = array_of(&state, "directions");

    let result = match &id {
        Some(existing) => {
            let index = directions
                .iter()
                .position(|d| d.get("id").and_then(Value::as_str) == Some(existing.as_str()))
                .ok_or_else(|| format!("找不到方向节点 {existing}"))?;
            let node = directions[index]
                .as_object_mut()
                .ok_or_else(|| "方向节点数据损坏".to_string())?;
            node.insert("name".into(), json!(name));
            if args.get("parent_id").is_some() {
                node.insert("parentId".into(), json!(parent_id));
            }
            if let Some(kind) = &kind {
                node.insert("kind".into(), json!(kind));
            }
            json!({ "ok": true, "action": "updated", "node": directions[index].clone() })
        }
        None => {
            let kind = kind.ok_or_else(|| "新建节点需要 kind（category / product / direction）".to_string())?;
            // 顶层分类才允许没有父级
            if kind != "category" && parent_id.is_none() {
                return Err(format!("{kind} 类型必须指定 parent_id"));
            }
            let node = json!({
                "id": new_id("dir"),
                "parentId": parent_id,
                "name": name,
                "kind": kind,
            });
            directions.push(node.clone());
            json!({ "ok": true, "action": "created", "node": node })
        }
    };

    state["directions"] = json!(directions);
    save_sop_state(&storage, doc, state)?;
    ctx.notify();
    Ok(result.to_string())
}

fn delete_direction(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let id = required(args, "id")?;
    let doc = read_kv(&storage, SOP_KEY)?.unwrap_or_else(|| json!({ "state": {}, "version": 0 }));
    let mut state = doc.get("state").cloned().unwrap_or_else(|| json!({}));
    let mut directions = array_of(&state, "directions");

    // 连子孙一起进回收站，和应用里的删除行为一致
    let mut targets = vec![id.clone()];
    let mut cursor = 0;
    while cursor < targets.len() {
        let current = targets[cursor].clone();
        for node in &directions {
            if node.get("parentId").and_then(Value::as_str) == Some(current.as_str()) {
                if let Some(child) = node.get("id").and_then(Value::as_str) {
                    if !targets.contains(&child.to_string()) {
                        targets.push(child.to_string());
                    }
                }
            }
        }
        cursor += 1;
    }

    let batch = new_id("trash");
    let mut changed = 0;
    for node in directions.iter_mut() {
        if let Some(node_id) = node.get("id").and_then(Value::as_str) {
            if targets.contains(&node_id.to_string()) {
                if let Some(obj) = node.as_object_mut() {
                    obj.insert("deletedAt".into(), json!(now_ms()));
                    obj.insert("trashBatchId".into(), json!(batch));
                    changed += 1;
                }
            }
        }
    }
    if changed == 0 {
        return Err(format!("找不到方向节点 {id}"));
    }

    state["directions"] = json!(directions);
    save_sop_state(&storage, doc, state)?;
    ctx.notify();
    Ok(json!({ "ok": true, "deleted": changed, "trashBatchId": batch }).to_string())
}

fn upsert_preset(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let kind = as_str(args, "kind").ok_or_else(|| "缺少必填参数 kind".to_string())?;
    if kind != "point" && kind != "style" {
        return Err("kind 只能是 point 或 style".into());
    }
    let name = required(args, "name")?;
    let content = required(args, "content")?;
    let id = as_str(args, "id").filter(|v| !v.trim().is_empty());

    let doc = read_kv(&storage, SOP_KEY)?.unwrap_or_else(|| json!({ "state": {}, "version": 0 }));
    let mut state = doc.get("state").cloned().unwrap_or_else(|| json!({}));
    let mut presets = array_of(&state, "presets");

    let result = match id {
        Some(existing) => {
            let index = presets
                .iter()
                .position(|p| p.get("id").and_then(Value::as_str) == Some(existing.as_str()))
                .ok_or_else(|| format!("找不到预设 {existing}"))?;
            if let Some(obj) = presets[index].as_object_mut() {
                obj.insert("name".into(), json!(name));
                obj.insert("content".into(), json!(content));
                obj.insert("kind".into(), json!(kind));
                obj.insert("updatedAt".into(), json!(now_ms()));
            }
            json!({ "ok": true, "action": "updated", "preset": presets[index].clone() })
        }
        None => {
            let product = as_str(args, "product_id")
                .ok_or_else(|| "新建预设需要 product_id（所属产品节点）".to_string())?;
            let preset = json!({
                "id": new_id(if kind == "point" { "pt" } else { "st" }),
                "productId": product,
                "kind": kind,
                "name": name,
                "content": content,
                "updatedAt": now_ms(),
            });
            presets.push(preset.clone());
            json!({ "ok": true, "action": "created", "preset": preset })
        }
    };

    state["presets"] = json!(presets);
    save_sop_state(&storage, doc, state)?;
    ctx.notify();
    Ok(result.to_string())
}

fn delete_task(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let id = required(args, "id")?;
    let tasks = read_tasks(&storage)?;
    if !tasks
        .iter()
        .any(|t| t.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        return Err(format!("找不到任务卡 {id}"));
    }
    storage
        .doc_delete(TASKS, &id)
        .map_err(|e| format!("删除任务卡失败：{e}"))?;
    ctx.notify();
    Ok(json!({ "ok": true, "deleted": id }).to_string())
}

// ===== 出图 =====

/// base64 解码（标准字母表）。不引依赖，出图返回值只需要这一处。
fn b64_decode(input: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let v = value(byte)?;
        buffer = (buffer << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

/// 图片落盘并入库，返回绝对路径。路径规则与 storage/images.rs 的 put_file 一致。
fn save_image(storage: &Storage, bytes: &[u8], mime: &str) -> Result<String, String> {
    // 与 images.rs 一致：小写十六进制，作为图片 id
    let id: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let meta = FileMeta {
        id: id.clone(),
        mime: mime.to_string(),
        width: None,
        height: None,
        source: Some("mcp".into()),
        created_at: Some(now_ms()),
        thumbnail_version: None,
    };
    storage
        .put_file(Kind::Image, &meta, bytes)
        .map_err(|e| format!("保存图片失败：{e}"))?;
    let stem = file_stem(&id);
    let bucket = &stem
        .trim_start_matches("h-")
        .trim_start_matches("fallback-")
        .get(..2)
        .unwrap_or("00");
    let rel = format!("images/{bucket}/{stem}.{}", ext_for_mime(mime));
    Ok(storage.root().join(rel).to_string_lossy().to_string())
}

fn generate_image(ctx: &Ctx, args: &Value) -> Result<String, String> {
    let storage = ctx.storage()?;
    let prompt = required(args, "prompt")?;
    let count = as_i64(args, "count").unwrap_or(1).clamp(1, 10);

    let doc = read_kv(&storage, APP_KEY)?.unwrap_or_else(|| json!({ "state": {} }));
    let state = doc.get("state").cloned().unwrap_or_else(|| json!({}));
    let settings = state.get("settings").cloned().unwrap_or_else(|| json!({}));
    let profiles = settings
        .get("profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if profiles.is_empty() {
        return Err("应用里还没有配置任何接口，请先在设置里添加 API 配置".into());
    }
    let wanted = as_str(args, "profile_id");
    let active = settings
        .get("activeProfileId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let profile = wanted
        .as_deref()
        .and_then(|id| {
            profiles
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
        })
        .or_else(|| {
            profiles
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(active))
        })
        .or_else(|| profiles.first())
        .ok_or_else(|| "找不到可用的接口配置".to_string())?;

    let provider = profile.get("provider").and_then(Value::as_str).unwrap_or("");
    if provider != "openai" {
        return Err(format!(
            "MCP 出图当前只支持 OpenAI 兼容接口，当前选中的是「{provider}」。请在应用里改用 OpenAI 兼容配置，或先用应用界面出图。"
        ));
    }
    let base_url = profile
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let api_key = profile.get("apiKey").and_then(Value::as_str).unwrap_or("");
    let model = profile.get("model").and_then(Value::as_str).unwrap_or("");
    if base_url.is_empty() || api_key.is_empty() {
        return Err("接口配置缺少 baseUrl 或 apiKey".into());
    }

    let size = as_str(args, "size").or_else(|| {
        state
            .pointer("/params/size")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && *s != "auto")
            .map(str::to_string)
    });

    let mut body = json!({
        "model": model,
        "prompt": prompt,
        "n": count,
        "response_format": "b64_json",
    });
    if let Some(size) = &size {
        body["size"] = json!(size);
    }

    let url = format!("{base_url}/images/generations");
    // 日志里带一份副本，body 后面还要发出去
    log::info!("MCP 出图请求：{}", json!({ "url": &url, "body": body.clone() }));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("创建请求失败：{e}"))?;

    let text = tauri::async_runtime::block_on(async {
        let res = client
            .post(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| format!("请求出图接口失败：{e}"))?;
        let status = res.status();
        let text = res
            .text()
            .await
            .map_err(|e| format!("读取出图响应失败：{e}"))?;
        if !status.is_success() {
            let brief: String = text.chars().take(400).collect();
            return Err(format!("出图接口返回 {}：{brief}", status.as_u16()));
        }
        Ok(text)
    })?;

    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("出图响应不是合法 JSON：{e}"))?;
    let items = parsed
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("出图响应里没有 data：{}", text.chars().take(200).collect::<String>()))?;

    let mut saved = Vec::new();
    for item in items {
        let bytes = if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
            b64_decode(b64).ok_or_else(|| "图片 base64 解析失败".to_string())?
        } else if let Some(link) = item.get("url").and_then(Value::as_str) {
            // 少数兼容接口只给链接，这里再取一次
            tauri::async_runtime::block_on(async {
                let res = client
                    .get(link)
                    .send()
                    .await
                    .map_err(|e| format!("下载图片失败：{e}"))?;
                res.bytes()
                    .await
                    .map(|b| b.to_vec())
                    .map_err(|e| format!("读取图片失败：{e}"))
            })?
        } else {
            continue;
        };
        // OpenAI 兼容接口默认返回 png
        let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
            "image/png"
        } else if bytes.starts_with(&[0xFF, 0xD8]) {
            "image/jpeg"
        } else if bytes.get(8..12) == Some(&b"WEBP"[..]) {
            "image/webp"
        } else {
            "image/png"
        };
        let path = save_image(&storage, &bytes, mime)?;
        saved.push(json!({ "path": path, "mime": mime, "bytes": bytes.len() }));
    }

    if saved.is_empty() {
        return Err("接口没有返回任何图片".into());
    }
    ctx.notify();
    Ok(json!({ "ok": true, "count": saved.len(), "images": saved }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_known_value() {
        // "hello" 的 base64 是 aGVsbG8=
        assert_eq!(b64_decode("aGVsbG8=").unwrap(), b"hello".to_vec());
        assert!(b64_decode("!!!").is_none());
    }

    #[test]
    fn tool_list_has_core_tools() {
        let names: Vec<String> = definitions()
            .iter()
            .filter_map(|d| d.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        for expected in [
            "get_library",
            "list_tasks",
            "get_task",
            "get_settings",
            "upsert_direction",
            "delete_direction",
            "upsert_preset",
            "delete_task",
            "generate_image",
        ] {
            assert!(names.contains(&expected.to_string()), "缺少工具 {expected}");
        }
    }

    #[test]
    fn calling_without_storage_reports_clear_error() {
        let ctx = Ctx::for_test();
        let err = call(&ctx, "list_tasks", &json!({})).unwrap_err();
        assert!(err.contains("存储未初始化"), "实际：{err}");
    }
}
