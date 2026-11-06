//! Встроенный браузер для выбора видео («Обзор»).
//!
//! Сайт (YouTube, VK Видео, Rutube, «Ю») открывается в отдельном окне без
//! рамки, которое лежит ровно над областью видео главного окна и ездит
//! вместе с ним — так же устроена панель плеера в полном экране
//! (overlay.rs). Интерфейс рисует над ним свою панель и по кнопке
//! «Смотреть в зале» забирает адрес текущей страницы.
//!
//! Страницы сайтов — чужой код, поэтому команды приложения им недоступны:
//! права (capabilities) выданы только окнам `main` и `controls`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::logs;
use crate::overlay::MainWindow;

const LABEL: &str = "browser";

/// Площадки, которые можно открыть кнопками выбора.
const SITES: &[&str] = &[
    "youtube.com",
    "vkvideo.ru",
    "vk.com",
    "rutube.ru",
    "twitch.tv",
    "soundcloud.com",
    "smotrim.ru",
    "dzen.ru",
    "ok.ru",
    "yandex.ru",
    "u-tv.ru",
];

/// Простой «блокировщик рекламы»: прячет рекламные блоки и пропускает
/// рекламу в плеере YouTube. Сеть не трогаем — только страницу.
const ADBLOCK: &str = include_str!("adblock.js");

/// Где показать браузер — в физических пикселях относительно главного окна.
/// `zoom` — масштаб страниц: в узкой области сайты уменьшаем, чтобы они
/// помещались по ширине без прокрутки вбок.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Area {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    zoom: Option<f64>,
}

/// Последнее место — чтобы ехать вслед за главным окном.
static LAST: Mutex<Option<Area>> = Mutex::new(None);

/// Нужен ли браузер сейчас: если закрыли, пока окно создавалось, —
/// созданное окно сразу убираем.
static WANTED: AtomicBool = AtomicBool::new(false);

fn allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|h| {
            let h = h.to_ascii_lowercase();
            SITES.iter().any(|s| h == *s || h.ends_with(&format!(".{s}")))
        })
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.try_state::<MainWindow>()
        .map(|m| m.0.clone())
        .ok_or_else(|| "Главное окно не найдено".to_string())
}

fn place(app: &AppHandle, view: &WebviewWindow, rect: Area) -> Result<(), String> {
    *LAST.lock().unwrap() = Some(rect);
    let origin = main_window(app)?.inner_position().map_err(|e| e.to_string())?;
    if let Some(zoom) = rect.zoom {
        let _ = view.set_zoom(zoom);
    }
    view.set_size(PhysicalSize::new(rect.width.max(1), rect.height.max(1)))
        .map_err(|e| e.to_string())?;
    view.set_position(PhysicalPosition::new(origin.x + rect.x, origin.y + rect.y))
        .map_err(|e| e.to_string())
}

/// Открыть площадку (или перейти на неё, если браузер уже открыт).
/// Окна создаём в async-команде: в синхронной Windows может зависнуть.
#[tauri::command]
pub async fn browser_open(app: AppHandle, url: String, rect: Area) -> Result<(), String> {
    let url: Url = url.parse().map_err(|_| "Не получилось разобрать адрес".to_string())?;
    if !allowed(&url) {
        return Err("Эту площадку здесь не открыть".into());
    }
    WANTED.store(true, Ordering::SeqCst);
    if let Some(view) = app.get_webview_window(LABEL) {
        view.navigate(url).map_err(|e| e.to_string())?;
        place(&app, &view, rect)?;
        view.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let main = main_window(&app)?;
    let handle = app.clone();
    // Своя папка данных: у сайтов отдельные входы и куки, и им не достаётся
    // автоматический доступ к микрофону, который есть у окон приложения.
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser");
    let view = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("BrotherHub — обзор")
        .data_directory(data)
        .initialization_script(ADBLOCK)
        .on_new_window(move |url, _features| {
            // Ссылки «в новом окне» открываем здесь же.
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(view) = handle.get_webview_window(LABEL) {
                    let _ = view.navigate(url);
                }
            });
            NewWindowResponse::Deny
        })
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .parent(&main)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| {
            logs::warn(format!("браузер не открылся: {e}"));
            format!("Не получилось открыть сайт: {e}")
        })?;
    if !WANTED.load(Ordering::SeqCst) {
        let _ = view.destroy();
        return Ok(());
    }
    place(&app, &view, rect)?;
    view.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Передвинуть браузер вслед за областью видео (`None` — спрятать).
#[tauri::command]
pub async fn browser_place(app: AppHandle, rect: Option<Area>) -> Result<(), String> {
    let Some(view) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    match rect {
        Some(rect) => {
            place(&app, &view, rect)?;
            view.show().map_err(|e| e.to_string())
        }
        None => view.hide().map_err(|e| e.to_string()),
    }
}

/// Главное окно сдвинули — браузер едет следом.
pub fn follow(app: &AppHandle) {
    let Some(rect) = *LAST.lock().unwrap() else {
        return;
    };
    let (Some(view), Ok(main)) = (app.get_webview_window(LABEL), main_window(app)) else {
        return;
    };
    if let Ok(origin) = main.inner_position() {
        let _ = view.set_position(PhysicalPosition::new(origin.x + rect.x, origin.y + rect.y));
    }
}

/// Адрес открытой страницы (`None` — браузер закрыт).
#[tauri::command]
pub async fn browser_url(app: AppHandle) -> Option<String> {
    let view = app.get_webview_window(LABEL)?;
    view.url().ok().map(|u| u.to_string())
}

/// Назад по истории страницы.
#[tauri::command]
pub async fn browser_back(app: AppHandle) -> Result<(), String> {
    if let Some(view) = app.get_webview_window(LABEL) {
        view.eval("history.back()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Закрыть браузер: окно вместе со страницей (и её звуком) уничтожаем.
#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    WANTED.store(false, Ordering::SeqCst);
    *LAST.lock().unwrap() = None;
    if let Some(view) = app.get_webview_window(LABEL) {
        view.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}
