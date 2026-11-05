//! Панель плеера поверх видео в полном экране.
//!
//! Видео рисует mpv в своём окне, и интерфейс приложения поверх него не
//! виден. Поэтому в полном экране панель управления живёт в отдельном
//! прозрачном окне без рамки, которое лежит над нижней частью видео и
//! привязано к главному окну. Окно открывается тем же интерфейсом, но с
//! пометкой `window.__BW_VIEW = "controls"` — тогда показывается только панель.

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "controls";

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
    let main = app.get_webview_window("main").ok_or("нет главного окна")?;
    let origin = main.inner_position().map_err(|e| e.to_string())?;
    let position = PhysicalPosition::new(origin.x + rect.x, origin.y + rect.y);
    let size = PhysicalSize::new(rect.width.max(1), rect.height.max(1));

    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("BrotherWatch")
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

#[tauri::command]
pub fn overlay_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}
