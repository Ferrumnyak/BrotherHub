//! Панель плеера поверх видео в полном экране.
//!
//! Видео рисует mpv в своём окне, и интерфейс приложения поверх него не
//! виден. Поэтому в полном экране панель управления живёт в отдельном
//! прозрачном окне без рамки, которое лежит над нижней частью видео и
//! привязано к главному окну. Окно открывается тем же интерфейсом, но с
//! пометкой `window.__BW_VIEW = "controls"` — тогда показывается только панель.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "controls";

/// Нужна ли панель сейчас. Окно создаётся не мгновенно: если за это время
/// пришла команда закрыть (вышли из полного экрана), созданное окно сразу
/// убираем — иначе оно оставалось бы висеть поверх главного.
static WANTED: AtomicBool = AtomicBool::new(false);

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
pub async fn overlay_place(app: AppHandle, rect: Rect) -> Result<(), String> {
    WANTED.store(true, Ordering::SeqCst);
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
        None => WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
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
            .map_err(|e| e.to_string())?,
    };
    if !WANTED.load(Ordering::SeqCst) {
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
pub fn overlay_close(app: AppHandle) {
    WANTED.store(false, Ordering::SeqCst);
    *LAST.lock().unwrap() = None;
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}
