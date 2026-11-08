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
    #[cfg(not(target_os = "macos"))]
    let Some(wid) = host.side_wid() else {
        return Err("Второе окно для ролика не создалось".into());
    };
    // macOS: у ролика своё окно над местом сбоку (video.rs).
    #[cfg(target_os = "macos")]
    let _ = &host;
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
        // Заполнить место целиком, обрезав края, — без чёрных полос.
        "--panscan=1.0",
        "--hwdec=auto-safe",
        "--shuffle",
        "--loop-playlist=inf",
        "--cache=yes",
        "--ytdl-format=bestvideo[height<=?480][vcodec!^=av01]/best[height<=?480]/best",
    ])
    .kill_on_drop(true);
    #[cfg(not(target_os = "macos"))]
    cmd.arg(format!("--wid={wid}"));
    #[cfg(target_os = "macos")]
    let ipc = {
        let ipc = crate::player::ipc_path(u64::MAX);
        cmd.args(crate::video::mac::spawn_args());
        // Прячется ролик выключением видео (`vid=no`); без звуковой дорожки
        // mpv счёл бы ролик законченным и листал бы дальше — поэтому звук
        // есть, но выключен (`--mute=yes`).
        cmd.args([
            "--aid=auto",
            "--ytdl-format=bestvideo[height<=?480][vcodec!^=av01]+bestaudio/best[height<=?480]/best",
        ]);
        cmd.arg(format!("--input-ipc-server={ipc}"));
        ipc
    };
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
    #[allow(unused_mut)]
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Не получилось запустить второй плеер: {e}"))?;
    // Закроется вместе с приложением, как и основной плеер.
    crate::player::bind_to_app_lifetime(&child);
    #[cfg(target_os = "macos")]
    {
        let tx = crate::player::command_channel(&ipc, &mut child).await?;
        crate::video::mac::attach(true, tx);
    }
    crate::logs::info("СДВГ-режим: включён");
    *SIDE.lock().unwrap() = Some(child);
    Ok(())
}

/// Выключить: второй плеер закрывается (kill_on_drop).
#[tauri::command]
pub fn adhd_stop() {
    #[cfg(target_os = "macos")]
    crate::video::mac::detach(true);
    if let Some(mut child) = SIDE.lock().unwrap().take() {
        let _ = child.start_kill();
        crate::logs::info("СДВГ-режим: выключен");
    }
}
