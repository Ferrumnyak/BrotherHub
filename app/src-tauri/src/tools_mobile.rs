//! Папка данных на телефоне. Плеер (ExoPlayer и yt-dlp) уже внутри APK —
//! скачивать ничего не нужно.

use std::{path::PathBuf, sync::OnceLock};

use serde::Serialize;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Задать папку данных приложения (из lib.rs при запуске).
pub fn set_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// Папка данных приложения (там же логи).
pub fn tools_dir() -> Option<PathBuf> {
    DATA_DIR.get().cloned()
}

#[derive(Serialize)]
pub struct ToolsStatus {
    mpv: bool,
    ytdlp: bool,
}

#[tauri::command]
pub fn player_tools() -> ToolsStatus {
    ToolsStatus {
        mpv: true,
        ytdlp: true,
    }
}

#[tauri::command]
pub async fn player_setup() -> Result<(), String> {
    Ok(())
}
