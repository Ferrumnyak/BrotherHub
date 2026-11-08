//! Встраивание видео mpv в окно приложения.
//!
//! На Windows внутри главного окна создаётся дочернее окно, и mpv рисует
//! в него картинку (опция `--wid`). Интерфейс сообщает, где на экране
//! находится область видео, и мы двигаем это окно туда.
//!
//! На macOS чужое окно встроить нельзя (`--wid` там работает только для
//! libmpv внутри самого приложения), поэтому mpv открывает своё окно без
//! рамки, а мы держим его ровно над областью видео: двигаем вслед за
//! главным окном и поднимаем над ним, пока приложение активно (модуль [`mac`]).

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
    /// Идентификатор окна для `mpv --wid` (на macOS — нет, см. [`mac`]).
    pub fn wid(&self) -> Option<isize> {
        *self.hwnd.lock().unwrap()
    }

    /// Окно для ролика сбоку.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
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

#[cfg(target_os = "macos")]
pub fn create(window: &WebviewWindow, _host: &VideoHost) -> Result<(), String> {
    mac::init(window.clone());
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn create(_window: &WebviewWindow, _host: &VideoHost) -> Result<(), String> {
    Ok(())
}

/// Главное окно сдвинули, поменяли размер, свернули или переключились
/// на другое приложение — на macOS окно mpv подстраивается (см. [`mac`]).
pub fn follow() {
    #[cfg(target_os = "macos")]
    mac::apply();
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
    #[cfg(target_os = "macos")]
    {
        let _ = (&app, &host, radius);
        mac::set_rect(false, rect);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Some(hwnd) = host.wid() else {
            return Ok(());
        };
        let radius = radius.unwrap_or(0);
        app.run_on_main_thread(move || place(hwnd, rect, radius))
            .map_err(|e| e.to_string())
    }
}

/// Где показать ролик сбоку («СДВГ-режим»; `None` — спрятать).
#[tauri::command]
pub fn set_side_rect(
    app: AppHandle,
    host: State<'_, VideoHost>,
    rect: Option<Rect>,
    radius: Option<u32>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = (&app, &host, radius);
        mac::set_rect(true, rect);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Some(hwnd) = host.side_wid() else {
            return Ok(());
        };
        let radius = radius.unwrap_or(0);
        app.run_on_main_thread(move || place(hwnd, rect, radius))
            .map_err(|e| e.to_string())
    }
}

/// Полный экран главного окна. На macOS — «простой» полный экран в том же
/// рабочем столе: обычный уводит окно на отдельный Space, куда окно mpv
/// (другая программа) не попадает, и видео пропадало бы.
#[tauri::command]
pub fn window_fullscreen(window: WebviewWindow, on: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.set_simple_fullscreen(on).map_err(|e| e.to_string())?;
        mac::apply();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_fullscreen(on).map_err(|e| e.to_string())
    }
}

/// macOS: окно mpv поверх области видео.
///
/// mpv здесь — отдельная программа со своим окном без рамки
/// (`--border=no`, без значка в Dock — см. [`spawn_args`]). Мы держим его
/// над областью видео:
///
/// - место — свойство mpv `geometry` (с mpv 0.38 его можно менять на ходу)
///   в пикселях экрана, на котором главное окно;
/// - пока приложение активно, окно mpv «поверх» (`ontop`) на уровень выше
///   главного окна: и в обычном режиме, и в мини-окне (оно само поверх
///   всех). Ушли в другую программу — `ontop` снимается, иначе видео висело
///   бы над её окнами. Панель и реакции поверх видео поднимаются ещё выше;
/// - спрятать видео (меню, обзор, трансляция экрана, окно свёрнуто) —
///   выключить видеодорожку (`vid=no`): с `--force-window=no` окно mpv
///   закрывается, а звук продолжает идти. Показать — `vid=auto`.
#[cfg(target_os = "macos")]
pub mod mac {
    use std::sync::{Mutex, OnceLock};

    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use serde_json::{json, Value};
    use tauri::{Manager, WebviewWindow};
    use tokio::sync::mpsc::UnboundedSender;

    use super::Rect;

    /// Окна поверх видео — поднимаются над окном mpv.
    const ABOVE_VIDEO: &[&str] = &["controls", "reactions"];

    /// Настройки mpv, которых нет в старых версиях: файлом через
    /// `--include`, а не в командной строке — незнакомую строку файла mpv
    /// пропускает с предупреждением, а незнакомый ключ в командной строке
    /// не дал бы ему запуститься.
    const EXTRA_CONF: &str = "\
focus-on=never
macos-app-activation-policy=accessory
macos-geometry-calculation=whole
auto-window-resize=no
hidpi-window-scale=no
";

    static MAIN: OnceLock<WebviewWindow> = OnceLock::new();

    /// Что последним отправлено окну mpv: место, видно ли, поверх ли,
    /// уровень главного окна, номер экрана.
    type Shown = (Option<String>, bool, isize, Option<usize>);

    #[derive(Default)]
    struct Slot {
        tx: Option<UnboundedSender<String>>,
        rect: Option<Rect>,
        shown: Option<Shown>,
    }

    /// `[0]` — фильм, `[1]` — ролик сбоку («СДВГ-режим»).
    fn slots() -> &'static Mutex<[Slot; 2]> {
        static SLOTS: OnceLock<Mutex<[Slot; 2]>> = OnceLock::new();
        SLOTS.get_or_init(Default::default)
    }

    pub fn init(window: WebviewWindow) {
        let _ = MAIN.set(window);
    }

    /// Ключи запуска mpv на macOS.
    pub fn spawn_args() -> Vec<String> {
        let mut args: Vec<String> = [
            "--border=no",
            "--window-dragging=no",
            "--keepaspect-window=no",
            "--ontop=no",
            // Окна нет, пока нет картинки; спрятать — выключить видео.
            "--force-window=no",
            // До первого «покажи здесь» от интерфейса видео выключено —
            // иначе окно выскочило бы посреди экрана.
            "--vid=no",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let conf = std::env::temp_dir().join("brotherhub-mpv-macos.conf");
        if std::fs::write(&conf, EXTRA_CONF).is_ok() {
            args.push(format!("--include={}", conf.display()));
        }
        args
    }

    /// Плеер запущен — дальше его окном управляем по этому каналу.
    pub fn attach(side: bool, tx: UnboundedSender<String>) {
        {
            let mut slots = slots().lock().unwrap();
            let slot = &mut slots[side as usize];
            slot.tx = Some(tx);
            slot.shown = None;
        }
        apply();
    }

    /// Плеер закрыли.
    pub fn detach(side: bool) {
        let mut slots = slots().lock().unwrap();
        let slot = &mut slots[side as usize];
        slot.tx = None;
        slot.shown = None;
    }

    pub fn set_rect(side: bool, rect: Option<Rect>) {
        slots().lock().unwrap()[side as usize].rect = rect;
        apply();
    }

    /// Пересчитать место и «поверх» для окон mpv (в главном потоке:
    /// окна AppKit трогать можно только оттуда).
    pub fn apply() {
        let Some(main) = MAIN.get() else {
            return;
        };
        let window = main.clone();
        let _ = main.run_on_main_thread(move || apply_now(&window));
    }

    fn send(tx: &UnboundedSender<String>, command: Value) {
        let mut line = json!({ "command": command }).to_string();
        line.push('\n');
        let _ = tx.send(line);
    }

    fn ns_window(window: &WebviewWindow) -> Option<*mut AnyObject> {
        window
            .ns_window()
            .ok()
            .map(|p| p as *mut AnyObject)
            .filter(|p| !p.is_null())
    }

    fn level(ns: *mut AnyObject) -> isize {
        unsafe { msg_send![ns, level] }
    }

    fn set_level(ns: *mut AnyObject, level: isize) {
        unsafe {
            let _: () = msg_send![ns, setLevel: level];
        }
    }

    /// Номер экрана с главным окном среди `NSScreen.screens` — так их
    /// нумерует mpv (`--screen`). `None` — экран один или не нашёлся.
    fn screen_index(ns: *mut AnyObject) -> Option<usize> {
        unsafe {
            let screen: *mut AnyObject = msg_send![ns, screen];
            if screen.is_null() {
                return None;
            }
            let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
            if screens.is_null() {
                return None;
            }
            let count: usize = msg_send![screens, count];
            if count < 2 {
                return None;
            }
            (0..count).find(|&i| {
                let s: *mut AnyObject = msg_send![screens, objectAtIndex: i];
                s == screen
            })
        }
    }

    fn apply_now(main: &WebviewWindow) {
        let Some(ns) = ns_window(main) else {
            return;
        };
        let main_level = level(ns);
        let focused = main.is_focused().unwrap_or(false);
        let shown_main =
            main.is_visible().unwrap_or(true) && !main.is_minimized().unwrap_or(false);
        // Окно mpv поверх, пока мы активны или главное окно само поверх
        // всех (мини-окно).
        let front = shown_main && (focused || main_level > 0);
        let origin = main.inner_position().ok();
        let monitor = main.current_monitor().ok().flatten();
        let screen = screen_index(ns);

        let mut hidden_now = false;
        {
            let mut slots = slots().lock().unwrap();
            for slot in slots.iter_mut() {
                let Some(tx) = slot.tx.clone() else {
                    continue;
                };
                // Место относительно левого верхнего угла экрана, в пикселях.
                let geometry = match (slot.rect, origin, &monitor) {
                    (Some(r), Some(o), Some(m)) if shown_main && r.width > 0 && r.height > 0 => {
                        let at = m.position();
                        Some(format!(
                            "{}x{}+{}+{}",
                            r.width,
                            r.height,
                            o.x + r.x - at.x,
                            o.y + r.y - at.y
                        ))
                    }
                    _ => None,
                };
                let visible = geometry.is_some();
                let shown: Shown = (geometry.clone(), visible && front, main_level, screen);
                if slot.shown.as_ref() == Some(&shown) {
                    continue;
                }
                let was_visible = slot.shown.as_ref().is_some_and(|s| s.0.is_some());
                if let Some(g) = &geometry {
                    if let Some(i) = screen {
                        send(&tx, json!(["set_property", "screen", i]));
                    }
                    send(&tx, json!(["set_property", "geometry", g]));
                    if !was_visible {
                        send(&tx, json!(["set_property", "vid", "auto"]));
                    }
                } else if was_visible || slot.shown.is_none() {
                    send(&tx, json!(["set_property", "vid", "no"]));
                    hidden_now = true;
                }
                send(&tx, json!(["set_property", "ontop-level", main_level + 1]));
                send(&tx, json!(["set_property", "ontop", visible && front]));
                slot.shown = Some(shown);
            }
        }

        // Спрятали видео, пока мы активны, — вернуть главное окно наверх
        // (на случай, если окно mpv успело его перекрыть).
        if hidden_now && focused {
            unsafe {
                let _: () = msg_send![ns, orderFront: std::ptr::null_mut::<AnyObject>()];
            }
        }

        // Панель и реакции — над видео; когда мы не активны — на обычном
        // уровне, вместе с главным окном.
        let above = if front { main_level + 2 } else { main_level };
        for label in ABOVE_VIDEO {
            if let Some(w) = main.app_handle().get_webview_window(label) {
                if let Some(p) = ns_window(&w) {
                    if level(p) != above {
                        set_level(p, above);
                    }
                }
            }
        }
    }
}
