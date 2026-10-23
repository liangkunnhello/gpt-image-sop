//! 前端 db.ts（dbTauri.ts）对应的 Tauri 命令。
//! 文件 IO 和锁等待都放到阻塞线程池执行，不占用主线程和异步运行时的工作线程
use std::collections::HashMap;
use std::sync::Arc;

use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::images::encode_file;
use super::{
    Doc, FileMeta, ImageStat, Kind, Result, Storage, StorageError, StorageInfo, StorageState,
    CONVERSATIONS, TASKS,
};

const SOURCES: [&str; 3] = ["upload", "generated", "mask"];

async fn run<T: Send + 'static>(
    state: State<'_, StorageState>,
    f: impl FnOnce(&Storage) -> Result<T> + Send + 'static,
) -> Result<T> {
    let storage: Arc<Storage> = state.0.clone()?;
    tauri::async_runtime::spawn_blocking(move || f(&storage))
        .await
        .map_err(|err| StorageError::new("io", format!("存储任务异常结束：{err}")))?
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// 外部导入的数据可能带有非法数值，忽略即可，不影响保存图片本身
fn number_header(headers: &HeaderMap, name: &str) -> Option<i64> {
    header(headers, name)?
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .map(|n| n.round() as i64)
}

/// 原始请求体为文件内容，元数据放在 x-* 请求头中
async fn put_from_request(
    state: State<'_, StorageState>,
    request: Request<'_>,
    kind: Kind,
) -> Result<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(StorageError::new("invalid_argument", "请求体必须是二进制"));
    };
    let headers = request.headers();
    let meta = FileMeta {
        // 前端用 encodeURIComponent 编码，id 可以包含任意字符
        id: percent_encoding::percent_decode_str(&header(headers, "x-id").unwrap_or_default())
            .decode_utf8()
            .map_err(|_| StorageError::new("invalid_argument", "x-id 不是合法的 UTF-8"))?
            .into_owned(),
        mime: match headers.get("x-mime") {
            None => return Err(StorageError::new("invalid_argument", "缺少 x-mime")),
            Some(v) => v
                .to_str()
                .map_err(|_| StorageError::new("invalid_argument", "x-mime 只能包含 ASCII 字符"))?
                .to_string(),
        },
        width: number_header(headers, "x-width"),
        height: number_header(headers, "x-height"),
        source: header(headers, "x-source").filter(|s| SOURCES.contains(&s.as_str())),
        created_at: number_header(headers, "x-created-at"),
        thumbnail_version: number_header(headers, "x-thumbnail-version"),
    };
    // 请求体借用自 IPC 消息，需复制一份才能移入阻塞线程
    let bytes = bytes.clone();
    run(state, move |s| s.put_file(kind, &meta, &bytes)).await
}

#[tauri::command]
pub async fn tasks_get_all(state: State<'_, StorageState>) -> Result<Response> {
    run(state, |s| s.docs_get_all(TASKS))
        .await
        .map(Response::new)
}

#[tauri::command]
pub async fn task_put(state: State<'_, StorageState>, id: String, data: String) -> Result<()> {
    run(state, move |s| s.doc_put(TASKS, &Doc { id, data })).await
}

#[tauri::command]
pub async fn task_delete(state: State<'_, StorageState>, id: String) -> Result<()> {
    run(state, move |s| s.doc_delete(TASKS, &id)).await
}

#[tauri::command]
pub async fn tasks_clear(state: State<'_, StorageState>) -> Result<()> {
    run(state, |s| s.docs_clear(TASKS)).await
}

#[tauri::command]
pub async fn tasks_commit_deletion(
    state: State<'_, StorageState>,
    deleted_ids: Vec<String>,
    tasks: Vec<Doc>,
    conversations: Vec<Doc>,
) -> Result<()> {
    run(state, move |s| {
        s.commit_task_deletion(&deleted_ids, &tasks, &conversations)
    })
    .await
}

#[tauri::command]
pub async fn conversations_get_all(state: State<'_, StorageState>) -> Result<Response> {
    run(state, |s| s.docs_get_all(CONVERSATIONS))
        .await
        .map(Response::new)
}

#[tauri::command]
pub async fn conversation_put(
    state: State<'_, StorageState>,
    id: String,
    data: String,
) -> Result<()> {
    run(state, move |s| s.doc_put(CONVERSATIONS, &Doc { id, data })).await
}

#[tauri::command]
pub async fn conversations_clear(state: State<'_, StorageState>) -> Result<()> {
    run(state, |s| s.docs_clear(CONVERSATIONS)).await
}

#[tauri::command]
pub async fn conversations_replace(
    state: State<'_, StorageState>,
    conversations: Vec<Doc>,
) -> Result<()> {
    run(state, move |s| s.replace_conversations(&conversations)).await
}

#[tauri::command]
pub async fn image_get(state: State<'_, StorageState>, id: String) -> Result<Response> {
    run(state, move |s| s.get_file(Kind::Image, &id))
        .await
        .map(|found| Response::new(encode_file(found)))
}

#[tauri::command]
pub async fn image_put(state: State<'_, StorageState>, request: Request<'_>) -> Result<()> {
    put_from_request(state, request, Kind::Image).await
}

/// 文件名/文件夹名单段清洗：去掉路径分隔符与控制字符，防止写出数据目录之外
fn sanitize_segment(value: &str, max_chars: usize) -> String {
    let cleaned: String = value
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let trimmed: String = cleaned
        .trim()
        .trim_matches('.')
        .trim()
        .chars()
        .take(max_chars)
        .collect();
    let trimmed = trimmed.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 把后处理成品写进数据目录的 finished/<任务文件夹>/<文件名>。
/// 走 Rust 直写，不依赖本地 Node 服务（打包版没有那个服务）。
/// 同名文件直接覆盖，正好用于「再次后处理」。
#[tauri::command]
pub async fn finished_write(
    state: State<'_, StorageState>,
    folder: String,
    name: String,
    payload: String,
) -> Result<String> {
    let (_, bytes) = crate::dataurl::split(&payload)
        .ok_or_else(|| StorageError::new("invalid_argument", "图片数据不是合法的 dataUrl"))?;
    run(state, move |storage| {
        let dir = storage
            .root()
            .join("finished")
            .join(sanitize_segment(&folder, 80));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(sanitize_segment(&name, 120));
        std::fs::write(&path, &bytes)?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
pub async fn image_delete(state: State<'_, StorageState>, id: String) -> Result<()> {
    run(state, move |s| s.delete_image(&id)).await
}

#[tauri::command]
pub async fn images_clear(state: State<'_, StorageState>) -> Result<()> {
    run(state, |s| s.clear_images()).await
}

#[tauri::command]
pub async fn image_ids(state: State<'_, StorageState>) -> Result<Vec<String>> {
    run(state, |s| s.image_ids()).await
}

#[tauri::command]
pub async fn image_stats(state: State<'_, StorageState>) -> Result<Vec<ImageStat>> {
    run(state, |s| s.image_stats()).await
}

#[tauri::command]
pub async fn thumbnail_get(state: State<'_, StorageState>, id: String) -> Result<Response> {
    run(state, move |s| s.get_file(Kind::Thumbnail, &id))
        .await
        .map(|found| Response::new(encode_file(found)))
}

#[tauri::command]
pub async fn thumbnail_put(state: State<'_, StorageState>, request: Request<'_>) -> Result<()> {
    put_from_request(state, request, Kind::Thumbnail).await
}

#[tauri::command]
pub async fn kv_get_all(state: State<'_, StorageState>) -> Result<HashMap<String, String>> {
    run(state, |s| s.kv_get_all()).await
}

#[tauri::command]
pub async fn kv_set(state: State<'_, StorageState>, key: String, value: String) -> Result<()> {
    run(state, move |s| s.kv_set(&key, &value)).await
}

#[tauri::command]
pub async fn kv_remove(state: State<'_, StorageState>, key: String) -> Result<()> {
    run(state, move |s| s.kv_remove(&key)).await
}

#[tauri::command]
pub async fn storage_info(state: State<'_, StorageState>) -> Result<StorageInfo> {
    run(state, |s| s.info()).await
}

/// 只打开数据目录本身，不向前端开放任意路径的打开权限
#[tauri::command]
pub async fn storage_open_dir(state: State<'_, StorageState>) -> Result<()> {
    run(state, |s| {
        tauri_plugin_opener::open_path(s.root(), None::<&str>)
            .map_err(|err| StorageError::new("io", format!("打开数据目录失败：{err}")))
    })
    .await
}

/// 在资源管理器中选中某张原图（「打开文件所在位置」）。
/// 只接受存储里真实存在的图片 id，路径由后端自己拼出来，前端无法借此打开任意路径。
/// 文件已被清理时返回 false，由前端提示改为打开所在文件夹。
#[tauri::command]
pub async fn storage_reveal_image(state: State<'_, StorageState>, id: String) -> Result<bool> {
    let path = run(state, move |s| s.image_path(&id)).await?;
    let Some(path) = path else { return Ok(false) };
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|err| StorageError::new("io", format!("打开图片位置失败：{err}")))?;
    Ok(true)
}
