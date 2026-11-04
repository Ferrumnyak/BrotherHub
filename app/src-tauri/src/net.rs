//! Связь с сервером BrotherWatch по WebSocket.
//!
//! Интерфейс (React) вызывает команды `connect`, `send`, `disconnect`,
//! а сообщения от сервера получает событиями:
//! - `server-message` — любое [`ServerMsg`];
//! - `disconnected` — соединение оборвалось.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use brotherwatch_shared::{ClientMsg, ServerMsg};
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Default)]
pub struct Connection {
    tx: Mutex<Option<mpsc::UnboundedSender<ClientMsg>>>,
    /// Номер текущего подключения. Нужен, чтобы старое соединение,
    /// закрываясь, не сообщило интерфейсу об обрыве нового.
    generation: Arc<AtomicU64>,
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    conn: State<'_, Connection>,
    server: String,
    room: String,
    name: String,
) -> Result<(), String> {
    let url = format!("{}/ws", server.trim().trim_end_matches('/'));
    let (ws, _) = connect_async(url.as_str())
        .await
        .map_err(|e| format!("не удалось подключиться к {url}: {e}"))?;
    let (mut sink, mut stream) = ws.split();

    let my_generation = conn.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let generation = conn.generation.clone();

    let (tx, mut rx) = mpsc::unbounded_channel::<ClientMsg>();
    tx.send(ClientMsg::Join { room, name })
        .map_err(|e| e.to_string())?;

    // Отправка: всё из канала уходит на сервер.
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&msg) else {
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        // Канал закрыт — значит, нас отключили. Закрываем соединение.
        let _ = sink.close().await;
    });

    // Приём: всё от сервера пересылаем в интерфейс.
    tauri::async_runtime::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else {
                continue;
            };
            match serde_json::from_str::<ServerMsg>(text.as_str()) {
                Ok(msg) => {
                    let _ = app.emit("server-message", msg);
                }
                Err(e) => eprintln!("непонятное сообщение от сервера: {e}"),
            }
        }
        if generation.load(Ordering::SeqCst) == my_generation {
            let _ = app.emit("disconnected", ());
        }
    });

    // Если было старое подключение — его отправитель удалится и оно закроется.
    *conn.tx.lock().await = Some(tx);
    Ok(())
}

#[tauri::command]
pub async fn disconnect(conn: State<'_, Connection>) -> Result<(), String> {
    conn.generation.fetch_add(1, Ordering::SeqCst);
    conn.tx.lock().await.take();
    Ok(())
}

#[tauri::command]
pub async fn send(conn: State<'_, Connection>, msg: ClientMsg) -> Result<(), String> {
    let guard = conn.tx.lock().await;
    let tx = guard.as_ref().ok_or("нет подключения к серверу")?;
    tx.send(msg).map_err(|_| "соединение закрыто".to_string())
}
