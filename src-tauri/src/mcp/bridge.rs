//! MCP → 前端 的调用通道。
//!
//! 出图、重试、停止这类操作必须走界面上那套流水线：建任务卡、拼提示词、按渠道校验。
//! 后端直接改数据库是绕过去的 —— 结果虽然进库了，但用户在界面上看不到「MCP 刚才做了什么」，
//! 也没法复盘流程对不对。
//!
//! 所以这里把调用转给前端执行（等价于人工点一次按钮），再等它把结果传回来：
//!
//! ```text
//! MCP 工具调用 → emit("mcp-invoke") → 前端执行 store action → invoke("mcp_invoke_reply")
//! ```
//!
//! 用 std 的 mpsc 阻塞等待：MCP 的 HTTP 服务是「一条连接一个线程」（见 mcp/http.rs），
//! 阻塞只会占住那一条连接线程，不会卡住整个服务。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const INVOKE_EVENT: &str = "mcp-invoke";

/// 等前端回结果的上限。
///
/// 这里等的是「界面把活接下来并给出任务 id」，不是等出图画完 ——
/// 出图要几分钟，慢的那部分由调用方用 list_tasks 轮询。
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);

type Pending = HashMap<String, Sender<Result<Value, String>>>;

#[derive(Default)]
pub struct Bridge {
    pending: Mutex<Pending>,
    seq: AtomicU64,
}

impl Bridge {
    /// 让前端执行一个动作并等结果。前端没响应（窗口关了）或超时都返回明确错误。
    pub fn call(&self, app: &AppHandle, action: &str, args: Value) -> Result<Value, String> {
        let id = format!("mcp-{}", self.seq.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx): (Sender<Result<Value, String>>, Receiver<Result<Value, String>>) = channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id.clone(), tx);
        }
        if let Err(err) = app.emit(INVOKE_EVENT, json!({ "id": id, "action": action, "args": args })) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(format!("无法通知界面：{err}"));
        }
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(format!(
                    "等了 {} 秒界面还没回应（窗口可能未打开）；可以稍后用 list_tasks 看结果",
                    CALL_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// 前端把结果送回来
    pub fn reply(&self, id: &str, ok: bool, data: Value, error: Option<String>) {
        let sender = self.pending.lock().ok().and_then(|mut pending| pending.remove(id));
        if let Some(tx) = sender {
            let _ = tx.send(if ok {
                Ok(data)
            } else {
                Err(error.unwrap_or_else(|| "界面执行失败".to_string()))
            });
        }
    }
}

/// 前端回传入口：MCP 工具在等的那次调用就此拿到结果
#[tauri::command]
pub fn mcp_invoke_reply(
    bridge: tauri::State<'_, Bridge>,
    id: String,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
) {
    bridge.reply(&id, ok, data.unwrap_or(Value::Null), error);
}
