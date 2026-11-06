//! Обновление приложения по кнопке «Обновить».
//!
//! Новая версия описана в `latest.json` последнего релиза на GitHub
//! (его готовит `scripts/release.ps1`):
//!
//! - **установленная версия** обновляется плагином Tauri updater: он
//!   скачивает новый установщик, проверяет подпись (открытый ключ —
//!   `plugins.updater.pubkey` в tauri.conf.json) и ставит его без вопросов;
//! - **portable** (рядом с exe нет `uninstall.exe`) — скачиваем новый
//!   `BrotherHub.exe` из того же релиза, сверяем SHA-256 из `latest.json`
//!   и подменяем себя: работающий exe Windows разрешает переименовать.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::logs;

const LATEST_URL: &str =
    "https://github.com/Ferrumnyak/BrotherHub/releases/latest/download/latest.json";

/// Что предложить пользователю.
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Прогресс скачивания для интерфейса (событие `update-progress`).
#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Deserialize)]
struct Latest {
    version: String,
    notes: Option<String>,
    portable: Option<PortableAsset>,
}

#[derive(Deserialize)]
struct PortableAsset {
    url: String,
    sha256: String,
}

fn current_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// Portable — если рядом нет деинсталлятора, который кладёт установщик.
fn is_portable() -> bool {
    current_exe()
        .and_then(|exe| exe.parent().map(|d| !d.join("uninstall.exe").exists()))
        .unwrap_or(false)
}

/// Старый exe после обновления portable-версии — убрать при запуске.
pub fn cleanup() {
    if let Some(old) = current_exe().map(|exe| exe.with_extension("old.exe")) {
        let _ = std::fs::remove_file(old);
    }
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("BrotherHub/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

async fn latest() -> Result<Latest, String> {
    let bytes = http()?
        .get(LATEST_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Не получилось узнать о новой версии: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Непонятный ответ о новой версии: {e}"))
}

fn newer(app: &AppHandle, version: &str) -> bool {
    let current = &app.package_info().version;
    semver::Version::parse(version.trim_start_matches('v'))
        .map(|v| v > *current)
        .unwrap_or(false)
}

/// Есть ли версия новее этой.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if is_portable() {
        let latest = latest().await?;
        if latest.portable.is_none() || !newer(&app, &latest.version) {
            return Ok(None);
        }
        return Ok(Some(UpdateInfo { version: latest.version, notes: latest.notes }));
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Не получилось узнать о новой версии: {e}"))?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

/// Скачать и поставить новую версию; приложение перезапустится само.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    logs::info("обновление: начинаю");
    if is_portable() {
        return install_portable(&app).await;
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Новой версии нет")?;
    let progress = app.clone();
    let mut downloaded = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| {
            logs::warn(format!("обновление не установилось: {e}"));
            format!("Не получилось обновить: {e}")
        })?;
    // На Windows установщик уже запущен и приложение закрывается само;
    // на всякий случай — перезапуск.
    app.restart();
}

async fn install_portable(app: &AppHandle) -> Result<(), String> {
    let latest = latest().await?;
    let asset = latest.portable.ok_or("В релизе нет portable-версии")?;
    let exe = current_exe().ok_or("Не нашёл, где лежит BrotherHub.exe")?;
    let fresh = exe.with_extension("new.exe");

    let mut response = http()?
        .get(&asset.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Не получилось скачать новую версию: {e}"))?;
    let total = response.content_length();
    let mut data = Vec::with_capacity(total.unwrap_or(0) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Загрузка прервалась: {e}"))?
    {
        data.extend_from_slice(&chunk);
        let _ = app.emit("update-progress", Progress { downloaded: data.len() as u64, total });
    }

    let hash: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
    if !hash.eq_ignore_ascii_case(asset.sha256.trim()) {
        return Err("Скачанный файл повреждён — попробуй ещё раз".into());
    }
    std::fs::write(&fresh, &data).map_err(|e| format!("Не получилось сохранить новую версию: {e}"))?;
    swap(&exe, &fresh)?;
    logs::info(format!("обновление portable до {}", latest.version));
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("Новая версия не запустилась: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Текущий exe → `.old.exe` (его удалит [`cleanup`] при следующем запуске),
/// новый — на его место.
fn swap(exe: &Path, fresh: &Path) -> Result<(), String> {
    let old = exe.with_extension("old.exe");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(exe, &old).map_err(|e| format!("Не получилось заменить программу: {e}"))?;
    if let Err(e) = std::fs::rename(fresh, exe) {
        let _ = std::fs::rename(&old, exe);
        return Err(format!("Не получилось заменить программу: {e}"));
    }
    Ok(())
}
