//! Значок в трее (у часов): BrotherHub можно свернуть туда, а не держать
//! окно открытым. По желанию крестик тоже прячет окно в трей.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager};

/// Крестик прячет окно в трей, а не закрывает приложение.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

/// Окна поверх главного — прячутся и показываются вместе с ним.
const AUX_WINDOWS: &[&str] = &["controls", "reactions", "browser"];

pub fn setup(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Открыть BrotherHub", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("BrotherHub")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_app(app),
            "quit" => crate::net::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_app(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::SeqCst)
}

/// Спрятать приложение в трей.
pub fn hide_app(app: &AppHandle) {
    for label in AUX_WINDOWS {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    // macOS: окно mpv — отдельная программа, его прячем отдельно.
    crate::video::follow();
}

/// Вернуть окно из трея. Интерфейс по событию `app-shown` заново ставит
/// окна поверх видео (реакции, панель) на свои места.
pub fn show_app(app: &AppHandle) {
    crate::deeplink::show_main(app);
    crate::video::follow();
    let _ = app.emit("app-shown", ());
}

#[tauri::command]
pub fn tray_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
}

/// Кнопка «Свернуть в трей» из интерфейса.
#[tauri::command]
pub fn tray_hide(app: AppHandle) {
    hide_app(&app);
}
