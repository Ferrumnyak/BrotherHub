//! Настоящие названия видео и треков для интерфейса.
//!
//! В чате, в «Что посмотреть» и в рулетке вместо куска ссылки показываем
//! название с сайта. Для YouTube оно берётся быстро через oEmbed, для
//! остальных сайтов — у yt-dlp (`--print title`, без скачивания).
//! Ответы запоминаются, одновременно работают не больше двух yt-dlp.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use brotherwatch_shared::is_url;
use reqwest::Url;
use tokio::sync::Semaphore;

const TIMEOUT: Duration = Duration::from_secs(25);

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn limit() -> &'static Semaphore {
    static LIMIT: OnceLock<Semaphore> = OnceLock::new();
    LIMIT.get_or_init(|| Semaphore::new(2))
}

/// Название по ссылке (`None` — не удалось узнать).
#[tauri::command]
pub async fn media_title(url: String) -> Option<String> {
    let url = url.trim().to_string();
    if !is_url(&url) || crate::sites::handles(&url) {
        return None;
    }
    if let Some(known) = cache().lock().unwrap().get(&url) {
        return known.clone();
    }
    let _slot = limit().acquire().await.ok()?;
    // Пока ждали очереди, название мог узнать другой запрос.
    if let Some(known) = cache().lock().unwrap().get(&url) {
        return known.clone();
    }
    let title = match youtube_title(&url).await {
        Some(title) => Some(title),
        None => ytdlp_title(&url).await,
    };
    cache().lock().unwrap().insert(url, title.clone());
    title
}

async fn youtube_title(url: &str) -> Option<String> {
    let host = Url::parse(url).ok()?.host_str()?.to_ascii_lowercase();
    if !(host.ends_with("youtube.com") || host == "youtu.be") {
        return None;
    }
    let api = Url::parse_with_params(
        "https://www.youtube.com/oembed",
        &[("format", "json"), ("url", url)],
    )
    .ok()?;
    let body = reqwest::Client::new()
        .get(api)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .bytes()
        .await
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&body).ok()?;
    clean(json.get("title")?.as_str()?)
}

async fn ytdlp_title(url: &str) -> Option<String> {
    let ytdlp = crate::player::find_ytdlp().unwrap_or_else(|| "yt-dlp".into());
    let mut cmd = tokio::process::Command::new(ytdlp);
    cmd.args([
        "--no-warnings",
        "--skip-download",
        "--no-playlist",
        "--encoding",
        "utf-8",
        "--print",
        "%(title)s",
        "--",
        url,
    ])
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
    clean(String::from_utf8_lossy(&output.stdout).lines().next()?)
}

fn clean(title: &str) -> Option<String> {
    let title = title.trim();
    (!title.is_empty() && title != "NA").then(|| title.chars().take(200).collect())
}
