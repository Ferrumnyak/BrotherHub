//! Сервер BrotherWatch.
//!
//! Держит комнаты в памяти, пересылает сообщения чата и хранит общее
//! состояние воспроизведения каждой комнаты. Клиенты подключаются по
//! WebSocket на `/ws`.
//!
//! Адрес задаётся переменной окружения `BROTHERWATCH_ADDR`
//! (по умолчанию `0.0.0.0:8080`).

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use brotherwatch_shared::{ClientMsg, Member, MemberId, PlaybackState, ServerMsg};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};

const MAX_NAME_LEN: usize = 32;
const MAX_CHAT_LEN: usize = 2000;
const MAX_MEDIA_LEN: usize = 2000;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

type Tx = mpsc::UnboundedSender<ServerMsg>;

struct Peer {
    name: String,
    tx: Tx,
}

struct Room {
    peers: HashMap<MemberId, Peer>,
    media: Option<String>,
    paused: bool,
    /// Позиция на момент `updated_at`.
    position: f64,
    updated_at: Instant,
}

impl Room {
    fn new() -> Self {
        Self {
            peers: HashMap::new(),
            media: None,
            paused: true,
            position: 0.0,
            updated_at: Instant::now(),
        }
    }

    /// Текущее состояние: если видео играет, позиция «уехала» вперёд
    /// на время, прошедшее с последнего изменения.
    fn playback(&self) -> PlaybackState {
        let position = if self.paused {
            self.position
        } else {
            self.position + self.updated_at.elapsed().as_secs_f64()
        };
        PlaybackState {
            media: self.media.clone(),
            paused: self.paused,
            position,
        }
    }

    fn set_position(&mut self, position: f64) {
        self.position = position.max(0.0);
        self.updated_at = Instant::now();
    }

    fn broadcast(&self, msg: &ServerMsg) {
        for peer in self.peers.values() {
            let _ = peer.tx.send(msg.clone());
        }
    }

    fn members(&self) -> Vec<Member> {
        let mut members: Vec<Member> = self
            .peers
            .iter()
            .map(|(id, p)| Member {
                id: *id,
                name: p.name.clone(),
            })
            .collect();
        members.sort_by_key(|m| m.id);
        members
    }
}

#[derive(Default)]
struct AppState {
    rooms: Mutex<HashMap<String, Room>>,
    next_id: AtomicU64,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let addr = std::env::var("BROTHERWATCH_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let state = Arc::new(AppState::default());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "ok" }))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("не удалось занять адрес {addr}: {e}"));
    tracing::info!("BrotherWatch server слушает {addr}");
    axum::serve(listener, app).await.expect("сервер упал");
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (mut sink, mut stream) = socket.split();

    // Всё, что отправляется этому клиенту, идёт через канал:
    // так в него могут писать другие участники комнаты.
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let Ok(text) = serde_json::to_string(&msg) else {
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    let mut current_room: Option<String> = None;

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        match serde_json::from_str::<ClientMsg>(text.as_str()) {
            Ok(cmd) => handle_command(&state, id, &tx, &mut current_room, cmd).await,
            Err(e) => {
                let _ = tx.send(ServerMsg::Error {
                    message: format!("непонятное сообщение: {e}"),
                });
            }
        }
    }

    if let Some(room_name) = current_room {
        leave_room(&state, id, &room_name).await;
    }
    writer.abort();
}

async fn handle_command(
    state: &AppState,
    id: MemberId,
    tx: &Tx,
    current_room: &mut Option<String>,
    cmd: ClientMsg,
) {
    let error = |message: &str| {
        let _ = tx.send(ServerMsg::Error {
            message: message.to_string(),
        });
    };

    if let ClientMsg::Join { room, name } = cmd {
        if current_room.is_some() {
            return error("ты уже в комнате");
        }
        let room = room.trim().to_string();
        let name = name.trim().to_string();
        if room.is_empty() || name.is_empty() {
            return error("название комнаты и ник не могут быть пустыми");
        }
        if room.chars().count() > MAX_NAME_LEN || name.chars().count() > MAX_NAME_LEN {
            return error("слишком длинное название комнаты или ник");
        }

        let mut rooms = state.rooms.lock().await;
        let r = rooms.entry(room.clone()).or_insert_with(Room::new);
        let member = Member {
            id,
            name: name.clone(),
        };
        r.broadcast(&ServerMsg::MemberJoined {
            member: member.clone(),
        });
        r.peers.insert(id, Peer { name, tx: tx.clone() });
        let _ = tx.send(ServerMsg::Welcome {
            you: id,
            room: room.clone(),
            members: r.members(),
            playback: r.playback(),
        });
        tracing::info!("участник {id} ({}) вошёл в комнату «{room}»", member.name);
        *current_room = Some(room);
        return;
    }

    let Some(room_name) = current_room.as_ref() else {
        return error("сначала нужно войти в комнату");
    };
    let mut rooms = state.rooms.lock().await;
    let Some(room) = rooms.get_mut(room_name) else {
        return;
    };
    let name = room
        .peers
        .get(&id)
        .map(|p| p.name.clone())
        .unwrap_or_default();

    match cmd {
        ClientMsg::Join { .. } => unreachable!("обработано выше"),
        ClientMsg::Chat { text } => {
            let text = text.trim();
            if text.is_empty() {
                return;
            }
            if text.chars().count() > MAX_CHAT_LEN {
                return error("слишком длинное сообщение");
            }
            room.broadcast(&ServerMsg::Chat {
                from: id,
                name,
                text: text.to_string(),
            });
        }
        ClientMsg::SetMedia { media } => {
            let media = media.trim();
            if media.is_empty() || media.chars().count() > MAX_MEDIA_LEN {
                return error("некорректное название или ссылка");
            }
            room.media = Some(media.to_string());
            room.paused = true;
            room.set_position(0.0);
            broadcast_playback(room, name);
        }
        ClientMsg::Play { position } => {
            room.paused = false;
            room.set_position(sanitize(position));
            broadcast_playback(room, name);
        }
        ClientMsg::Pause { position } => {
            room.paused = true;
            room.set_position(sanitize(position));
            broadcast_playback(room, name);
        }
        ClientMsg::Seek { position } => {
            room.set_position(sanitize(position));
            broadcast_playback(room, name);
        }
    }
}

fn sanitize(position: f64) -> f64 {
    if position.is_finite() {
        position.max(0.0)
    } else {
        0.0
    }
}

fn broadcast_playback(room: &Room, by: String) {
    let playback = room.playback();
    room.broadcast(&ServerMsg::Playback { playback, by });
}

async fn leave_room(state: &AppState, id: MemberId, room_name: &str) {
    let mut rooms = state.rooms.lock().await;
    let Some(room) = rooms.get_mut(room_name) else {
        return;
    };
    room.peers.remove(&id);
    if room.peers.is_empty() {
        rooms.remove(room_name);
        tracing::info!("комната «{room_name}» опустела и удалена");
    } else {
        room.broadcast(&ServerMsg::MemberLeft { id });
    }
}
