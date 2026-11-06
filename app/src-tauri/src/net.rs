//! Связь с сервером BrotherHub по WebSocket.
//!
//! Интерфейс (React) вызывает команды `connect`, `send`, `disconnect`,
//! а сообщения от сервера получает событиями:
//! - `server-message` — любое [`ServerMsg`];
//! - `reconnecting` — связь пропала, приложение пытается вернуться;
//! - `disconnected` — вернуться не получилось.
//!
//! Если связь пропала, приложение само переподключается и возвращается на
//! своё место с пропуском из `Welcome` (сервер держит место 30 секунд).
//! Плеер при этом не останавливается.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use brotherwatch_shared::{ClientMsg, ServerMsg};
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, State};
use tokio::{net::TcpStream, sync::mpsc, sync::Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

use crate::session::SharedSession;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Как часто проверять, что соединение живо.
const PING_EVERY: Duration = Duration::from_secs(10);
/// Если от сервера столько времени ничего нет — связь считается потерянной
/// (бывает, что соединение «висит», хотя интернета уже нет).
const SILENCE_LIMIT: Duration = Duration::from_secs(30);
/// Сколько пытаться переподключиться, прежде чем сдаться.
const GIVE_UP_AFTER: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct Connection {
    tx: Mutex<Option<mpsc::UnboundedSender<ClientMsg>>>,
    /// Номер текущего подключения. Нужен, чтобы старое подключение,
    /// закрываясь, не вмешивалось в новое.
    generation: Arc<AtomicU64>,
    /// Пропуск из последнего `Welcome` — чтобы после обновления приложения
    /// вернуться на своё место (тот же участник, тот же пульт).
    token: Arc<std::sync::Mutex<Option<String>>>,
}

/// Пропуск текущего подключения (перед обновлением приложения).
#[tauri::command]
pub fn connection_token(conn: State<'_, Connection>) -> Option<String> {
    conn.token.lock().unwrap().clone()
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    conn: State<'_, Connection>,
    session: State<'_, SharedSession>,
    server: String,
    room: String,
    name: String,
    password: Option<String>,
    avatar: Option<String>,
    resume: Option<String>,
) -> Result<(), String> {
    let my_generation = conn.generation.fetch_add(1, Ordering::SeqCst) + 1;
    // Было старое подключение — выходим из той комнаты по-честному.
    if let Some(old) = conn.tx.lock().await.take() {
        let _ = old.send(ClientMsg::Leave);
    }

    let url = format!("{}/ws", server.trim().trim_end_matches('/'));
    crate::logs::info(format!("подключаюсь к {url}, комната «{room}», имя «{name}»"));
    let (ws, _) = connect_async(url.as_str()).await.map_err(|e| {
        let msg = format!("не удалось подключиться к {url}: {e}");
        crate::logs::error(&msg);
        msg
    })?;

    let (tx, rx) = mpsc::unbounded_channel::<ClientMsg>();
    session.lock().await.connected(tx.clone());

    let join = ClientMsg::Join {
        room,
        name,
        password: password.filter(|p| !p.is_empty()),
        resume: resume.filter(|t| !t.is_empty()),
        avatar,
    };
    *conn.token.lock().unwrap() = None;
    tauri::async_runtime::spawn(supervise(Supervisor {
        app,
        session: session.inner().clone(),
        generation: conn.generation.clone(),
        my_generation,
        url,
        join,
        rx,
        first: Some(ws),
        shared_token: conn.token.clone(),
    }));

    *conn.tx.lock().await = Some(tx);
    Ok(())
}

#[tauri::command]
pub async fn disconnect(
    conn: State<'_, Connection>,
    session: State<'_, SharedSession>,
) -> Result<(), String> {
    conn.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(tx) = conn.tx.lock().await.take() {
        // Сначала «выхожу», потом закрываем: сервер сразу освободит место.
        let _ = tx.send(ClientMsg::Leave);
    }
    session.lock().await.disconnected();
    Ok(())
}

#[tauri::command]
pub async fn send(conn: State<'_, Connection>, msg: ClientMsg) -> Result<(), String> {
    let guard = conn.tx.lock().await;
    let tx = guard.as_ref().ok_or("нет подключения к серверу")?;
    tx.send(msg).map_err(|_| "соединение закрыто".to_string())
}

// ---------- Поддержание связи ----------

struct Supervisor {
    app: AppHandle,
    session: SharedSession,
    generation: Arc<AtomicU64>,
    my_generation: u64,
    url: String,
    join: ClientMsg,
    rx: mpsc::UnboundedReceiver<ClientMsg>,
    first: Option<Ws>,
    shared_token: Arc<std::sync::Mutex<Option<String>>>,
}

impl Supervisor {
    fn current(&self) -> bool {
        self.generation.load(Ordering::SeqCst) == self.my_generation
    }
}

/// Чем закончилось одно подключение.
enum Ended {
    /// Мы сами вышли (или нас отключили из интерфейса).
    ByUs,
    /// Связь пропала.
    Lost,
}

async fn supervise(mut s: Supervisor) {
    // Первый вход — с пропуском, если его дали (возвращение после обновления).
    let mut token: Option<String> = match &s.join {
        ClientMsg::Join { resume, .. } => resume.clone(),
        _ => None,
    };
    let mut ws = s.first.take();

    loop {
        let Some(stream) = ws.take() else {
            return;
        };
        if let ClientMsg::Join { resume, .. } = &mut s.join {
            *resume = token.clone();
        }
        if let Ended::ByUs = run_connection(&mut s, stream, &mut token).await {
            return;
        }
        if !s.current() {
            return;
        }

        // Связь пропала — плеер не трогаем, пробуем вернуться.
        crate::logs::warn("связь с сервером пропала, переподключаюсь");
        let _ = s.app.emit("reconnecting", ());
        let lost_at = Instant::now();
        let mut attempt = 0u32;
        loop {
            // 0.5, 1, 2, 4, 5, 5… секунд между попытками.
            let delay = Duration::from_millis((500u64 << attempt.min(4)).min(5000));
            tokio::time::sleep(delay).await;
            if !s.current() {
                return;
            }
            match connect_async(s.url.as_str()).await {
                Ok((stream, _)) => {
                    crate::logs::info("связь с сервером восстановлена");
                    ws = Some(stream);
                    break;
                }
                Err(e) if lost_at.elapsed() > GIVE_UP_AFTER => {
                    crate::logs::error(format!("не удалось вернуться на сервер: {e}"));
                    s.session.lock().await.disconnected();
                    let _ = s.app.emit("disconnected", ());
                    return;
                }
                Err(_) => attempt += 1,
            }
        }
        // Команды, набранные, пока связи не было, уже неактуальны.
        while s.rx.try_recv().is_ok() {}
    }
}

async fn run_connection(s: &mut Supervisor, ws: Ws, token: &mut Option<String>) -> Ended {
    let (mut sink, mut stream) = ws.split();

    let Ok(join) = serde_json::to_string(&s.join) else {
        return Ended::ByUs;
    };
    if sink.send(Message::Text(join.into())).await.is_err() {
        return Ended::Lost;
    }

    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // первый тик срабатывает сразу
    let mut last_heard = Instant::now();

    loop {
        tokio::select! {
            outgoing = s.rx.recv() => match outgoing {
                Some(msg) => {
                    let leaving = matches!(msg, ClientMsg::Leave);
                    let Ok(text) = serde_json::to_string(&msg) else { continue };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        return if leaving { Ended::ByUs } else { Ended::Lost };
                    }
                    if leaving {
                        let _ = sink.close().await;
                        return Ended::ByUs;
                    }
                }
                // Отправитель удалён — нас отключили из интерфейса.
                None => {
                    let _ = sink.close().await;
                    return Ended::ByUs;
                }
            },
            incoming = stream.next() => {
                last_heard = Instant::now();
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !s.current() {
                            continue; // старое подключение доживает
                        }
                        match serde_json::from_str::<ServerMsg>(text.as_str()) {
                            Ok(msg) => {
                                if let ServerMsg::Welcome { token: t, .. } = &msg {
                                    *token = Some(t.clone());
                                    *s.shared_token.lock().unwrap() = Some(t.clone());
                                }
                                s.session.lock().await.on_server_msg(&msg).await;
                                let _ = s.app.emit("server-message", msg);
                            }
                            Err(e) => crate::logs::warn(format!("непонятное сообщение от сервера: {e}")),
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Ended::Lost,
                    Some(Ok(_)) => {} // ping/pong
                }
            },
            _ = ping.tick() => {
                if last_heard.elapsed() > SILENCE_LIMIT {
                    return Ended::Lost;
                }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return Ended::Lost;
                }
            },
        }
    }
}
