//! JSON-RPC 2.0 分发。只实现 MCP 客户端实际会用到的方法：
//! initialize / notifications/initialized / ping / tools/list / tools/call。

use serde_json::{json, Value};

use super::tools;

/// 服务端默认协议版本；客户端请求了别的版本时按客户端给的版本回显，兼容性更好
const DEFAULT_PROTOCOL: &str = "2025-06-18";

pub const SERVER_NAME: &str = "gpt-image-sop";

fn ok(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_json(id: Value, code: i64, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
    .to_string()
}

/// 处理一条 JSON-RPC 消息；返回要写回 HTTP 的 JSON 文本。
/// 通知（没有 id）按规范不返回内容，这里统一回 202 空体，由调用方处理。
pub fn handle(ctx: &tools::Ctx, raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let msg: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(parse_err) => {
            return Some(error_json(
                Value::Null,
                -32700,
                &format!("请求不是合法 JSON：{parse_err}"),
            ))
        }
    };

    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let is_notification = msg.get("id").is_none();

    // 通知不需要响应
    if is_notification {
        return None;
    }

    // Err 的具体类型必须写出来，否则编译器无法从各分支推断出 Sized 的错误类型
    let result: Result<Value, String> = match method {
        "initialize" => {
            let client_version = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL);
            Ok(json!({
                "protocolVersion": client_version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": SERVER_NAME,
                    // 版本号由 build 脚本注入不方便，这里固定跟 Cargo 走
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "instructions": "这是 GPT Image SOP 的生图工作台。可以查方向树、卖点、风格、SOP 与任务卡，也能直接出图。出图工具需要先在应用里配置好接口。"
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::definitions() })),
        "tools/call" => {
            let name = msg
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let args = msg
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match tools::call(ctx, name, &args) {
                Ok(value) => Ok(json!({
                    "content": [{ "type": "text", "text": value }],
                    "isError": false
                })),
                Err(message) => Ok(json!({
                    "content": [{ "type": "text", "text": message }],
                    "isError": true
                })),
            }
        }
        other => return Some(error_json(id, -32601, &format!("不支持的方法：{other}"))),
    };

    Some(match result {
        Ok(value) => ok(id, value),
        Err(message) => error_json(id, -32602, &message),
    })
}

/// 判断这条消息是不是通知（用来决定回 202 还是回 JSON）
pub fn is_notification(raw: &[u8]) -> bool {
    let text = String::from_utf8_lossy(raw);
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => v.get("id").is_none() && v.get("method").is_some(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_echoes_client_protocol_version() {
        let ctx = tools::Ctx::for_test();
        let raw = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#;
        let out = handle(&ctx, raw).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(v["result"]["capabilities"]["tools"]["listChanged"], false);
    }

    #[test]
    fn notification_has_no_response() {
        let raw = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert!(is_notification(raw));
        let ctx = tools::Ctx::for_test();
        assert!(handle(&ctx, raw).is_none());
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let ctx = tools::Ctx::for_test();
        let out = handle(&ctx, br#"{"jsonrpc":"2.0","id":7,"method":"nope"}"#).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["error"]["code"], -32601);
    }
}
