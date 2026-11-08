//! Команды, которые на телефоне не нужны, но интерфейс их вызывает:
//! отвечаем «ничего не сделано», чтобы не было ошибок. И то, что есть
//! только на телефоне.

/// Ссылка-приглашение brotherhub://…, с которой открыли приложение
/// (её ловит Kotlin-часть, см. PlayerPlugin.kt).
#[tauri::command]
pub async fn deep_link_take() -> Option<String> {
    let v = crate::player::call("takeLink", serde_json::json!({})).await.ok()?;
    v.get("link")?.as_str().map(str::to_string)
}

/// Где описан последний релиз (тот же файл, что и для компьютера).
const LATEST_URL: &str =
    "https://github.com/Ferrumnyak/BrotherHub/releases/latest/download/latest.json";

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// APK из последнего релиза: `(версия, ссылка, что нового)`.
async fn latest_apk() -> Result<Option<(String, String, Option<String>)>, String> {
    let body = reqwest::Client::new()
        .get(LATEST_URL)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?;
    let latest: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "Странный ответ о новой версии".to_string())?;
    let Some(apk) = latest.get("android") else {
        return Ok(None); // в этом релизе APK нет
    };
    let version = apk.get("version").and_then(|v| v.as_str()).unwrap_or_default();
    let url = apk.get("url").and_then(|v| v.as_str()).unwrap_or_default();
    if version.is_empty() || url.is_empty() {
        return Ok(None);
    }
    let notes = latest
        .get("notes")
        .and_then(|v| v.as_str())
        .filter(|n| !n.trim().is_empty())
        .map(str::to_string);
    Ok(Some((version.to_string(), url.to_string(), notes)))
}

/// Есть ли APK новее этого.
#[tauri::command]
pub async fn update_check() -> Result<Option<UpdateInfo>, String> {
    let Some((version, _, notes)) = latest_apk().await? else {
        return Ok(None);
    };
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).ok();
    let newer = semver::Version::parse(version.trim_start_matches('v'))
        .ok()
        .zip(current)
        .is_some_and(|(new, cur)| new > cur);
    Ok(newer.then_some(UpdateInfo { version, notes }))
}

/// Скачать новый APK и открыть установку (Android спросит подтверждение).
#[tauri::command]
pub async fn update_install() -> Result<(), String> {
    let Some((_, url, _)) = latest_apk().await? else {
        return Err("В последнем релизе нет APK".into());
    };
    crate::logs::info(format!("скачиваю обновление: {url}"));
    crate::player::call("installApk", serde_json::json!({ "url": url }))
        .await
        .map(|_| ())
}

#[tauri::command]
pub fn tray_close_to_tray() {}

#[tauri::command]
pub fn ptt_set_key() {}

#[tauri::command]
pub fn mute_set_key() {}

#[tauri::command]
pub fn overlay_close() {}

#[tauri::command]
pub fn reactions_place() {}

/// СДВГ-режим: что искать для ролика рядом с фильмом (как на компьютере).
const ADHD_QUERIES: &[&str] = &[
    "subway surfers gameplay no copyright",
    "minecraft parkour gameplay no copyright",
    "soap cutting asmr no talking",
    "carpet cleaning satisfying",
    "kinetic sand cutting asmr",
    "hydraulic press satisfying",
    "slime asmr satisfying no talking",
    "temple run gameplay no commentary",
];

/// Включить СДВГ-режим (или переключить на другие ролики).
#[tauri::command]
pub async fn adhd_start() -> Result<(), String> {
    crate::player::call("adhdStart", serde_json::json!({ "queries": ADHD_QUERIES }))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn adhd_stop() -> Result<(), String> {
    crate::player::call("adhdStop", serde_json::json!({})).await.map(|_| ())
}

/// Отступы под вырез камеры и полоску жестов (CSS-пиксели).
#[tauri::command]
pub async fn mobile_insets() -> Result<serde_json::Value, String> {
    crate::player::call("insets", serde_json::json!({})).await
}

/// Полный экран на телефоне: альбомная ориентация и без системных панелей.
#[tauri::command]
pub async fn mobile_fullscreen(on: bool) -> Result<(), String> {
    crate::player::call("fullscreen", serde_json::json!({ "on": on }))
        .await
        .map(|_| ())
}

/// Пока ты в зале (`room`), приложение работает и свёрнутым (служба с
/// уведомлением). `mic` — голос подключён: микрофону тоже можно в фоне.
#[tauri::command]
pub async fn mobile_keep_alive(room: Option<String>, mic: bool) -> Result<(), String> {
    crate::player::call("keepAlive", serde_json::json!({ "room": room, "mic": mic }))
        .await
        .map(|_| ())
}

/// «Картинка в картинке»: видео маленьким окном поверх других приложений.
#[tauri::command]
pub async fn mobile_pip() -> Result<(), String> {
    crate::player::call("pip", serde_json::json!({})).await.map(|_| ())
}

/// Что за устройство: телевизор (управление пультом) или телефон.
#[tauri::command]
pub async fn mobile_info() -> Result<serde_json::Value, String> {
    crate::player::call("info", serde_json::json!({})).await
}
