//! Заранее подготовить следующее видео из очереди.
//!
//! Обычно ссылку разбирает yt-dlp прямо в момент включения — это несколько
//! секунд чёрного экрана. За ~20 секунд до конца текущего видео интерфейс
//! просит разобрать следующее заранее: yt-dlp выдаёт прямые ссылки на поток,
//! мы их запоминаем, и при включении mpv открывает их сразу, без yt-dlp.
//!
//! Прямые ссылки живут недолго, поэтому запомненное через 20 минут
//! забывается. Если разобрать не вышло — видео откроется обычным путём.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use brotherwatch_shared::is_url;
use serde_json::Value;
use tauri::State;

use crate::session::SharedSession;

const TIMEOUT: Duration = Duration::from_secs(40);
const KEEP: Duration = Duration::from_secs(20 * 60);

/// Готовая к открытию ссылка.
#[derive(Clone)]
pub struct Ready {
    /// Что открыть в mpv (`edl://…` — видео и звук вместе).
    pub open: String,
    pub title: Option<String>,
    /// С каким браузером представляться сайту (как просит yt-dlp).
    #[cfg_attr(mobile, allow(dead_code))]
    pub user_agent: Option<String>,
}

#[derive(Default)]
struct Store {
    /// (ссылка, качество) → когда разобрали и что получилось.
    ready: HashMap<(String, Option<u32>), (Instant, Ready)>,
    busy: HashSet<(String, Option<u32>)>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

/// Забрать подготовленное (один раз: повторное открытие — обычным путём).
pub fn take(url: &str, quality: Option<u32>) -> Option<Ready> {
    let mut s = store().lock().unwrap();
    let (at, ready) = s.ready.remove(&(url.to_string(), quality))?;
    (at.elapsed() < KEEP).then_some(ready)
}

/// Разобрать ссылку заранее (повторные просьбы о той же ссылке — без работы).
#[tauri::command]
pub async fn prefetch_media(session: State<'_, SharedSession>, url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    // На телефоне yt-dlp внутри Kotlin-части, заранее готовить нечем.
    if cfg!(mobile) || !is_url(&url) || crate::sites::handles(&url) {
        return Ok(());
    }
    let quality = session.lock().await.quality();
    let key = (url.clone(), quality);
    {
        let mut s = store().lock().unwrap();
        s.ready.retain(|_, (at, _)| at.elapsed() < KEEP);
        if s.ready.contains_key(&key) || !s.busy.insert(key.clone()) {
            return Ok(());
        }
    }
    crate::logs::info(format!("готовлю заранее: {url}"));
    let result = resolve(&url, quality).await;
    let mut s = store().lock().unwrap();
    s.busy.remove(&key);
    match result {
        Some(ready) => {
            crate::logs::info("заранее: готово");
            s.ready.insert(key, (Instant::now(), ready));
        }
        None => crate::logs::warn(format!("заранее не получилось, откроется обычно: {url}")),
    }
    Ok(())
}

async fn resolve(url: &str, quality: Option<u32>) -> Option<Ready> {
    let ytdlp = crate::player::find_ytdlp().unwrap_or_else(|| "yt-dlp".into());
    let mut cmd = tokio::process::Command::new(ytdlp);
    cmd.args(["--no-warnings", "--no-playlist", "--encoding", "utf-8", "-J", "-f"])
        .arg(crate::player::ytdl_format(quality))
        .arg("--")
        .arg(url)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(TIMEOUT, cmd.output()).await.ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let info: Value = serde_json::from_slice(&output.stdout).ok()?;
    if info.get("is_live").and_then(Value::as_bool) == Some(true) {
        return None; // прямой эфир — пусть открывает yt-dlp
    }
    let title = info
        .get("title")
        .and_then(Value::as_str)
        .map(|t| t.chars().take(200).collect());
    // Видео и звук отдельно (YouTube, VK) или один поток.
    let streams: Vec<&Value> = match info.get("requested_formats").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => list.iter().collect(),
        _ => vec![&info],
    };
    let mut open = String::from("edl://");
    let mut user_agent = None;
    for (i, f) in streams.iter().enumerate() {
        let link = f.get("url").and_then(Value::as_str)?;
        // Потокам, которым нужны куки или «откуда пришли», — только через yt-dlp.
        if let Some(headers) = f.get("http_headers").and_then(Value::as_object) {
            if headers.keys().any(|k| k.eq_ignore_ascii_case("cookie") || k.eq_ignore_ascii_case("referer")) {
                return None;
            }
            if let Some(ua) = headers.get("User-Agent").and_then(Value::as_str) {
                user_agent = Some(ua.to_string());
            }
        }
        let protocol = f.get("protocol").and_then(Value::as_str).unwrap_or("https");
        // Плейлисты HLS/DASH и прочее — только через yt-dlp.
        if !(protocol == "https" || protocol == "http") || !is_url(link) {
            return None;
        }
        if i > 0 {
            open.push(';');
        }
        // Формат EDL: длина ссылки в байтах в %…% — так в ней можно
        // оставить любые символы. Так же делает сам mpv для yt-dlp.
        open.push_str(&format!("!new_stream;!no_clip;!no_chapters;%{}%{link}", link.len()));
    }
    Some(Ready { open, title, user_agent })
}
