//! Сервер BrotherWatch.
//!
//! Держит комнаты в памяти, пересылает сообщения чата и хранит общее
//! состояние воспроизведения каждой комнаты. Клиенты подключаются по
//! WebSocket на `/ws`.
//!
//! В каждой комнате есть глава лобби: только он управляет
//! воспроизведением, может передать роль или исключить участника.
//!
//! Настройки — переменные окружения:
//! - `BROTHERWATCH_ADDR` — адрес (по умолчанию `0.0.0.0:8080`);
//! - `BROTHERWATCH_PASSWORD` — пароль для входа (по умолчанию без пароля);
//! - `LIVEKIT_*` — голосовая связь, см. [`voice`].
//!
//! `--dev` — режим разработки: голос через `livekit-server --dev` на этом ПК.

mod voice;

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
use brotherwatch_shared::{
    ClientMsg, Member, MemberId, PlaybackAction, PlaybackState, ServerMsg, VoiceAccess,
};
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
    host: MemberId,
    media: Option<String>,
    paused: bool,
    /// Позиция на момент `updated_at`.
    position: f64,
    updated_at: Instant,
}

impl Room {
    fn new(host: MemberId) -> Self {
        Self {
            peers: HashMap::new(),
            host,
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
        self.position = sanitize(position);
        self.updated_at = Instant::now();
    }

    fn broadcast(&self, msg: &ServerMsg) {
        for peer in self.peers.values() {
            let _ = peer.tx.send(msg.clone());
        }
    }

    fn broadcast_playback(&self, action: Option<PlaybackAction>, by: Option<String>) {
        self.broadcast(&ServerMsg::Playback {
            playback: self.playback(),
            action,
            by,
        });
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

    /// Убрать участника. Если это был глава — роль переходит к тому,
    /// кто дольше всех в комнате (у него самый маленький id).
    fn remove_peer(&mut self, id: MemberId, kicked: bool) -> Option<Peer> {
        let peer = self.peers.remove(&id)?;
        self.broadcast(&ServerMsg::MemberLeft { id, kicked });
        if self.host == id {
            if let Some(&next) = self.peers.keys().min() {
                self.host = next;
                self.broadcast(&ServerMsg::HostChanged { host: next });
            }
        }
        Some(peer)
    }
}

struct AppState {
    rooms: Mutex<HashMap<String, Room>>,
    next_id: AtomicU64,
    password: Option<String>,
    livekit: Option<voice::LiveKit>,
}

impl AppState {
    /// Выкинуть участника из голосового канала (в фоне).
    fn remove_from_voice(&self, room: &str, id: MemberId) {
        if let Some(livekit) = self.livekit.clone() {
            let room = room.to_string();
            tokio::spawn(async move { livekit.remove_participant(&room, id).await });
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let dev = std::env::args().any(|a| a == "--dev");
    let addr = std::env::var("BROTHERWATCH_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let password = std::env::var("BROTHERWATCH_PASSWORD")
        .ok()
        .filter(|p| !p.is_empty());
    let livekit = voice::LiveKit::from_env(dev);

    if password.is_none() {
        tracing::warn!(
            "пароль не задан (BROTHERWATCH_PASSWORD) — войти может любой, кто знает адрес"
        );
    }
    match &livekit {
        Some(lk) => tracing::info!("голосовая связь: {}", lk.url),
        None => tracing::warn!(
            "голосовая связь выключена (нет LIVEKIT_URL; для разработки — флаг --dev)"
        ),
    }

    let state = Arc::new(AppState {
        rooms: Mutex::default(),
        next_id: AtomicU64::new(0),
        password,
        livekit,
    });

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

    if let ClientMsg::Join {
        room,
        name,
        password,
    } = cmd
    {
        if current_room.is_some() {
            return error("ты уже в комнате");
        }
        if let Some(expected) = &state.password {
            if password.as_deref() != Some(expected.as_str()) {
                tracing::warn!("участник {id}: неверный пароль");
                return error("неверный пароль сервера");
            }
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
        let r = rooms.entry(room.clone()).or_insert_with(|| Room::new(id));
        let member = Member {
            id,
            name: name.clone(),
        };
        r.broadcast(&ServerMsg::MemberJoined {
            member: member.clone(),
        });
        r.peers.insert(
            id,
            Peer {
                name,
                tx: tx.clone(),
            },
        );
        let voice = state.livekit.as_ref().map(|lk| VoiceAccess {
            url: lk.url.clone(),
            token: lk.join_token(&room, id, &member.name),
        });
        let _ = tx.send(ServerMsg::Welcome {
            you: id,
            room: room.clone(),
            host: r.host,
            members: r.members(),
            playback: r.playback(),
            voice,
        });
        tracing::info!("участник {id} ({}) вошёл в комнату «{room}»", member.name);
        *current_room = Some(room);
        return;
    }

    let Some(room_name) = current_room.clone() else {
        return error("сначала нужно войти в комнату");
    };
    let mut rooms = state.rooms.lock().await;
    let Some(room) = rooms.get_mut(&room_name) else {
        *current_room = None;
        return;
    };
    let Some(name) = room.peers.get(&id).map(|p| p.name.clone()) else {
        // Нас исключили, а клиент ещё что-то шлёт.
        *current_room = None;
        return error("ты больше не в этой комнате");
    };

    if let ClientMsg::Chat { text } = cmd {
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
        return;
    }

    // Всё остальное — только для главы лобби.
    if room.host != id {
        return error("это может делать только глава лобби");
    }

    match cmd {
        ClientMsg::Join { .. } | ClientMsg::Chat { .. } => unreachable!("обработано выше"),
        ClientMsg::SetMedia { media } => {
            let media = media.trim();
            if media.is_empty() || media.chars().count() > MAX_MEDIA_LEN {
                return error("некорректное название или ссылка");
            }
            room.media = Some(media.to_string());
            room.paused = true;
            room.set_position(0.0);
            room.broadcast_playback(Some(PlaybackAction::SetMedia), Some(name));
        }
        ClientMsg::Play { position } => {
            room.paused = false;
            room.set_position(position);
            room.broadcast_playback(Some(PlaybackAction::Play), Some(name));
        }
        ClientMsg::Pause { position } => {
            room.paused = true;
            room.set_position(position);
            room.broadcast_playback(Some(PlaybackAction::Pause), Some(name));
        }
        ClientMsg::Seek { position } => {
            room.set_position(position);
            room.broadcast_playback(Some(PlaybackAction::Seek), Some(name));
        }
        ClientMsg::Sync { position, paused } => {
            room.paused = paused;
            room.set_position(position);
            room.broadcast_playback(None, None);
        }
        ClientMsg::TransferHost { to } => {
            if !room.peers.contains_key(&to) {
                return error("такого участника нет в комнате");
            }
            room.host = to;
            room.broadcast(&ServerMsg::HostChanged { host: to });
        }
        ClientMsg::Kick { id: target } => {
            if target == id {
                return error("нельзя исключить самого себя");
            }
            match room.remove_peer(target, true) {
                Some(peer) => {
                    let _ = peer.tx.send(ServerMsg::Kicked { by: name.clone() });
                    state.remove_from_voice(&room_name, target);
                    tracing::info!("{name} исключил {} из «{room_name}»", peer.name);
                }
                None => error("такого участника нет в комнате"),
            }
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

async fn leave_room(state: &AppState, id: MemberId, room_name: &str) {
    let mut rooms = state.rooms.lock().await;
    let Some(room) = rooms.get_mut(room_name) else {
        return;
    };
    // Голос — только для тех, кто в комнате.
    if room.remove_peer(id, false).is_some() {
        state.remove_from_voice(room_name, id);
    }
    if room.peers.is_empty() {
        rooms.remove(room_name);
        tracing::info!("комната «{room_name}» опустела и удалена");
    }
}
