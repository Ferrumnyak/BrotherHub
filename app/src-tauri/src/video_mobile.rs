//! Где показывать видео на телефоне.
//!
//! Картинка ExoPlayer лежит под прозрачным интерфейсом (PlayerPlugin.kt).
//! Интерфейс, как и на компьютере, сообщает прямоугольник области видео —
//! плеер встаёт ровно под неё.

use serde::{Deserialize, Serialize};

/// На телефоне отдельного окна для видео нет — оставлено для общего кода.
#[derive(Default)]
pub struct VideoHost;

impl VideoHost {
    pub fn wid(&self) -> Option<isize> {
        None
    }
}

/// Прямоугольник в физических пикселях относительно интерфейса.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

/// Интерфейс сообщает, где показать видео (`None` — спрятать).
#[tauri::command]
pub async fn set_video_rect(rect: Option<Rect>, radius: Option<u32>) -> Result<(), String> {
    let _ = radius;
    let payload = match rect {
        Some(r) if r.width > 0 && r.height > 0 => serde_json::json!({
            "visible": true, "x": r.x, "y": r.y, "width": r.width, "height": r.height
        }),
        _ => serde_json::json!({ "visible": false }),
    };
    crate::player::call("rect", payload).await.map(|_| ())
}

/// Ролика сбоку («СДВГ-режим») на телефоне нет.
#[tauri::command]
pub async fn set_side_rect() {}

/// Курсора на телефоне нет.
#[tauri::command]
pub fn watch_cursor() {}
