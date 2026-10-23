//! MCP 服务：让外部 Coding 工具 / Agent 操作本应用。
//!
//! 服务跑在应用进程里，用 Streamable HTTP 传输（MCP 客户端填一个 URL 就能连），
//! 端口和访问令牌都存在 kv 里，随应用启动自动拉起。

mod http;
mod rpc;
mod tools;

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Digest;
use tauri::{AppHandle, Manager, State};

use crate::storage::{now_ms, StorageState};

/// 配置存在这个 kv 键里
const CONFIG_KEY: &str = "mcp";
/// 默认端口；7799 被本地后端占用，10588 与参考实现一致，都避开更稳妥
const DEFAULT_PORT: u16 = 10588;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    /// 访问令牌：HTTP 头或 URL 里带上才允许调用
    pub token: String,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: String::new(),
        }
    }
}

#[derive(Default)]
struct Stats {
    requests: AtomicU64,
    last_at: AtomicI64,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct McpServer {
    running: Mutex<Option<Running>>,
    stats: Arc<Stats>,
}

/// 返回给前端的连接状态
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// 配置里是否勾了开启
    pub enabled: bool,
    /// 服务是否真的在监听
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub token: String,
    pub requests: u64,
    pub last_request_at: Option<i64>,
    /// 启动失败的原因，成功时为 null
    pub error: Option<String>,
}

fn storage_of(app: &AppHandle) -> Option<Arc<crate::storage::Storage>> {
    app.state::<StorageState>().0.as_ref().ok().cloned()
}

fn random_token() -> String {
    // 没有引随机库：时间 + 进程号 + 栈地址足够做本地访问令牌，不需要密码学强度
    let probe = 0u8;
    let seed = format!(
        "{}-{}-{:p}",
        now_ms(),
        std::process::id(),
        &probe as *const u8
    );
    sha2::Sha256::digest(seed.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn read_config(app: &AppHandle) -> McpConfig {
    let Some(storage) = storage_of(app) else {
        return McpConfig::default();
    };
    let Ok(all) = storage.kv_get_all() else {
        return McpConfig::default();
    };
    let mut config: McpConfig = all
        .get(CONFIG_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    if config.token.trim().is_empty() {
        config.token = random_token();
        let _ = write_config(app, &config);
    }
    if config.port == 0 {
        config.port = DEFAULT_PORT;
    }
    config
}

fn write_config(app: &AppHandle, config: &McpConfig) -> Result<(), String> {
    let storage = storage_of(app).ok_or_else(|| "数据目录不可用，无法保存 MCP 配置".to_string())?;
    let value = serde_json::to_string(config).map_err(|e| e.to_string())?;
    storage.kv_set(CONFIG_KEY, &value).map_err(|e| e.to_string())
}

impl McpServer {
    fn status(&self, app: &AppHandle) -> McpStatus {
        let config = read_config(app);
        let guard = self.running.lock().expect("MCP 状态锁中毒");
        let port = guard.as_ref().map(|r| r.port).unwrap_or(config.port);
        let running = guard.is_some();
        let last = self.stats.last_at.load(Ordering::Relaxed);
        McpStatus {
            enabled: config.enabled,
            running,
            port,
            url: if running {
                format!("http://127.0.0.1:{port}/mcp")
            } else {
                String::new()
            },
            token: config.token,
            requests: self.stats.requests.load(Ordering::Relaxed),
            last_request_at: (last > 0).then_some(last),
            error: None,
        }
    }

    /// 启动监听；已在运行则直接返回当前端口
    fn start(&self, app: &AppHandle, config: &McpConfig) -> Result<u16, String> {
        {
            let guard = self.running.lock().expect("MCP 状态锁中毒");
            if let Some(running) = guard.as_ref() {
                return Ok(running.port);
            }
        }

        let (listener, port) = http::bind(config.port).map_err(|e| {
            format!("无法监听 127.0.0.1:{}：{e}", config.port)
        })?;

        let ctx = Arc::new(tools::Ctx {
            storage: storage_of(app),
            app: Some(app.clone()),
        });
        let token = config.token.clone();
        let stats = self.stats.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        std::thread::Builder::new()
            .name("mcp-server".into())
            .spawn(move || {
                http::serve(listener, stop_flag, move |req| {
                    handle_request(&ctx, &token, &stats, req)
                })
            })
            .map_err(|e| format!("启动 MCP 服务线程失败：{e}"))?;

        let mut guard = self.running.lock().expect("MCP 状态锁中毒");
        *guard = Some(Running { port, stop });
        log::info!("MCP 服务已启动：http://127.0.0.1:{port}/mcp");
        Ok(port)
    }

    fn stop(&self) {
        let mut guard = self.running.lock().expect("MCP 状态锁中毒");
        if let Some(running) = guard.take() {
            // 只置位不 join：出图可能还在跑，等它自己结束，避免关窗口时卡住
            running.stop.store(true, Ordering::Relaxed);
            log::info!("MCP 服务已停止（端口 {}）", running.port);
        }
    }

    fn restart(&self, app: &AppHandle, config: &McpConfig) -> Result<u16, String> {
        self.stop();
        // 给监听线程一点时间退出并释放端口
        std::thread::sleep(std::time::Duration::from_millis(160));
        self.start(app, config)
    }
}

fn handle_request(
    ctx: &tools::Ctx,
    token: &str,
    stats: &Stats,
    req: &http::Request,
) -> http::Response {
    if req.path != "/mcp" && req.path != "/" {
        return http::Response::text(404, "只提供 /mcp 一个端点");
    }
    if req.method == "GET" {
        // 不支持服务端推送，按规范让客户端改用 POST
        return http::Response::json(
            405,
            json!({ "error": "这个 MCP 服务只支持 POST，不支持 SSE 流" }).to_string(),
        );
    }
    if req.method != "POST" {
        return http::Response::text(405, "只支持 POST");
    }

    // 令牌校验：优先 Authorization 头，其次 URL 参数（有些客户端不方便设头）
    let header_token = req
        .header("authorization")
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.trim().to_string()))
        .or_else(|| req.header("x-mcp-token").map(str::to_string));
    let token_ok = header_token
        .or_else(|| http::query_param(&req.query, "token"))
        .is_some_and(|value| value == token);
    if !token_ok {
        return http::Response::json(
            401,
            json!({ "error": "访问令牌不正确，请在应用设置的 MCP 页复制完整配置" }).to_string(),
        );
    }

    stats.requests.fetch_add(1, Ordering::Relaxed);
    stats.last_at.store(now_ms(), Ordering::Relaxed);

    // 通知（notifications/initialized 之类）按规范回 202 空体
    match rpc::handle(ctx, &req.body) {
        Some(body) => http::Response::json(200, body),
        None => http::Response::text(202, ""),
    }
}

// ===== 给前端的命令 =====

#[tauri::command]
pub fn mcp_status(app: AppHandle, server: State<'_, McpServer>) -> McpStatus {
    server.status(&app)
}

#[tauri::command]
pub fn mcp_set_enabled(
    app: AppHandle,
    server: State<'_, McpServer>,
    enabled: bool,
) -> Result<McpStatus, String> {
    let mut config = read_config(&app);
    config.enabled = enabled;
    if enabled && config.token.trim().is_empty() {
        config.token = random_token();
    }
    write_config(&app, &config)?;
    if enabled {
        match server.start(&app, &config) {
            Ok(port) => {
                let mut status = server.status(&app);
                status.port = port;
                status.url = format!("http://127.0.0.1:{port}/mcp");
                return Ok(status);
            }
            Err(err) => {
                server.stop();
                let mut status = server.status(&app);
                status.error = Some(err);
                return Ok(status);
            }
        }
    }
    server.stop();
    Ok(server.status(&app))
}

#[tauri::command]
pub fn mcp_set_port(
    app: AppHandle,
    server: State<'_, McpServer>,
    port: u16,
) -> Result<McpStatus, String> {
    if port < 1024 {
        return Err("端口请填 1024 以上的值".into());
    }
    let mut config = read_config(&app);
    config.port = port;
    write_config(&app, &config)?;
    // 正在运行就按新端口重启
    if config.enabled {
        match server.restart(&app, &config) {
            Ok(actual) => {
                let mut status = server.status(&app);
                status.port = actual;
                status.url = format!("http://127.0.0.1:{actual}/mcp");
                return Ok(status);
            }
            Err(err) => {
                let mut status = server.status(&app);
                status.error = Some(err);
                return Ok(status);
            }
        }
    }
    Ok(server.status(&app))
}

#[tauri::command]
pub fn mcp_rotate_token(app: AppHandle, server: State<'_, McpServer>) -> Result<McpStatus, String> {
    let mut config = read_config(&app);
    config.token = random_token();
    write_config(&app, &config)?;
    if config.enabled {
        if let Err(err) = server.restart(&app, &config) {
            let mut status = server.status(&app);
            status.error = Some(err);
            return Ok(status);
        }
    }
    Ok(server.status(&app))
}

/// 应用启动时调用：配置里开着就自动拉起
pub fn autostart(app: &AppHandle) {
    let config = read_config(app);
    if !config.enabled {
        return;
    }
    let server = app.state::<McpServer>();
    if let Err(err) = server.start(app, &config) {
        log::error!("MCP 服务自动启动失败：{err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_port_is_not_the_sidecar_port() {
        assert_ne!(McpConfig::default().port, 7799);
        assert_eq!(McpConfig::default().port, DEFAULT_PORT);
    }

    #[test]
    fn random_token_is_stable_length_hex() {
        let token = random_token();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
