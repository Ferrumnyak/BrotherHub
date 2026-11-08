//! Установка плеера при первом запуске.
//!
//! mpv и yt-dlp не входят в установщик (вместе это ~60 МБ — больше, чем всё
//! остальное приложение). Если их нет ни рядом с BrotherHub.exe, ни в
//! системе, приложение при первом запуске скачивает их в свою папку данных
//! `%LOCALAPPDATA%\com.ferrumnyak.brotherwatch\` (см. [`tools_dir`]):
//!
//! - mpv — архив из релизов BrotherHub на GitHub. Адрес и SHA-256 архива
//!   записаны в `player-pack.json` (его заполняет `scripts/pack-player.ps1`),
//!   поэтому версия mpv закреплена и меняется только вместе с приложением.
//!   На macOS mpv — библиотека libmpv (libmpv.rs), пока из Homebrew
//!   (`brew install mpv`): её не скачиваем;
//! - yt-dlp — последняя версия с официальной страницы релизов, с проверкой
//!   по файлу `SHA2-256SUMS` оттуда же. Дальше он обновляет себя сам
//!   (см. [`crate::player::update_bundled_ytdlp`]).

use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::{io::AsyncWriteExt, sync::Mutex};

use crate::player;

/// Совпадает с `identifier` в tauri.conf.json: эту же папку использует
/// WebView2, и деинсталлятор предлагает удалить её вместе с данными.
const APP_ID: &str = "com.ferrumnyak.brotherwatch";

/// Файл yt-dlp в релизах: для Windows — exe, для macOS — универсальная
/// программа (Apple Silicon и Intel).
#[cfg(not(target_os = "macos"))]
const YTDLP_ASSET: &str = "yt-dlp.exe";
#[cfg(target_os = "macos")]
const YTDLP_ASSET: &str = "yt-dlp_macos";
const YTDLP_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
const YTDLP_SUMS_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

/// Какой архив mpv скачивать (см. `scripts/pack-player.ps1`).
#[cfg_attr(target_os = "macos", allow(dead_code))]
const MPV_PACK: &str = include_str!("../player-pack.json");

#[derive(Deserialize)]
#[cfg_attr(target_os = "macos", allow(dead_code))]
struct MpvPack {
    url: String,
    sha256: String,
    size: u64,
}



/// Папка, куда скачиваются mpv и yt-dlp.
pub fn tools_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    // ~/Library/Application Support — там же папка данных WebView (Tauri).
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"));
    base.map(|b| b.join(APP_ID))
}

/// Что из плеера уже есть на компьютере.
#[derive(Serialize)]
pub struct ToolsStatus {
    mpv: bool,
    ytdlp: bool,
}

#[tauri::command]
pub fn player_tools() -> ToolsStatus {
    ToolsStatus {
        mpv: player::mpv_available(),
        ytdlp: player::ytdlp_available(),
    }
}

/// Ход установки для экрана «Готовлю плеер».
#[derive(Clone, Serialize)]
struct Progress {
    /// `"mpv"`, `"yt-dlp"` или `"unpack"`.
    stage: &'static str,
    done: u64,
    total: Option<u64>,
}

/// Скачать недостающие mpv и yt-dlp.
#[tauri::command]
pub async fn player_setup(app: AppHandle) -> Result<(), String> {
    // Двойной вызов (например, повторный рендер интерфейса) ждёт первый
    // и затем видит, что всё уже скачано.
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock().await;

    let need_mpv = !player::mpv_available();
    let need_ytdlp = !player::ytdlp_available();
    if !need_mpv && !need_ytdlp {
        return Ok(());
    }

    let dir = tools_dir().ok_or("Не нашёл папку для плеера.")?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Не удалось создать папку {}: {e}", dir.display()))?;

    let client = reqwest::Client::builder()
        .user_agent(concat!("BrotherHub/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Не удалось подготовить загрузку: {e}"))?;

    crate::logs::info(format!(
        "скачиваю плеер в {} (mpv: {need_mpv}, yt-dlp: {need_ytdlp})",
        dir.display()
    ));
    let result = async {
        if need_mpv {
            install_mpv(&app, &client, &dir).await?;
        }
        if need_ytdlp {
            install_ytdlp(&app, &client, &dir).await?;
        }
        Ok::<(), String>(())
    }
    .await;
    match &result {
        Ok(()) => crate::logs::info("плеер скачан"),
        Err(e) => crate::logs::error(format!("не удалось скачать плеер: {e}")),
    }
    result
}

/// macOS: libmpv пока не скачиваем — её ставит Homebrew.
#[cfg(target_os = "macos")]
async fn install_mpv(_app: &AppHandle, _client: &reqwest::Client, _dir: &Path) -> Result<(), String> {
    Err("Для видео нужен mpv. Поставь его в Терминале: brew install mpv (Homebrew — https://brew.sh) и перезапусти BrotherHub.".into())
}

#[cfg(not(target_os = "macos"))]
async fn install_mpv(app: &AppHandle, client: &reqwest::Client, dir: &Path) -> Result<(), String> {
    let pack: MpvPack = serde_json::from_str(MPV_PACK)
        .map_err(|e| format!("Испорчен player-pack.json: {e}"))?;
    crate::logs::info(format!("mpv: {}", pack.url));
    if pack.url.is_empty() || pack.sha256.is_empty() {
        return Err(
            "В эту сборку не вписан адрес плеера (player-pack.json). Собери её заново после scripts\\pack-player.ps1."
                .into(),
        );
    }

    let archive = dir.join("mpv-download.zip");
    let hash = download(app, client, &pack.url, &archive, "mpv", Some(pack.size)).await?;
    if !hash.eq_ignore_ascii_case(&pack.sha256) {
        let _ = tokio::fs::remove_file(&archive).await;
        return Err("Скачанный плеер повреждён (не совпала контрольная сумма). Попробуй ещё раз.".into());
    }

    emit(app, "unpack", 0, None);
    let fresh = dir.join("mpv.new");
    let _ = tokio::fs::remove_dir_all(&fresh).await;
    tokio::fs::create_dir_all(&fresh)
        .await
        .map_err(|e| format!("Не удалось создать папку {}: {e}", fresh.display()))?;
    let unpacked = unzip(&archive, &fresh).await;
    let _ = tokio::fs::remove_file(&archive).await;
    unpacked?;
    if !fresh.join(player::exe_name("mpv")).is_file() {
        let _ = tokio::fs::remove_dir_all(&fresh).await;
        return Err("В архиве плеера нет mpv.".into());
    }

    let target = dir.join("mpv");
    let _ = tokio::fs::remove_dir_all(&target).await;
    tokio::fs::rename(&fresh, &target)
        .await
        .map_err(|e| format!("Не удалось положить плеер в {}: {e}", target.display()))?;
    Ok(())
}

async fn install_ytdlp(app: &AppHandle, client: &reqwest::Client, dir: &Path) -> Result<(), String> {
    let target_dir = dir.join("yt-dlp");
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("Не удалось создать папку {}: {e}", target_dir.display()))?;

    let sums = client
        .get(YTDLP_SUMS_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(net_error)?
        .text()
        .await
        .map_err(net_error)?;
    let expected = sums
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?, parts.next()?))
        })
        .find(|(_, name)| *name == YTDLP_ASSET)
        .map(|(hash, _)| hash.to_owned())
        .ok_or("Не нашёл контрольную сумму yt-dlp на странице релизов.")?;

    let part = target_dir.join("yt-dlp.part");
    let url = format!("{YTDLP_BASE}{YTDLP_ASSET}");
    let hash = download(app, client, &url, &part, "yt-dlp", None).await?;
    if !hash.eq_ignore_ascii_case(&expected) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("Скачанный yt-dlp повреждён (не совпала контрольная сумма). Попробуй ещё раз.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| format!("Не удалось сделать yt-dlp запускаемым: {e}"))?;
    }
    let exe = target_dir.join(player::exe_name("yt-dlp"));
    tokio::fs::rename(&part, &exe)
        .await
        .map_err(|e| format!("Не удалось положить yt-dlp в {}: {e}", exe.display()))?;
    Ok(())
}

/// Скачать `url` в файл `dest`, сообщая ход загрузки. Возвращает SHA-256
/// скачанного (строчными шестнадцатеричными цифрами).
async fn download(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    stage: &'static str,
    expected_size: Option<u64>,
) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(net_error)?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!(
            "Файл {stage} не найден на GitHub (404) — похоже, его ещё не выложили или удалили: {url}"
        ));
    }
    let mut resp = resp.error_for_status().map_err(net_error)?;
    let total = resp.content_length().or(expected_size);

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Не удалось создать {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut reported = 0u64;
    emit(app, stage, 0, total);

    let result: Result<(), String> = async {
        loop {
            let chunk = tokio::time::timeout(Duration::from_secs(30), resp.chunk())
                .await
                .map_err(|_| "Загрузка остановилась. Проверь интернет и попробуй ещё раз.".to_string())?
                .map_err(net_error)?;
            let Some(chunk) = chunk else { break };
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Не удалось записать {}: {e}", dest.display()))?;
            done += chunk.len() as u64;
            if done - reported >= 256 * 1024 {
                reported = done;
                emit(app, stage, done, total);
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("Не удалось записать {}: {e}", dest.display()))
    }
    .await;
    drop(file);

    if let Err(e) = result {
        let _ = tokio::fs::remove_file(dest).await;
        return Err(e);
    }
    emit(app, stage, done, total);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Распаковать zip встроенным в Windows 10/11 `tar.exe`, а если его нет —
/// через PowerShell.
#[cfg(not(target_os = "macos"))]
pub(crate) async fn unzip(archive: &Path, dest: &Path) -> Result<(), String> {
    let tar = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("tar.exe"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("tar"));
    let mut cmd = tokio::process::Command::new(tar);
    cmd.arg("-xf").arg(archive).arg("-C").arg(dest);
    if run_hidden(cmd).await {
        return Ok(());
    }

    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        archive.display().to_string().replace('\'', "''"),
        dest.display().to_string().replace('\'', "''"),
    );
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    if run_hidden(cmd).await {
        return Ok(());
    }
    Err("Не удалось распаковать плеер.".into())
}

/// Запустить команду без консольного окна; `true`, если она завершилась успешно.
#[cfg(not(target_os = "macos"))]
async fn run_hidden(mut cmd: tokio::process::Command) -> bool {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    matches!(cmd.status().await, Ok(status) if status.success())
}

fn emit(app: &AppHandle, stage: &'static str, done: u64, total: Option<u64>) {
    let _ = app.emit("player-setup", Progress { stage, done, total });
}

fn net_error(e: reqwest::Error) -> String {
    if e.is_timeout() || e.is_connect() {
        "Нет связи с GitHub. Проверь интернет и попробуй ещё раз.".into()
    } else if let Some(status) = e.status() {
        format!("GitHub ответил ошибкой {status}. Попробуй ещё раз позже.")
    } else {
        format!("Ошибка загрузки: {e}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_file_parses() {
        let pack: MpvPack = serde_json::from_str(MPV_PACK).unwrap();
        // Пустые поля допустимы до первого запуска pack-player.ps1.
        assert_eq!(pack.url.is_empty(), pack.sha256.is_empty());
        if !pack.sha256.is_empty() {
            assert_eq!(pack.sha256.len(), 64);
            assert!(pack.size > 0);
        }
    }
}
