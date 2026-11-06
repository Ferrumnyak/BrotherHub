//! Панель плеера поверх видео в полном экране.
//!
//! Видео рисует mpv в своём окне, и интерфейс приложения поверх него не
//! виден. Поэтому в полном экране панель управления живёт в отдельном
//! прозрачном окне без рамки, которое лежит над нижней частью видео и
//! привязано к главному окну. Окно открывается тем же интерфейсом, но с
//! пометкой `window.__BW_VIEW = "controls"` — тогда показывается только панель.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "controls";

/// Каждый вход в полный экран или мини-окно — новый «сеанс» панели с
/// номером. Команды приходят не по порядку: «поставить панель» от сеанса,
/// который уже закрыли (окно меняло размер при выходе из полного экрана),
/// могла прийти после «закрыть» и заново открыть панель поверх кнопок
/// главного окна — тогда ничего не нажималось. Такие команды отбрасываем.
static CLOSED: AtomicU64 = AtomicU64::new(0);

fn stale(session: u64) -> bool {
    session <= CLOSED.load(Ordering::SeqCst)
}

/// Где панель относительно главного окна — чтобы ехать вслед за ним.
static LAST: Mutex<Option<Rect>> = Mutex::new(None);

/// Главное окно приложения (сохраняется в `main.rs` при запуске).
pub struct MainWindow(pub WebviewWindow);

/// Прямоугольник в физических пикселях относительно окна приложения.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Открыть (если ещё нет) и поставить окно панели поверх видео.
/// Окна создаём в async-команде: в синхронной Windows может зависнуть.
#[tauri::command]
pub async fn overlay_place(app: AppHandle, rect: Rect, session: u64) -> Result<(), String> {
    if stale(session) {
        return Ok(());
    }
    *LAST.lock().unwrap() = Some(rect);
    // Главное окно берём из сохранённого при запуске: когда в нём открыт
    // встроенный браузер (второй webview), get_webview_window("main") его не находит.
    let main = app
        .try_state::<MainWindow>()
        .ok_or("нет главного окна")?
        .0
        .clone();
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    let position = PhysicalPosition::new(origin.x + rect.x, origin.y + rect.y);
    let size = PhysicalSize::new(rect.width.max(1), rect.height.max(1));

    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            crate::logs::info(format!("панель поверх видео: открываю (сеанс {session})"));
            WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("BrotherHub")
            .initialization_script("window.__BW_VIEW = 'controls';")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .parent(&main)
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?
        }
    };
    if stale(session) {
        crate::logs::info(format!("панель поверх видео: сеанс {session} уже закрыт — убираю"));
        let _ = window.destroy();
        return Ok(());
    }
    window.set_size(size).map_err(|e| e.to_string())?;
    window.set_position(position).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Скрытая панель пропускает клики насквозь, к видео.
#[tauri::command]
pub fn overlay_interactive(app: AppHandle, interactive: bool) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_ignore_cursor_events(!interactive);
    }
}

/// Главное окно сдвинули или поменяли размер — панель едет следом
/// (например, мини-окно уезжает в угол экрана уже после того, как панель создана).
pub fn follow(app: &AppHandle) {
    let Some(rect) = *LAST.lock().unwrap() else {
        return;
    };
    let (Some(main), Some(window)) = (app.try_state::<MainWindow>(), app.get_webview_window(LABEL))
    else {
        return;
    };
    if let Ok(origin) = main.0.inner_position() {
        let _ = window.set_position(PhysicalPosition::new(origin.x + rect.x, origin.y + rect.y));
    }
}

#[tauri::command]
pub fn overlay_close(app: AppHandle, session: u64) {
    CLOSED.fetch_max(session, Ordering::SeqCst);
    *LAST.lock().unwrap() = None;
    if let Some(window) = app.get_webview_window(LABEL) {
        crate::logs::info(format!("панель поверх видео: закрываю (сеанс {session})"));
        let _ = window.destroy();
    }
}
