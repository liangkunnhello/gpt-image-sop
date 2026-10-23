//! 最小 HTTP 服务：只处理 MCP 需要的那一种请求。
//!
//! 为什么不用 axum：本项目 Cargo 里没有 HTTP 框架，加依赖要走一次联网拉包；
//! MCP 客户端的请求量很小（一次工具调用一个请求），用 std 的 TcpListener 加
//! 每连接一个线程完全够用，也不影响打包体积。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 单个请求的最大体积，防止异常客户端撑爆内存（MCP 请求都很小）
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// 读写超时：客户端断了不会一直占着线程
const IO_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Request {
    pub method: String,
    /// 只保留路径部分，查询参数单独解析
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    /// 按键名取头（大小写不敏感）
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, body: String) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: body.into_bytes(),
        }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: body.into().into_bytes(),
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

/// 读一行（以 CRLF 结尾），返回去掉 CRLF 的内容
fn read_line(stream: &mut TcpStream, limit: usize) -> Option<String> {
    let mut out = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                if byte[0] != b'\r' {
                    out.push(byte[0]);
                }
                if out.len() > limit {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
    String::from_utf8(out).ok()
}

fn parse_request(stream: &mut TcpStream) -> Option<Request> {
    let start = read_line(stream, 8192)?;
    let mut parts = start.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };

    let mut headers = Vec::new();
    loop {
        let line = read_line(stream, 8192)?;
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
        if headers.len() > 100 {
            return None;
        }
    }

    let length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if length > MAX_BODY_BYTES {
        return None;
    }

    let mut body = vec![0u8; length];
    if length > 0 && stream.read_exact(&mut body).is_err() {
        return None;
    }

    Some(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn write_response(stream: &mut TcpStream, res: Response) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\
         Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\n\
         Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n\r\n",
        res.status,
        reason(res.status),
        res.content_type,
        res.body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(&res.body)?;
    stream.flush()
}

/// 启动监听；返回实际占用的端口。端口被占用时按 +1 依次顺延，最多试 20 次。
pub fn bind(port: u16) -> std::io::Result<(TcpListener, u16)> {
    let mut last_err = None;
    for offset in 0..20u16 {
        let candidate = port.saturating_add(offset);
        match TcpListener::bind(("127.0.0.1", candidate)) {
            Ok(listener) => return Ok((listener, candidate)),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::AddrInUse, "端口全部被占用")
    }))
}

/// 接受连接直到 stop 被置位。每个连接单独一个线程，请求处理完就关连接。
pub fn serve<F>(listener: TcpListener, stop: Arc<AtomicBool>, handler: F)
where
    F: Fn(&Request) -> Response + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    // 非阻塞 accept，这样 stop 生效时能及时退出，不会卡在 accept 上
    if listener.set_nonblocking(true).is_err() {
        log::warn!("MCP 服务无法设置非阻塞模式，停止后可能仍占用端口");
    }
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let handler = handler.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
                    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
                    let Some(req) = parse_request(&mut stream) else {
                        let _ = write_response(&mut stream, Response::text(400, "无法解析请求"));
                        return;
                    };
                    // 浏览器预检
                    if req.method == "OPTIONS" {
                        let _ = write_response(&mut stream, Response::text(204, ""));
                        return;
                    }
                    let res = handler(&req);
                    let _ = write_response(&mut stream, res);
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(err) => {
                log::warn!("MCP 服务接受连接失败：{err}");
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

/// 解析 query 里的单个参数（只处理不需要解码的简单值）
pub fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_param_reads_value() {
        assert_eq!(query_param("a=1&token=abc", "token").as_deref(), Some("abc"));
        assert_eq!(query_param("a=1", "token"), None);
    }

    #[test]
    fn bind_shifts_to_next_port_when_occupied() {
        let first = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = first.local_addr().unwrap().port();
        let (listener, actual) = bind(port).unwrap();
        assert_ne!(actual, port);
        drop(listener);
    }
}
