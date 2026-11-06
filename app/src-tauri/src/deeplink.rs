//! Ссылки-приглашения `brotherhub://join?room=…&server=…`.
//!
//! Схему `brotherhub` регистрирует установщик, а portable-версия — сама при
//! запуске. Если приложение уже открыто, повторный запуск по ссылке не
//! открывает второе окно: плагин single-instance передаёт ссылку в уже
//! работающее приложение. Интерфейс забирает ссылку командой
//! [`deep_link_take`] — при запуске и по событию `deep-link`.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::logs;

/// Ссылка, которую интерфейс ещё не забрал.
#[derive(Default)]
pub struct Pending(Mutex<Option<String>>);

fn keep(app: &AppHandle, url: String) {
    logs::info("открыли ссылку-приглашение");
    *app.state::<Pending>().0.lock().unwrap() = Some(url);
}

pub fn setup(app: &tauri::App) {
    #[cfg(windows)]
    if let Err(e) = app.deep_link().register_all() {
        logs::warn(format!("ссылки brotherhub:// не зарегистрировались: {e}"));
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(url) = urls.first() {
            keep(app.handle(), url.to_string());
        }
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        let Some(url) = event.urls().first().map(|u| u.to_string()) else {
            return;
        };
        keep(&handle, url);
        let _ = handle.emit("deep-link", ());
        crate::tray::show_app(&handle);
    });
}

/// Вытащить главное окно вперёд (его могли свернуть).
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Забрать ссылку-приглашение, если она есть.
#[tauri::command]
pub fn deep_link_take(pending: State<'_, Pending>) -> Option<String> {
    pending.0.lock().unwrap().take()
}
