//! Журнал для разбора проблем у друзей.
//!
//! Логи лежат в `%LOCALAPPDATA%\com.ferrumnyak.brotherwatch\logs\`:
//! папка `1` — текущий (или последний) запуск, `2`…`5` — предыдущие.
//! В каждой — `brotherwatch.log` (приложение) и `mpv-<n>.log` (плеер вместе
//! с выводом yt-dlp; `n` — номер запуска плеера за сеанс).
//!
//! Пароли и токены в журнал не пишем.

use std::{
    fs::File,
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

/// Сколько последних запусков хранить.
const KEEP: usize = 5;

static SESSION_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static FILE: Mutex<Option<File>> = Mutex::new(None);

/// Папка со всеми логами.
pub fn logs_root() -> Option<PathBuf> {
    crate::tools::tools_dir().map(|d| d.join("logs"))
}

/// Начать журнал этого запуска. Вызывается один раз в самом начале.
pub fn init() {
    let dir = SESSION_DIR.get_or_init(|| {
        let root = logs_root()?;
        std::fs::create_dir_all(&root).ok()?;
        // Сдвигаем прошлые запуски: 4 → 5, 3 → 4, …, 1 → 2; самый старый удаляем.
        let _ = std::fs::remove_dir_all(root.join(KEEP.to_string()));
        for n in (1..KEEP).rev() {
            let _ = std::fs::rename(root.join(n.to_string()), root.join((n + 1).to_string()));
        }
        let dir = root.join("1");
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    });
    if let Some(dir) = dir {
        if let Ok(file) = File::create(dir.join("brotherwatch.log")) {
            if let Ok(mut guard) = FILE.lock() {
                *guard = Some(file);
            }
        }
    }

    // Падение приложения тоже попадёт в журнал.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        error(format!("сбой: {panic}"));
        default_hook(panic);
    }));

    info(format!(
        "BrotherHub {} ({} {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
}

/// Куда mpv с номером `id` пишет свой журнал (только на компьютере).
#[cfg_attr(mobile, allow(dead_code))]
pub fn mpv_log_path(id: u64) -> Option<PathBuf> {
    SESSION_DIR
        .get()
        .cloned()
        .flatten()
        .map(|d| d.join(format!("mpv-{id}.log")))
}

pub fn info(msg: impl AsRef<str>) {
    write("info", msg.as_ref());
}

pub fn warn(msg: impl AsRef<str>) {
    write("warn", msg.as_ref());
}

pub fn error(msg: impl AsRef<str>) {
    write("error", msg.as_ref());
}

fn write(level: &str, msg: &str) {
    let line = format!("{} [{level}] {msg}\n", timestamp());
    #[cfg(debug_assertions)]
    eprint!("{line}");
    // Android: ещё и в logcat (adb logcat -s BrotherHub), файл с телефона
    // не достать.
    #[cfg(target_os = "android")]
    android_log(level, msg);
    if let Ok(mut guard) = FILE.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }
}

#[cfg(target_os = "android")]
fn android_log(level: &str, msg: &str) {
    use std::ffi::CString;
    extern "C" {
        fn __android_log_write(prio: i32, tag: *const std::ffi::c_char, text: *const std::ffi::c_char) -> i32;
    }
    // 4 — INFO, 5 — WARN, 6 — ERROR.
    let prio = match level {
        "error" => 6,
        "warn" => 5,
        _ => 4,
    };
    let tag = CString::new("BrotherHub").unwrap();
    let Ok(text) = CString::new(msg.replace('\0', " ")) else { return };
    unsafe {
        __android_log_write(prio, tag.as_ptr(), text.as_ptr());
    }
}

/// Строчка в журнал от интерфейса (что делал пользователь перед сбоем).
#[tauri::command]
pub fn ui_log(message: String) {
    info(format!("интерфейс: {}", message.chars().take(200).collect::<String>()));
}

/// Открыть папку с логами (только на компьютере).
#[cfg_attr(mobile, allow(dead_code))]
#[tauri::command]
pub fn open_logs() -> Result<(), String> {
    let root = logs_root().ok_or("Не нашёл папку с логами.")?;
    std::fs::create_dir_all(&root).map_err(|e| format!("Не удалось создать {}: {e}", root.display()))?;
    #[cfg(windows)]
    let opener = "explorer";
    #[cfg(not(windows))]
    let opener = "xdg-open";
    std::process::Command::new(opener)
        .arg(&root)
        .spawn()
        .map_err(|e| format!("Не удалось открыть папку с логами: {e}"))?;
    Ok(())
}

/// Местное время — так друзьям проще сопоставить запись с тем, что было.
#[cfg(windows)]
fn timestamp() -> String {
    use windows_sys::Win32::{Foundation::SYSTEMTIME, System::SystemInformation::GetLocalTime};
    let mut t: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
    )
}

#[cfg(not(windows))]
fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}
