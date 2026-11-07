//! «Обзор» на телефоне: сайт открывается в отдельном Android WebView поверх
//! области видео (PlayerPlugin.kt). Команды — те же, что на компьютере
//! (browser.rs), чтобы интерфейсу не было разницы.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::player::call;

/// Площадки, которые можно открыть (как на компьютере).
const SITES: &[&str] = &[
    "youtube.com",
    "vkvideo.ru",
    "vk.com",
    "rutube.ru",
    "twitch.tv",
    "soundcloud.com",
    "smotrim.ru",
    "dzen.ru",
    "ok.ru",
    "yandex.ru",
    "u-tv.ru",
];

/// Прячет рекламу и находит видео на странице — тот же, что на компьютере.
const ADBLOCK: &str = include_str!("adblock.js");

/// Где показать сайт — физические пиксели относительно интерфейса.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Area {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn allowed(url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str().is_some_and(|h| {
            let h = h.to_ascii_lowercase();
            SITES.iter().any(|s| h == *s || h.ends_with(&format!(".{s}")))
        })
}

#[tauri::command]
pub async fn browser_open(url: String, rect: Area) -> Result<(), String> {
    if !allowed(&url) {
        return Err("Эту площадку здесь не открыть".into());
    }
    call("browserOpen", json!({ "url": url, "rect": rect, "script": ADBLOCK }))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn browser_place(rect: Option<Area>) -> Result<(), String> {
    call("browserPlace", json!({ "rect": rect })).await.map(|_| ())
}

#[tauri::command]
pub async fn browser_url() -> Option<String> {
    let v: Value = call("browserUrl", json!({})).await.ok()?;
    v.get("url")?.as_str().map(str::to_string)
}

#[tauri::command]
pub async fn browser_back() -> Result<(), String> {
    call("browserBack", json!({})).await.map(|_| ())
}

#[tauri::command]
pub async fn browser_close() -> Result<(), String> {
    call("browserClose", json!({})).await.map(|_| ())
}

#[tauri::command]
pub async fn browser_hide() -> Result<(), String> {
    call("browserHide", json!({})).await.map(|_| ())
}

/// Вернуть спрятанную страницу. `false` — её нет, надо открывать заново.
#[tauri::command]
pub async fn browser_show(rect: Area) -> Result<bool, String> {
    let v = call("browserShow", json!({ "rect": rect })).await?;
    Ok(v.get("shown").and_then(Value::as_bool).unwrap_or(false))
}
