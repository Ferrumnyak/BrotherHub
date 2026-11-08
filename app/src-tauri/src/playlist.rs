//! Плейлист или сезон сериала по ссылке — список серий для очереди.
//!
//! yt-dlp с `--flat-playlist` быстро отдаёт ссылки и названия всех видео
//! плейлиста, ничего не скачивая (YouTube, VK Видео, Rutube и др.).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const TIMEOUT: Duration = Duration::from_secs(40);
/// Больше в «Что посмотреть» всё равно не поместится.
const MAX_ENTRIES: usize = 60;

#[derive(Serialize)]
pub struct Entry {
    url: String,
    title: Option<String>,
}

/// Видео плейлиста по порядку. Не плейлист — пустой список.
#[tauri::command]
pub async fn playlist_entries(url: String) -> Result<Vec<Entry>, String> {
    let ytdlp = crate::player::find_ytdlp().unwrap_or_else(|| "yt-dlp".into());
    let mut cmd = tokio::process::Command::new(ytdlp);
    crate::dpi::ytdlp_proxy(&mut cmd);
    cmd.args([
        "--no-warnings",
        "--flat-playlist",
        "--dump-single-json",
        "--encoding",
        "utf-8",
        "--playlist-end",
        &MAX_ENTRIES.to_string(),
        "--",
        url.trim(),
    ])
    .env("PYTHONIOENCODING", "utf-8")
    .stdin(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = tokio::time::timeout(TIMEOUT, cmd.output())
        .await
        .map_err(|_| "Плейлист открывается слишком долго".to_string())?
        .map_err(|e| format!("Не получилось открыть плейлист: {e}"))?;
    if !output.status.success() {
        return Err("Не получилось открыть плейлист".into());
    }
    let info: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Непонятный ответ про плейлист".to_string())?;
    if info.get("_type").and_then(Value::as_str) != Some("playlist") {
        return Ok(Vec::new());
    }
    let entries = info
        .get("entries")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    let url = [e.get("url"), e.get("webpage_url")]
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .find(|u| u.starts_with("http"))?
                        .to_string();
                    let title = e.get("title").and_then(Value::as_str).map(str::to_string);
                    Some(Entry { url, title })
                })
                .take(MAX_ENTRIES)
                .collect()
        })
        .unwrap_or_default();
    Ok(entries)
}
