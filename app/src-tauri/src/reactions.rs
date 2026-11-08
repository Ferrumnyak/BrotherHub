//! Реакции поверх видео: летящие эмодзи.
//!
//! Видео рисует mpv в своём окне, и интерфейс поверх него не виден, поэтому
//! реакции живут в отдельном прозрачном окне над областью видео (как панель
//! плеера в полном экране, overlay.rs). Окно пропускает мышь насквозь, а
//! само слушает сообщения сервера и запускает анимацию.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::overlay::{MainWindow, BROWSER_ARGS};

const LABEL: &str = "reactions";

/// Область видео в физических пикселях относительно главного окна.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Area {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

static LAST: Mutex<Option<Area>> = Mutex::new(None);

/// По одной: иначе второй вызов, пока окно создаётся, создавал бы ещё одно.
fn place_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Поставить окно реакций над областью видео (`None` — спрятать).
/// Окна создаём в async-команде: в синхронной Windows может зависнуть.
#[tauri::command]
pub async fn reactions_place(app: AppHandle, rect: Option<Area>) -> Result<(), String> {
    *LAST.lock().unwrap() = rect;
    let _turn = place_lock().lock().await;
    // Самое свежее место — пока ждали, оно могло поменяться.
    let rect = *LAST.lock().unwrap();
    let Some(rect) = rect else {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
        return Ok(());
    };
    let main = app
        .try_state::<MainWindow>()
        .ok_or("нет главного окна")?
        .0
        .clone();
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
                .title("BrotherHub")
                .initialization_script("window.__BW_VIEW = 'reactions';")
                .additional_browser_args(BROWSER_ARGS)
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
                .map_err(|e| e.to_string())?;
            // Мышь — насквозь, к видео и кнопкам под окном.
            let _ = window.set_ignore_cursor_events(true);
            window
        }
    };
    // Пока создавали окно, область могли уже спрятать.
    if LAST.lock().unwrap().is_none() {
        let _ = window.hide();
        return Ok(());
    }
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(rect.width.max(1), rect.height.max(1)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(origin.x + rect.x, origin.y + rect.y))
        .map_err(|e| e.to_string())?;
    if !window.is_visible().unwrap_or(false) {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_ignore_cursor_events(true);
    }
    Ok(())
}

/// Главное окно сдвинули — окно реакций едет следом.
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
