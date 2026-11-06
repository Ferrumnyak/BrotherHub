//! Сервер BrotherHub.
//!
//! Держит комнаты в памяти, пересылает сообщения чата и хранит общее
//! состояние воспроизведения каждой комнаты. Клиенты подключаются по
//! WebSocket на `/ws`.
//!
//! В каждой комнате есть ведущий: только он управляет воспроизведением,
//! может передать роль или исключить участника.
//!
//! Если у участника пропала связь, его место держится [`Config::grace`]
//! (по умолчанию 30 секунд): вернувшись с пропуском из `Welcome`, он
//! получает тот же id и ту же роль.

pub mod voice;

use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hasher},
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use brotherwatch_shared::{
    ClientMsg, Member, MemberId, PlaybackAction, PlaybackState, ServerMsg, SubtitleFile, Suggestion,
    VoiceAccess,
};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    net::TcpListener,
    sync::{mpsc, Mutex},
};

const MAX_NAME_LEN: usize = 32;
const MAX_CHAT_LEN: usize = 2000;
const MAX_MEDIA_LEN: usize = 2000;
/// Сколько предложений «что посмотреть» держит комната.
const MAX_SUGGESTIONS: usize = 30;
/// С запасом под файл субтитров (сам файл — до [`MAX_SUBTITLES_BYTES`]).
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
/// Субтитры к фильму обычно 50–150 КБ.
const MAX_SUBTITLES_BYTES: usize = 768 * 1024;
/// Эмодзи или `sticker:<id>`.
const MAX_EMOJI_LEN: usize = 32;
/// Больше людей в одной комнате — уже не «посмотреть с друзьями».
const MAX_ROOM_MEMBERS: usize = 16;
const MAX_ROOMS: usize = 200;
/// Очередь исходящих сообщений одного клиента. Если клиент не успевает
/// их забирать, лишнее выбрасывается, а не копится в памяти.
const OUTBOX: usize = 256;
/// Неверный пароль: пауза перед ответом и блокировка после серии ошибок.
const WRONG_PASSWORD_DELAY: Duration = Duration::from_millis(700);
const WRONG_PASSWORD_LIMIT: u32 = 5;
const WRONG_PASSWORD_LOCKOUT: Duration = Duration::from_secs(60);

/// Настройки сервера.
#[derive(Clone)]
pub struct Config {
    /// Пароль для входа (`None` — без пароля).
    pub password: Option<String>,
    /// Голосовая связь (`None` — выключена).
    pub livekit: Option<voice::LiveKit>,
    /// Сколько держать место за участником, у которого пропала связь.
    pub grace: Duration,
    /// Особый ключ (`None` — не задан).
    pub special_key: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            password: None,
            livekit: None,
            grace: Duration::from_secs(30),
            special_key: None,
        }
    }
}

/// Запустить сервер на готовом сокете (так его удобно запускать в тестах).
pub async fn serve(listener: TcpListener, config: Config) -> std::io::Result<()> {
    let state = Arc::new(AppState {
        rooms: Mutex::default(),
        failures: Mutex::default(),
        next_id: AtomicU64::new(0),
        config,
    });
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "ok" }))
        .with_state(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
}

// ---------- Комнаты ----------

type Tx = mpsc::Sender<ServerMsg>;

fn send(tx: &Tx, msg: ServerMsg) {
    // Полная очередь — клиент завис или очень медленный; не ждём его.
    let _ = tx.try_send(msg);
}

struct Peer {
    name: String,
    /// Пропуск для возвращения после обрыва связи.
    token: String,
    /// `None` — связь пропала, ждём переподключения.
    tx: Option<Tx>,
    /// Номер подключения, к которому сейчас привязан участник.
    conn: u64,
    gone_since: Option<Instant>,
    in_voice: bool,
    mic: bool,
    deaf: bool,
}

struct Room {
    peers: HashMap<MemberId, Peer>,
    host: MemberId,
    media: Option<String>,
    paused: bool,
    /// Позиция на момент `updated_at`.
    position: f64,
    updated_at: Instant,
    suggestions: Vec<Suggestion>,
    next_suggestion: u64,
    /// Шансы рулетки: кто задал → (главные ли, номер по порядку, шансы).
    rigs: HashMap<MemberId, (bool, u64, Vec<(u64, f64)>)>,
    next_rig: u64,
    /// Субтитры к текущему видео (сбрасываются при смене видео).
    subtitles: Option<SubtitleFile>,
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
            suggestions: Vec::new(),
            next_suggestion: 1,
            rigs: HashMap::new(),
            next_rig: 1,
            subtitles: None,
        }
    }

    /// Какие шансы взять: сначала главные, иначе самые свежие.
    fn active_rig(&self) -> Option<&Vec<(u64, f64)>> {
        self.rigs
            .values()
            .max_by_key(|(main, n, _)| (*main, *n))
            .map(|(_, _, w)| w)
    }

    fn broadcast_suggestions(&self) {
        self.broadcast(&ServerMsg::Suggestions {
            list: self.suggestions.clone(),
        });
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
            if let Some(tx) = &peer.tx {
                send(tx, msg.clone());
            }
        }
    }

    fn broadcast_except(&self, except: MemberId, msg: &ServerMsg) {
        for (id, peer) in &self.peers {
            if *id != except {
                if let Some(tx) = &peer.tx {
                    send(tx, msg.clone());
                }
            }
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
                online: p.tx.is_some(),
                in_voice: p.in_voice,
                mic: p.mic,
                deaf: p.deaf,
            })
            .collect();
        members.sort_by_key(|m| m.id);
        members
    }

    /// Убрать участника. Если это был ведущий — роль переходит к тому,
    /// кто дольше всех в комнате (у него самый маленький id), причём
    /// в первую очередь к тем, кто сейчас на связи.
    fn remove_peer(&mut self, id: MemberId, kicked: bool) -> Option<Peer> {
        let peer = self.peers.remove(&id)?;
        self.rigs.remove(&id);
        self.broadcast(&ServerMsg::MemberLeft { id, kicked });
        if self.host == id {
            let next = self
                .peers
                .iter()
                .filter(|(_, p)| p.tx.is_some())
                .map(|(id, _)| *id)
                .min()
                .or_else(|| self.peers.keys().min().copied());
            if let Some(next) = next {
                self.host = next;
                self.broadcast(&ServerMsg::HostChanged { host: next });
            }
        }
        Some(peer)
    }
}

/// Неверные пароли с одного адреса.
#[derive(Default)]
struct Failures {
    count: u32,
    locked_until: Option<Instant>,
}

struct AppState {
    rooms: Mutex<HashMap<String, Room>>,
    failures: Mutex<HashMap<IpAddr, Failures>>,
    next_id: AtomicU64,
    config: Config,
}

impl AppState {
    fn new_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Выкинуть участника из голосового канала (в фоне).
    fn remove_from_voice(&self, room: &str, id: MemberId) {
        if let Some(livekit) = self.config.livekit.clone() {
            let room = room.to_string();
            tokio::spawn(async move { livekit.remove_participant(&room, id).await });
        }
    }

    /// Проверить пароль. `Err` — текст ошибки для клиента.
    async fn check_password(&self, ip: IpAddr, password: Option<&str>) -> Result<(), String> {
        let Some(expected) = &self.config.password else {
            return Ok(());
        };
        {
            let mut failures = self.failures.lock().await;
            let entry = failures.entry(ip).or_default();
            if entry.locked_until.is_some_and(|t| Instant::now() < t) {
                return Err("слишком много неверных паролей, подожди минуту".into());
            }
            if password == Some(expected.as_str()) {
                failures.remove(&ip);
                return Ok(());
            }
            entry.count += 1;
            if entry.count >= WRONG_PASSWORD_LIMIT {
                entry.count = 0;
                entry.locked_until = Some(Instant::now() + WRONG_PASSWORD_LOCKOUT);
                tracing::warn!("{ip}: много неверных паролей, вход закрыт на минуту");
            }
        }
        // Пауза делает подбор пароля бессмысленно медленным.
        tokio::time::sleep(WRONG_PASSWORD_DELAY).await;
        Err("неверный пароль сервера".into())
    }
}

/// Простое «ведро с жетонами»: не больше `capacity` сообщений подряд,
/// дальше — `per_sec` в секунду.
struct RateLimit {
    tokens: f64,
    capacity: f64,
    per_sec: f64,
    last: Instant,
}

impl RateLimit {
    fn new(capacity: f64, per_sec: f64) -> Self {
        Self {
            tokens: capacity,
            capacity,
            per_sec,
            last: Instant::now(),
        }
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.per_sec)
            .min(self.capacity);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

fn random_u64() -> u64 {
    RandomState::new().build_hasher().finish()
}

/// Случайное предложение с учётом шансов (у кого вес не указан — 1).
fn pick_weighted(list: &[Suggestion], weights: &[(u64, f64)]) -> u64 {
    let weight = |id: u64| {
        weights
            .iter()
            .find(|(w, _)| *w == id)
            .map(|(_, w)| if w.is_finite() { w.max(0.0) } else { 0.0 })
            .unwrap_or(1.0)
    };
    let total: f64 = list.iter().map(|s| weight(s.id)).sum();
    if total <= 0.0 {
        return list[(random_u64() % list.len() as u64) as usize].id;
    }
    // Случайное число в [0, total).
    let mut at = (random_u64() >> 11) as f64 / (1u64 << 53) as f64 * total;
    for s in list {
        let w = weight(s.id);
        if at < w {
            return s.id;
        }
        at -= w;
    }
    list[list.len() - 1].id
}

fn new_token() -> String {
    // RandomState каждый раз берёт новый случайный ключ от ОС.
    let a = RandomState::new().build_hasher().finish();
    let b = RandomState::new().build_hasher().finish();
    format!("{a:016x}{b:016x}")
}

// ---------- Подключения ----------

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, addr.ip()))
}

/// Чем закончилось подключение.
enum Ending {
    /// Участник вышел сам или его исключили — место не держим.
    Left,
    /// Связь пропала — держим место, ждём возвращения.
    Lost,
}

/// Где сейчас это подключение.
struct Seat {
    room: String,
    id: MemberId,
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, ip: IpAddr) {
    let conn = state.new_id();
    let (mut sink, mut stream) = socket.split();

    // Всё, что отправляется этому клиенту, идёт через очередь:
    // так в неё могут писать другие участники комнаты.
    let (tx, mut rx) = mpsc::channel::<ServerMsg>(OUTBOX);
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

    let mut seat: Option<Seat> = None;
    let mut ending = Ending::Lost;
    let mut messages = RateLimit::new(40.0, 20.0);
    let mut chat = RateLimit::new(6.0, 1.5);
    // Реакции: не больше 3 подряд и дальше одна в ~1,2 с — чтобы вдвоём не завалить экран.
    let mut reactions = RateLimit::new(3.0, 0.8);
    let mut flood_warnings = 0u32;

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let cmd = match serde_json::from_str::<ClientMsg>(text.as_str()) {
            Ok(cmd) => cmd,
            Err(e) => {
                send(
                    &tx,
                    ServerMsg::Error {
                        message: format!("непонятное сообщение: {e}"),
                    },
                );
                continue;
            }
        };

        // Реакции — отдельный счётчик: частые, но лишние молча отбрасываем.
        if matches!(cmd, ClientMsg::React { .. }) && !reactions.allow() {
            continue;
        }
        let is_chat = matches!(cmd, ClientMsg::Chat { .. } | ClientMsg::Suggest { .. });
        if !messages.allow() || (is_chat && !chat.allow()) {
            flood_warnings += 1;
            if flood_warnings > 20 {
                tracing::warn!("{ip}: слишком много сообщений, отключаю");
                break;
            }
            send(
                &tx,
                ServerMsg::Error {
                    message: "слишком часто, подожди немного".into(),
                },
            );
            continue;
        }

        if matches!(cmd, ClientMsg::Leave) {
            ending = Ending::Left;
            break;
        }
        if handle_command(&state, conn, ip, &tx, &mut seat, cmd).await {
            // Нас исключили.
            ending = Ending::Left;
            break;
        }
    }

    if let Some(seat) = seat {
        match ending {
            Ending::Left => leave_room(&state, &seat.room, seat.id, conn).await,
            Ending::Lost => connection_lost(&state, seat, conn).await,
        }
    }
    // Дать отправиться последним сообщениям (например, «тебя исключили»).
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
}

/// Обработать команду. `true` — подключение нужно закрыть (зарезервировано;
/// исключённый клиент сам отключается, получив `Kicked`).
async fn handle_command(
    state: &Arc<AppState>,
    conn: u64,
    ip: IpAddr,
    tx: &Tx,
    seat: &mut Option<Seat>,
    cmd: ClientMsg,
) -> bool {
    let error = |message: &str| {
        send(
            tx,
            ServerMsg::Error {
                message: message.to_string(),
            },
        );
        false
    };

    if let ClientMsg::Join {
        room,
        name,
        password,
        resume,
    } = cmd
    {
        if seat.is_some() {
            return error("ты уже в комнате");
        }
        if let Err(e) = state.check_password(ip, password.as_deref()).await {
            tracing::warn!("{ip}: {e}");
            return error(&e);
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

        // Возвращение после обрыва связи — на своё место.
        if let Some(token) = resume {
            if let Some(r) = rooms.get_mut(&room) {
                let found = r
                    .peers
                    .iter()
                    .find(|(_, p)| p.token == token)
                    .map(|(id, _)| *id);
                if let Some(id) = found {
                    let peer = r.peers.get_mut(&id).expect("только что нашли");
                    peer.tx = Some(tx.clone());
                    peer.conn = conn;
                    peer.gone_since = None;
                    r.broadcast_except(id, &ServerMsg::MemberStatus { id, online: true });
                    let welcome = welcome(state, r, &room, id, token, true);
                    send(tx, welcome);
                    tracing::info!("участник {id} вернулся в «{room}»");
                    *seat = Some(Seat { room, id });
                    return false;
                }
            }
            // Место уже не держится — заходим как новый участник.
        }

        if !rooms.contains_key(&room) && rooms.len() >= MAX_ROOMS {
            return error("на сервере слишком много комнат, попробуй позже");
        }
        let id = state.new_id();
        let r = rooms.entry(room.clone()).or_insert_with(|| Room::new(id));
        if r.peers.len() >= MAX_ROOM_MEMBERS {
            return error("в комнате уже нет мест");
        }
        r.broadcast(&ServerMsg::MemberJoined {
            member: Member {
                id,
                name: name.clone(),
                online: true,
                in_voice: false,
                mic: false,
                deaf: false,
            },
        });
        let token = new_token();
        r.peers.insert(
            id,
            Peer {
                name: name.clone(),
                token: token.clone(),
                tx: Some(tx.clone()),
                conn,
                gone_since: None,
                in_voice: false,
                mic: false,
                deaf: false,
            },
        );
        let welcome = welcome(state, r, &room, id, token, false);
        send(tx, welcome);
        tracing::info!("участник {id} ({name}) вошёл в комнату «{room}»");
        *seat = Some(Seat { room, id });
        return false;
    }

    let Some(current) = seat.as_ref() else {
        return error("сначала нужно войти в комнату");
    };
    let (room_name, id) = (current.room.clone(), current.id);
    let mut rooms = state.rooms.lock().await;
    let Some(room) = rooms.get_mut(&room_name) else {
        *seat = None;
        return false;
    };
    let Some(name) = room.peers.get(&id).map(|p| p.name.clone()) else {
        // Нас исключили, а клиент ещё что-то шлёт.
        *seat = None;
        return error("ты больше не в этой комнате");
    };

    if let ClientMsg::Chat { text } = cmd {
        let text = text.trim();
        if text.is_empty() {
            return false;
        }
        if text.chars().count() > MAX_CHAT_LEN {
            return error("слишком длинное сообщение");
        }
        room.broadcast(&ServerMsg::Chat {
            from: id,
            name,
            text: text.to_string(),
        });
        return false;
    }

    // Это может делать любой участник.
    match cmd {
        ClientMsg::Suggest { media } => {
            let media = media.trim();
            if media.is_empty() || media.chars().count() > MAX_MEDIA_LEN {
                return error("некорректная ссылка");
            }
            if room.suggestions.iter().any(|s| s.media == media) {
                return error("это уже есть в списке");
            }
            if room.suggestions.len() >= MAX_SUGGESTIONS {
                return error("список предложений полон — уберите что-нибудь");
            }
            let suggestion_id = room.next_suggestion;
            room.next_suggestion += 1;
            room.suggestions.push(Suggestion {
                id: suggestion_id,
                media: media.to_string(),
                by: id,
                name,
            });
            room.broadcast_suggestions();
            return false;
        }
        ClientMsg::RemoveSuggestion { id: suggestion_id } => {
            let Some(pos) = room.suggestions.iter().position(|s| s.id == suggestion_id) else {
                return false; // уже убрали
            };
            if room.suggestions[pos].by != id && room.host != id {
                return error("убрать чужое предложение может только ведущий");
            }
            room.suggestions.remove(pos);
            room.broadcast_suggestions();
            return false;
        }
        ClientMsg::Loaded { media } => {
            if room.media.as_deref() == Some(media.as_str()) {
                room.broadcast(&ServerMsg::MemberLoaded { id, media });
            }
            return false;
        }
        ClientMsg::Rig { weights, key } => {
            if weights.is_empty() {
                room.rigs.remove(&id);
            } else {
                let main = state
                    .config
                    .special_key
                    .as_deref()
                    .is_some_and(|k| key.as_deref() == Some(k));
                let n = room.next_rig;
                room.next_rig += 1;
                let weights = weights.into_iter().take(MAX_SUGGESTIONS).collect();
                room.rigs.insert(id, (main, n, weights));
            }
            return false;
        }
        ClientMsg::VoiceState { in_voice, mic, deaf } => {
            if let Some(peer) = room.peers.get_mut(&id) {
                if (peer.in_voice, peer.mic, peer.deaf) == (in_voice, mic, deaf) {
                    return false;
                }
                peer.in_voice = in_voice;
                peer.mic = mic;
                peer.deaf = deaf;
            }
            room.broadcast(&ServerMsg::MemberVoice {
                id,
                in_voice,
                mic,
                deaf,
            });
            return false;
        }
        ClientMsg::React { emoji } => {
            let emoji = emoji.trim();
            if emoji.is_empty() || emoji.chars().count() > MAX_EMOJI_LEN {
                return false;
            }
            room.broadcast(&ServerMsg::Reaction {
                from: id,
                name,
                emoji: emoji.to_string(),
            });
            return false;
        }
        cmd => handle_host_command(state, &room_name, room, id, name, tx, cmd),
    }
}

/// Команды, которые может давать только ведущий.
fn handle_host_command(
    state: &Arc<AppState>,
    room_name: &str,
    room: &mut Room,
    id: MemberId,
    name: String,
    tx: &Tx,
    cmd: ClientMsg,
) -> bool {
    let error = |message: &str| {
        send(
            tx,
            ServerMsg::Error {
                message: message.to_string(),
            },
        );
        false
    };

    // Всё остальное — только для ведущего.
    if room.host != id {
        return error("это может делать только ведущий");
    }

    match cmd {
        ClientMsg::Join { .. }
        | ClientMsg::Leave
        | ClientMsg::Chat { .. }
        | ClientMsg::Suggest { .. }
        | ClientMsg::RemoveSuggestion { .. }
        | ClientMsg::Loaded { .. }
        | ClientMsg::Rig { .. }
        | ClientMsg::VoiceState { .. }
        | ClientMsg::React { .. } => {
            unreachable!("обработано выше")
        }
        ClientMsg::SetSubtitles { subtitles } => {
            if room.media.is_none() {
                return error("сначала включи видео");
            }
            if let Some(file) = &subtitles {
                if file.text.len() > MAX_SUBTITLES_BYTES {
                    return error("файл субтитров слишком большой");
                }
                if file.name.trim().is_empty() || file.name.chars().count() > 200 {
                    return error("некорректное имя файла субтитров");
                }
            }
            room.subtitles = subtitles.clone();
            room.broadcast(&ServerMsg::Subtitles { subtitles });
        }
        ClientMsg::SetMedia { media } => {
            let media = media.trim();
            if media.is_empty() || media.chars().count() > MAX_MEDIA_LEN {
                return error("некорректное название или ссылка");
            }
            room.media = Some(media.to_string());
            room.paused = true;
            room.subtitles = None;
            room.set_position(0.0);
            room.broadcast_playback(Some(PlaybackAction::SetMedia), Some(name));
            // Включили то, что было в предложениях, — из списка убираем.
            let before = room.suggestions.len();
            room.suggestions.retain(|s| s.media != media);
            if room.suggestions.len() != before {
                room.broadcast_suggestions();
            }
        }
        ClientMsg::ClearMedia => {
            room.media = None;
            room.subtitles = None;
            room.paused = true;
            room.set_position(0.0);
            room.broadcast_playback(Some(PlaybackAction::SetMedia), Some(name));
        }
        ClientMsg::Spin { weights } => {
            if room.suggestions.is_empty() {
                return error("в списке предложений пусто");
            }
            // Тайная подкрутка (если есть) главнее шансов от самого крутящего.
            let weights = room.active_rig().cloned().unwrap_or(weights);
            let winner = pick_weighted(&room.suggestions, &weights);
            room.broadcast(&ServerMsg::Roulette { winner, by: name });
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
                    if let Some(peer_tx) = &peer.tx {
                        send(peer_tx, ServerMsg::Kicked { by: name.clone() });
                    }
                    state.remove_from_voice(room_name, target);
                    tracing::info!("{name} исключил {} из «{room_name}»", peer.name);
                }
                None => return error("такого участника нет в комнате"),
            }
        }
    }
    false
}

fn welcome(
    state: &AppState,
    room: &Room,
    room_name: &str,
    id: MemberId,
    token: String,
    resumed: bool,
) -> ServerMsg {
    let name = room.peers.get(&id).map(|p| p.name.as_str()).unwrap_or("");
    let voice = state.config.livekit.as_ref().map(|lk| VoiceAccess {
        url: lk.url.clone(),
        token: lk.join_token(room_name, id, name),
    });
    ServerMsg::Welcome {
        you: id,
        token,
        resumed,
        room: room_name.to_string(),
        host: room.host,
        members: room.members(),
        playback: room.playback(),
        voice,
        suggestions: room.suggestions.clone(),
        subtitles: room.subtitles.clone(),
    }
}

fn sanitize(position: f64) -> f64 {
    if position.is_finite() {
        position.max(0.0)
    } else {
        0.0
    }
}

/// Ушёл насовсем: сразу освобождаем место.
async fn leave_room(state: &AppState, room_name: &str, id: MemberId, conn: u64) {
    let mut rooms = state.rooms.lock().await;
    let Some(room) = rooms.get_mut(room_name) else {
        return;
    };
    // Место могло уже перейти к новому подключению этого же участника.
    if room.peers.get(&id).is_some_and(|p| p.conn != conn) {
        return;
    }
    // Голос — только для тех, кто в комнате.
    if room.remove_peer(id, false).is_some() {
        state.remove_from_voice(room_name, id);
    }
    if room.peers.is_empty() {
        rooms.remove(room_name);
        tracing::info!("комната «{room_name}» опустела и удалена");
    }
}

/// Связь пропала: держим место [`Config::grace`], потом освобождаем.
async fn connection_lost(state: &Arc<AppState>, seat: Seat, conn: u64) {
    {
        let mut rooms = state.rooms.lock().await;
        let Some(room) = rooms.get_mut(&seat.room) else {
            return;
        };
        let Some(peer) = room.peers.get_mut(&seat.id) else {
            return;
        };
        if peer.conn != conn {
            return; // уже переподключился через другое соединение
        }
        peer.tx = None;
        peer.gone_since = Some(Instant::now());
        room.broadcast(&ServerMsg::MemberStatus {
            id: seat.id,
            online: false,
        });
        // Пульт не ждёт 30 секунд — сразу переходит тому, кто на связи.
        if room.host == seat.id {
            let next = room
                .peers
                .iter()
                .filter(|(id, p)| **id != seat.id && p.tx.is_some())
                .map(|(id, _)| *id)
                .min();
            if let Some(next) = next {
                room.host = next;
                room.broadcast(&ServerMsg::HostChanged { host: next });
                tracing::info!("пульт перешёл к {next}: у прошлого пропала связь");
            }
        }
        tracing::info!("у участника {} пропала связь, жду возвращения", seat.id);
    }

    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(state.config.grace).await;
        let mut rooms = state.rooms.lock().await;
        let Some(room) = rooms.get_mut(&seat.room) else {
            return;
        };
        let still_gone = room
            .peers
            .get(&seat.id)
            .is_some_and(|p| p.conn == conn && p.tx.is_none());
        if !still_gone {
            return;
        }
        room.remove_peer(seat.id, false);
        state.remove_from_voice(&seat.room, seat.id);
        tracing::info!("участник {} так и не вернулся", seat.id);
        if room.peers.is_empty() {
            rooms.remove(&seat.room);
            tracing::info!("комната «{}» опустела и удалена", seat.room);
        }
    });
}
