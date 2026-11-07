//! «СДВГ-режим»: рядом с фильмом без звука крутится второй ролик —
//! Subway Surfers, нарезка мыла, чистка ковров и тому подобное.
//!
//! Это отдельный маленький mpv во втором встроенном окне (video.rs).
//! Ролики ищутся на YouTube через yt-dlp (`ytsearch`), поэтому список
//! не устаревает. Режим у каждого свой — друзьям ничего не отправляется.

use std::sync::Mutex;

use tauri::State;
use tokio::process::{Child, Command};

use crate::video::VideoHost;

/// Что ищем. Каждый запуск — в случайном порядке.
const QUERIES: &[&str] = &[
    "subway surfers gameplay no copyright",
    "minecraft parkour gameplay no copyright",
    "soap cutting asmr no talking",
    "carpet cleaning satisfying",
    "kinetic sand cutting asmr",
    "hydraulic press satisfying",
    "slime asmr satisfying no talking",
    "temple run gameplay no commentary",
];

static SIDE: Mutex<Option<Child>> = Mutex::new(None);

/// Включить (или переключить на другие ролики).
#[tauri::command]
pub async fn adhd_start(host: State<'_, VideoHost>) -> Result<(), String> {
    let Some(wid) = host.side_wid() else {
        return Err("Второе окно для ролика не создалось".into());
    };
    adhd_stop();

    let mut cmd = Command::new(crate::player::find_mpv());
    cmd.args([
        "--idle=no",
        "--force-window=yes",
        "--keep-open=no",
        "--no-terminal",
        "--really-quiet",
        // Только картинка, без звука и без лишних надписей.
        "--aid=no",
        "--mute=yes",
        "--osc=no",
        "--osd-level=0",
        "--no-input-default-bindings",
        "--input-vo-keyboard=no",
        "--cursor-autohide=always",
        "--hwdec=auto-safe",
        "--shuffle",
        "--loop-playlist=inf",
        "--cache=yes",
        "--ytdl-format=bestvideo[height<=?480][vcodec!^=av01]/best[height<=?480]/best",
    ])
    .arg(format!("--wid={wid}"))
    .kill_on_drop(true);
    if let Some(ytdlp) = crate::player::find_ytdlp() {
        cmd.arg(format!("--script-opts=ytdl_hook-ytdl_path={ytdlp}"));
    }
    if let Some(ca) = crate::certs::ca_bundle() {
        cmd.arg(format!("--tls-ca-file={}", ca.display()));
    }
    for query in QUERIES {
        cmd.arg(format!("ytdl://ytsearch4:{query}"));
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd
        .spawn()
        .map_err(|e| format!("Не получилось запустить второй плеер: {e}"))?;
    // Закроется вместе с приложением, как и основной плеер.
    crate::player::bind_to_app_lifetime(&child);
    crate::logs::info("СДВГ-режим: включён");
    *SIDE.lock().unwrap() = Some(child);
    Ok(())
}

/// Выключить: второй плеер закрывается (kill_on_drop).
#[tauri::command]
pub fn adhd_stop() {
    if let Some(mut child) = SIDE.lock().unwrap().take() {
        let _ = child.start_kill();
        crate::logs::info("СДВГ-режим: выключен");
    }
}
