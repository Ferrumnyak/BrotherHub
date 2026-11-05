//! Встраивание видео mpv в окно приложения.
//!
//! На Windows внутри главного окна создаётся дочернее окно, и mpv рисует
//! в него картинку (опция `--wid`). Интерфейс сообщает, где на экране
//! находится область видео, и мы двигаем это окно туда.
//!
//! На других системах встраивания нет — mpv открывается отдельным окном.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, State, WebviewWindow};

/// Дочернее окно для видео.
#[derive(Default)]
pub struct VideoHost {
    /// HWND окна. Храним числом: так его можно передавать между потоками.
    hwnd: Mutex<Option<isize>>,
}

impl VideoHost {
    /// Идентификатор окна для `mpv --wid`.
    pub fn wid(&self) -> Option<isize> {
        *self.hwnd.lock().unwrap()
    }
}

/// Прямоугольник в физических пикселях относительно окна приложения.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// Создать дочернее окно для видео. Вызывать в главном потоке.
#[cfg(windows)]
pub fn create(window: &WebviewWindow, host: &VideoHost) -> Result<(), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WS_CHILD, WS_CLIPSIBLINGS};

    /// Статическое окно, залитое чёрным.
    const SS_BLACKRECT: u32 = 0x0004;
    /// Без этого флага static-окно «прозрачно» для мыши.
    const SS_NOTIFY: u32 = 0x0100;

    let handle = window.window_handle().map_err(|e| e.to_string())?;
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return Err("окно приложения не является Win32-окном".into());
    };
    let parent = win32.hwnd.get() as HWND;

    let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
    // Окно создаётся скрытым и показывается, когда интерфейс скажет, где оно.
    let child = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_CLIPSIBLINGS | SS_BLACKRECT | SS_NOTIFY,
            0,
            0,
            0,
            0,
            parent,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    };
    if child.is_null() {
        return Err("не удалось создать окно для видео".into());
    }
    *host.hwnd.lock().unwrap() = Some(child as isize);
    Ok(())
}

#[cfg(not(windows))]
pub fn create(_window: &WebviewWindow, _host: &VideoHost) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn place(hwnd: isize, rect: Option<Rect>) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
    };
    let hwnd = hwnd as HWND;
    unsafe {
        match rect {
            Some(r) if r.width > 0 && r.height > 0 => {
                // HWND_TOP — поверх веб-интерфейса.
                SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    r.x,
                    r.y,
                    r.width,
                    r.height,
                    SWP_SHOWWINDOW | SWP_NOACTIVATE,
                );
            }
            _ => {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

#[cfg(not(windows))]
fn place(_hwnd: isize, _rect: Option<Rect>) {}

/// Следить за движением мыши (для автоскрытия панели в полном экране).
///
/// Над видео мышь «принадлежит» окну mpv, и интерфейс её движения не видит,
/// поэтому положение курсора проверяется напрямую у Windows. При движении
/// приходит событие `cursor-moved`.
#[tauri::command]
pub fn watch_cursor(app: AppHandle, enabled: bool) {
    cursor::watch(app, enabled);
}

#[cfg(windows)]
mod cursor {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    };
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    static WATCHING: AtomicBool = AtomicBool::new(false);
    static STARTED: OnceLock<()> = OnceLock::new();

    pub fn watch(app: AppHandle, enabled: bool) {
        WATCHING.store(enabled, Ordering::SeqCst);
        STARTED.get_or_init(|| {
            std::thread::spawn(move || {
                let mut last = (i32::MIN, i32::MIN);
                loop {
                    std::thread::sleep(Duration::from_millis(120));
                    if !WATCHING.load(Ordering::SeqCst) {
                        continue;
                    }
                    let mut p = POINT { x: 0, y: 0 };
                    if unsafe { GetCursorPos(&mut p) } == 0 {
                        continue;
                    }
                    if (p.x, p.y) != last {
                        if last.0 != i32::MIN {
                            let _ = app.emit("cursor-moved", ());
                        }
                        last = (p.x, p.y);
                    }
                }
            });
        });
    }
}

#[cfg(not(windows))]
mod cursor {
    use tauri::AppHandle;

    pub fn watch(_app: AppHandle, _enabled: bool) {}
}

/// Интерфейс сообщает, где показать видео (`None` — спрятать).
#[tauri::command]
pub fn set_video_rect(
    app: AppHandle,
    host: State<'_, VideoHost>,
    rect: Option<Rect>,
) -> Result<(), String> {
    let Some(hwnd) = host.wid() else {
        return Ok(());
    };
    app.run_on_main_thread(move || place(hwnd, rect))
        .map_err(|e| e.to_string())
}
