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

/// Обновление на телефоне — новым APK из релизов.
#[tauri::command]
pub async fn update_check() -> Result<Option<()>, String> {
    Ok(None)
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

#[tauri::command]
pub fn adhd_stop() {}

/// Полный экран на телефоне: альбомная ориентация и без системных панелей.
#[tauri::command]
pub async fn mobile_fullscreen(on: bool) -> Result<(), String> {
    crate::player::call("fullscreen", serde_json::json!({ "on": on }))
        .await
        .map(|_| ())
}
