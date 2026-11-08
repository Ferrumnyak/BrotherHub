//! Встраивание видео mpv в окно приложения.
//!
//! На Windows внутри главного окна создаётся дочернее окно, и mpv рисует
//! в него картинку (опция `--wid`). Интерфейс сообщает, где на экране
//! находится область видео, и мы двигаем это окно туда.
//!
//! На macOS mpv работает как библиотека внутри приложения (libmpv.rs), а
//! его окно без рамки становится дочерним окном главного: macOS двигает его
//! вместе с главным, переносит на другой рабочий стол и в полный экран.
//! Интерфейс так же сообщает место, мы ставим туда окно (модуль `mac`).

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, State, WebviewWindow};

/// Дочернее окно для видео.
#[derive(Default)]
pub struct VideoHost {
    /// HWND окна. Храним числом: так его можно передавать между потоками.
    hwnd: Mutex<Option<isize>>,
    /// Второе окно — для ролика сбоку в «СДВГ-режиме» (adhd.rs).
    side: Mutex<Option<isize>>,
}

impl VideoHost {
    /// Идентификатор окна для `mpv --wid` (на macOS — номер места: 0 или 1,
    /// см. модуль `mac`).
    pub fn wid(&self) -> Option<isize> {
        *self.hwnd.lock().unwrap()
    }

    /// Окно для ролика сбоку.
    pub fn side_wid(&self) -> Option<isize> {
        *self.side.lock().unwrap()
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
    let make = || unsafe {
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
    let child = make();
    if child.is_null() {
        return Err("не удалось создать окно для видео".into());
    }
    *host.hwnd.lock().unwrap() = Some(child as isize);
    let side = make();
    if !side.is_null() {
        *host.side.lock().unwrap() = Some(side as isize);
    }
    Ok(())
}

/// macOS: места для окон mpv — 0 (фильм) и 1 (ролик сбоку).
#[cfg(target_os = "macos")]
pub fn create(window: &WebviewWindow, host: &VideoHost) -> Result<(), String> {
    mac::init(window.clone());
    *host.hwnd.lock().unwrap() = Some(0);
    *host.side.lock().unwrap() = Some(1);
    Ok(())
}

/// macOS: у mpv на месте `slot` появилось окно — привязать к главному.
#[cfg(target_os = "macos")]
pub fn adopt(slot: usize, window: isize) {
    mac::adopt(slot, window);
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn create(_window: &WebviewWindow, _host: &VideoHost) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn place(hwnd: isize, rect: Option<Rect>, radius: u32) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
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
                // Скруглённые углы, как у области видео в интерфейсе.
                // Windows сама освобождает регион, отданный окну.
                let region = if radius > 0 {
                    let d = (radius * 2) as i32;
                    CreateRoundRectRgn(0, 0, r.width + 1, r.height + 1, d, d)
                } else {
                    std::ptr::null_mut()
                };
                SetWindowRgn(hwnd, region, 1);
            }
            _ => {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn place(slot: isize, rect: Option<Rect>, radius: u32) {
    mac::place(slot as usize, rect, radius);
}

#[cfg(not(any(windows, target_os = "macos")))]
fn place(_hwnd: isize, _rect: Option<Rect>, _radius: u32) {}

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
                            // Экранные координаты в физических пикселях.
                            let _ = app.emit("cursor-moved", (p.x, p.y));
                        }
                        last = (p.x, p.y);
                    }
                }
            });
        });
    }
}

/// Другие системы: положение курсора спрашиваем у Tauri.
#[cfg(not(windows))]
mod cursor {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    };
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};

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
                    let Ok(p) = app.cursor_position() else {
                        continue;
                    };
                    let p = (p.x.round() as i32, p.y.round() as i32);
                    if p != last {
                        if last.0 != i32::MIN {
                            // Экранные координаты в физических пикселях.
                            let _ = app.emit("cursor-moved", p);
                        }
                        last = p;
                    }
                }
            });
        });
    }
}

/// Интерфейс сообщает, где показать видео (`None` — спрятать).
#[tauri::command]
pub fn set_video_rect(
    app: AppHandle,
    host: State<'_, VideoHost>,
    rect: Option<Rect>,
    radius: Option<u32>,
) -> Result<(), String> {
    let Some(hwnd) = host.wid() else {
        return Ok(());
    };
    let radius = radius.unwrap_or(0);
    app.run_on_main_thread(move || place(hwnd, rect, radius))
        .map_err(|e| e.to_string())
}

/// Где показать ролик сбоку («СДВГ-режим»; `None` — спрятать).
#[tauri::command]
pub fn set_side_rect(
    app: AppHandle,
    host: State<'_, VideoHost>,
    rect: Option<Rect>,
    radius: Option<u32>,
) -> Result<(), String> {
    let Some(hwnd) = host.side_wid() else {
        return Ok(());
    };
    let radius = radius.unwrap_or(0);
    app.run_on_main_thread(move || place(hwnd, rect, radius))
        .map_err(|e| e.to_string())
}

/// Полный экран главного окна. На macOS — «простой» полный экран в том же
/// рабочем столе: окна поверх видео (панель, реакции) так надёжнее
/// остаются над главным окном.
#[tauri::command]
pub fn window_fullscreen(window: WebviewWindow, on: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.set_simple_fullscreen(on).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_fullscreen(on).map_err(|e| e.to_string())
    }
}

/// macOS: окна mpv — дочерние окна главного над областью видео.
#[cfg(target_os = "macos")]
mod mac {
    use std::sync::{Mutex, OnceLock};

    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use tauri::{Manager, WebviewWindow};

    use super::Rect;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    /// NSWindowOrderingMode.
    const ABOVE: isize = 1;
    /// Окна поверх видео — после окна mpv заново кладутся над ним.
    const ABOVE_VIDEO: &[&str] = &["controls", "reactions"];

    static MAIN: OnceLock<WebviewWindow> = OnceLock::new();

    #[derive(Default, Clone, Copy)]
    struct Slot {
        /// NSWindow mpv (0 — ещё нет).
        window: usize,
        rect: Option<Rect>,
        radius: u32,
    }

    fn slots() -> &'static Mutex<[Slot; 2]> {
        static SLOTS: OnceLock<Mutex<[Slot; 2]>> = OnceLock::new();
        SLOTS.get_or_init(Default::default)
    }

    pub fn init(window: WebviewWindow) {
        let _ = MAIN.set(window);
    }

    fn ns(window: &WebviewWindow) -> Option<*mut AnyObject> {
        window.ns_window().ok().map(|p| p as *mut AnyObject).filter(|p| !p.is_null())
    }

    /// Окно mpv появилось: сделать его дочерним у главного (в главном потоке).
    pub fn adopt(slot: usize, window: isize) {
        let Some(main) = MAIN.get() else {
            return;
        };
        slots().lock().unwrap()[slot].window = window as usize;
        let main2 = main.clone();
        let _ = main.run_on_main_thread(move || unsafe {
            let Some(parent) = ns(&main2) else {
                return;
            };
            let win = window as *mut AnyObject;
            let _: () = msg_send![win, setHasShadow: false];
            let _: () = msg_send![win, setAlphaValue: 0.0f64];
            let _: () = msg_send![win, setIgnoresMouseEvents: true];
            let _: () = msg_send![parent, addChildWindow: win, ordered: ABOVE];
            raise_above_video(&main2, parent);
            // mpv ставит своё меню (File, Edit, …) — возвращаем меню приложения.
            let app = main2.app_handle();
            if let Ok(menu) = tauri::menu::Menu::default(app) {
                let _ = app.set_menu(menu);
            }
            apply(&main2, slot);
            crate::logs::info(format!("окно видео {slot} привязано к главному"));
        });
    }

    /// Панель и реакции — снова над окнами mpv: дочерние окна лежат в
    /// порядке добавления, поэтому их переподвешиваем.
    unsafe fn raise_above_video(main: &WebviewWindow, parent: *mut AnyObject) {
        for label in ABOVE_VIDEO {
            if let Some(w) = main.app_handle().get_webview_window(label) {
                if let Some(child) = ns(&w) {
                    let _: () = msg_send![parent, removeChildWindow: child];
                    let _: () = msg_send![parent, addChildWindow: child, ordered: ABOVE];
                }
            }
        }
    }

    /// Интерфейс сообщил место (вызывается в главном потоке).
    pub fn place(slot: usize, rect: Option<Rect>, radius: u32) {
        {
            let mut slots = slots().lock().unwrap();
            slots[slot].rect = rect;
            slots[slot].radius = radius;
        }
        if let Some(main) = MAIN.get() {
            unsafe { apply(main, slot) };
            if rect.is_some() {
                if let Some(parent) = ns(main) {
                    unsafe { raise_above_video(main, parent) };
                }
            }
        }
    }

    unsafe fn apply(main: &WebviewWindow, slot: usize) {
        let s = slots().lock().unwrap()[slot];
        if s.window == 0 {
            return;
        }
        let win = s.window as *mut AnyObject;
        let Some(parent) = ns(main) else {
            return;
        };
        match s.rect {
            Some(r) if r.width > 0 && r.height > 0 => {
                let scale = main.scale_factor().unwrap_or(1.0);
                // Содержимое главного окна в координатах экрана (Y снизу вверх).
                let frame: CGRect = msg_send![parent, frame];
                let content: CGRect = msg_send![parent, contentRectForFrameRect: frame];
                let (w, h) = (r.width as f64 / scale, r.height as f64 / scale);
                let x = content.origin.x + r.x as f64 / scale;
                let y = content.origin.y + content.size.height - r.y as f64 / scale - h;
                let target = CGRect {
                    origin: CGPoint { x, y },
                    size: CGSize { width: w, height: h },
                };
                let _: () = msg_send![win, setFrame: target, display: true];
                // Скруглённые углы, как у области видео в интерфейсе.
                let view: *mut AnyObject = msg_send![win, contentView];
                if !view.is_null() {
                    let _: () = msg_send![view, setWantsLayer: true];
                    let layer: *mut AnyObject = msg_send![view, layer];
                    if !layer.is_null() {
                        let _: () = msg_send![layer, setCornerRadius: s.radius as f64 / scale];
                        let _: () = msg_send![layer, setMasksToBounds: true];
                    }
                    let _: () = msg_send![win, setOpaque: false];
                    let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
                    let _: () = msg_send![win, setBackgroundColor: clear];
                }
                let _: () = msg_send![win, setIgnoresMouseEvents: false];
                let _: () = msg_send![win, setAlphaValue: 1.0f64];
            }
            // Спрятать — прозрачностью: видео не останавливается и не
            // перезагружается.
            _ => {
                let _: () = msg_send![win, setAlphaValue: 0.0f64];
                let _: () = msg_send![win, setIgnoresMouseEvents: true];
            }
        }
    }
}
