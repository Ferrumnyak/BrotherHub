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
/// macOS: ролик — libmpv в нашем процессе.
#[cfg(target_os = "macos")]
static SIDE_LIB: Mutex<Option<crate::libmpv::Mpv>> = Mutex::new(None);

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
    if let Some(ytdlp) = crate::player::find_ytdlp() {
        cmd.arg(format!("--script-opts=ytdl_hook-ytdl_path={ytdlp}"));
    }
    if let Some(ca) = crate::certs::ca_bundle() {
        cmd.arg(format!("--tls-ca-file={}", ca.display()));
    }
    // macOS: libmpv в нашем процессе, окно — дочернее у главного. Ролики
    // добавляются командами: у библиотеки нет списка файлов в ключах.
    #[cfg(target_os = "macos")]
    {
        // Ждать, пока добавятся ролики, а не закрыться сразу.
        cmd.arg("--idle=once");
        let _ = wid;
        let lib = crate::libmpv::Mpv::start(&crate::libmpv::args_of(&cmd), 1)?;
        for query in QUERIES {
            lib.command(&format!("loadfile \"ytdl://ytsearch4:{query}\" append"));
        }
        lib.command("playlist-shuffle");
        lib.command("playlist-play-index 0");
        crate::logs::info("СДВГ-режим: включён");
        *SIDE_LIB.lock().unwrap() = Some(lib);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
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
}

/// Выключить: второй плеер закрывается (kill_on_drop).
#[tauri::command]
pub fn adhd_stop() {
    #[cfg(target_os = "macos")]
    if SIDE_LIB.lock().unwrap().take().is_some() {
        crate::logs::info("СДВГ-режим: выключен");
    }
    if let Some(mut child) = SIDE.lock().unwrap().take() {
        let _ = child.start_kill();
        crate::logs::info("СДВГ-режим: выключен");
    }
}
