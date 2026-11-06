//! Встроенный браузер для выбора видео.
//!
//! Сайт (YouTube, VK Видео, Rutube, «Ю») открывается дочерним webview
//! прямо в области видео главного окна. Интерфейс рисует над ним свою
//! панель и по кнопке «Смотреть в зале» забирает адрес текущей страницы.
//!
//! Страницы сайтов — чужой код, поэтому команды приложения им недоступны:
//! права (capabilities) действуют только для страниц самого приложения.

use serde::Deserialize;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl};

use crate::logs;

const LABEL: &str = "browser";

/// Площадки, которые можно открыть кнопками выбора.
const SITES: &[&str] = &["youtube.com", "vkvideo.ru", "vk.com", "rutube.ru", "u-tv.ru"];

/// Где показать браузер — в физических пикселях окна.
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

/// Простой «блокировщик рекламы»: прячет рекламные блоки и пропускает
/// рекламу в плеере YouTube. Сеть не трогаем — только страницу.
const ADBLOCK: &str = include_str!("adblock.js");

fn allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|h| {
            let h = h.to_ascii_lowercase();
            SITES.iter().any(|s| h == *s || h.ends_with(&format!(".{s}")))
        })
}

/// Открыть площадку (или перейти на неё, если браузер уже открыт).
#[tauri::command]
pub async fn browser_open(app: AppHandle, url: String, rect: Area) -> Result<(), String> {
    let url: Url = url.parse().map_err(|_| "Не получилось разобрать адрес".to_string())?;
    if !allowed(&url) {
        return Err("Эту площадку здесь не открыть".into());
    }
    if let Some(view) = app.get_webview(LABEL) {
        view.navigate(url).map_err(|e| e.to_string())?;
        place(&view, rect)?;
        view.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("Главное окно не найдено")?;
    let handle = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script(ADBLOCK)
        .on_new_window(
        move |url, _features| {
            // Ссылки «в новом окне» открываем здесь же.
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(view) = handle.get_webview(LABEL) {
                    let _ = view.navigate(url);
                }
            });
            NewWindowResponse::Deny
        },
    );
    let view = window
        .add_child(
            builder,
            PhysicalPosition::new(rect.x, rect.y),
            PhysicalSize::new(rect.width, rect.height),
        )
        .map_err(|e| {
            logs::warn(format!("браузер не открылся: {e}"));
            format!("Не получилось открыть сайт: {e}")
        })?;
    if let Some(zoom) = rect.zoom {
        let _ = view.set_zoom(zoom);
    }
    Ok(())
}

fn place(view: &tauri::Webview, rect: Area) -> Result<(), String> {
    if let Some(zoom) = rect.zoom {
        let _ = view.set_zoom(zoom);
    }
    view.set_position(PhysicalPosition::new(rect.x, rect.y))
        .map_err(|e| e.to_string())?;
    view.set_size(PhysicalSize::new(rect.width.max(1), rect.height.max(1)))
        .map_err(|e| e.to_string())
}

/// Передвинуть браузер вслед за областью видео (`None` — спрятать).
#[tauri::command]
pub async fn browser_place(app: AppHandle, rect: Option<Area>) -> Result<(), String> {
    let Some(view) = app.get_webview(LABEL) else {
        return Ok(());
    };
    match rect {
        Some(rect) => {
            place(&view, rect)?;
            view.show().map_err(|e| e.to_string())
        }
        None => view.hide().map_err(|e| e.to_string()),
    }
}

/// Адрес открытой страницы (`None` — браузер закрыт).
#[tauri::command]
pub async fn browser_url(app: AppHandle) -> Option<String> {
    let view = app.get_webview(LABEL)?;
    view.url().ok().map(|u| u.to_string())
}

/// Назад по истории страницы.
#[tauri::command]
pub async fn browser_back(app: AppHandle) -> Result<(), String> {
    if let Some(view) = app.get_webview(LABEL) {
        view.eval("history.back()").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Закрыть браузер: страницу выгружаем (пропадает и её звук) и прячем.
/// Сам webview не уничтожаем — закрытие дочернего webview на Windows
/// может сбить ввод главному окну; при следующем «Обзоре» он пригодится.
#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    if let Some(view) = app.get_webview(LABEL) {
        view.hide().map_err(|e| e.to_string())?;
        if let Ok(blank) = "about:blank".parse::<Url>() {
            let _ = view.navigate(blank);
        }
    }
    Ok(())
}
