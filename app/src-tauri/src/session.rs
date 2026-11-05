//! Синхронизация воспроизведения между участниками комнаты.
//!
//! Глава лобби — источник истины: его действия в mpv (пауза, play,
//! перемотка) отправляются на сервер, плюс раз в пару секунд он сообщает
//! свою позицию. Остальные подстраивают свой mpv под состояние комнаты:
//! если позиция разошлась больше чем на [`TOLERANCE`], делают перемотку,
//! а свои пауза/перемотка у них откатываются к общему состоянию.

use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use brotherwatch_shared::{is_url, ClientMsg, MemberId, PlaybackState, ServerMsg};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};

use crate::player::{Player, PlayerEvent, PlayerEventMsg};

/// Допустимое расхождение с главой, секунды.
const TOLERANCE: f64 = 0.7;
/// Как часто глава сообщает позицию.
const SYNC_INTERVAL: Duration = Duration::from_secs(2);
/// После перемотки даём плееру время загрузиться, прежде чем снова
/// поправлять позицию (важно для онлайн-видео, где перемотка небыстрая).
const SEEK_COOLDOWN: Duration = Duration::from_secs(4);

pub type SharedSession = Arc<Mutex<Session>>;

/// Состояние плеера для интерфейса (событие `player-status`).
#[derive(Clone, Serialize)]
pub struct PlayerStatus {
    /// Открыто ли окно mpv.
    running: bool,
    /// Что открыто в плеере (имя файла или ссылка — как в комнате).
    loaded: Option<String>,
}

struct RoomPlayback {
    state: PlaybackState,
    /// Когда получено/изменено состояние.
    at: Instant,
}

impl RoomPlayback {
    fn new(state: PlaybackState) -> Self {
        Self {
            state,
            at: Instant::now(),
        }
    }

    /// Где сейчас должно быть видео.
    fn expected_position(&self) -> f64 {
        if self.state.paused {
            self.state.position
        } else {
            self.state.position + self.at.elapsed().as_secs_f64()
        }
    }
}

pub struct Session {
    app: AppHandle,
    player_events: mpsc::UnboundedSender<PlayerEventMsg>,
    net: Option<mpsc::UnboundedSender<ClientMsg>>,
    me: Option<MemberId>,
    host: Option<MemberId>,
    room: Option<RoomPlayback>,
    player: Option<Player>,
    player_paused: bool,
    loaded: Option<String>,
    last_seek: Option<Instant>,
}

impl Session {
    /// Создать сессию и запустить фоновые задачи.
    pub fn start(app: AppHandle) -> SharedSession {
        let (events_tx, mut events_rx) = mpsc::unbounded_channel::<PlayerEventMsg>();
        let session = Arc::new(Mutex::new(Session {
            app,
            player_events: events_tx,
            net: None,
            me: None,
            host: None,
            room: None,
            player: None,
            player_paused: true,
            loaded: None,
            last_seek: None,
        }));

        // События от mpv.
        let s = session.clone();
        tauri::async_runtime::spawn(async move {
            while let Some((id, ev)) = events_rx.recv().await {
                s.lock().await.on_player_event(id, ev).await;
            }
        });

        // Регулярная синхронизация.
        let s = session.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(SYNC_INTERVAL);
            loop {
                interval.tick().await;
                s.lock().await.tick().await;
            }
        });

        session
    }

    pub fn connected(&mut self, net: mpsc::UnboundedSender<ClientMsg>) {
        self.net = Some(net);
        self.me = None;
        self.host = None;
        self.room = None;
    }

    pub fn disconnected(&mut self) {
        self.net = None;
        self.me = None;
        self.host = None;
        self.room = None;
    }

    fn is_host(&self) -> bool {
        self.me.is_some() && self.me == self.host
    }

    fn send(&self, msg: ClientMsg) {
        if let Some(net) = &self.net {
            let _ = net.send(msg);
        }
    }

    fn status(&self) -> PlayerStatus {
        PlayerStatus {
            running: self.player.is_some(),
            loaded: self.loaded.clone(),
        }
    }

    fn emit_status(&self) {
        let _ = self.app.emit("player-status", self.status());
    }

    fn room_media(&self) -> Option<String> {
        self.room.as_ref().and_then(|r| r.state.media.clone())
    }

    /// Открыт ли в плеере именно тот файл/ссылка, что смотрит комната.
    fn in_sync_media(&self) -> bool {
        let media = self.room_media();
        media.is_some() && self.loaded == media
    }

    /// Глава поменял состояние сам — запоминаем, не дожидаясь сервера.
    fn set_local(&mut self, paused: bool, position: f64) {
        if let Some(room) = &mut self.room {
            room.state.paused = paused;
            room.state.position = position;
            room.at = Instant::now();
        }
    }

    async fn ensure_player(&mut self) -> Result<(), String> {
        if self.player.is_none() {
            let player = Player::spawn(self.player_events.clone()).await?;
            self.player = Some(player);
            self.player_paused = true;
            self.loaded = None;
            self.emit_status();
        }
        Ok(())
    }

    // ---------- Сообщения от сервера ----------

    pub async fn on_server_msg(&mut self, msg: &ServerMsg) {
        match msg {
            ServerMsg::Welcome {
                you,
                host,
                playback,
                ..
            } => {
                self.me = Some(*you);
                self.host = Some(*host);
                self.set_room(playback.clone()).await;
            }
            ServerMsg::HostChanged { host } => {
                self.host = Some(*host);
            }
            ServerMsg::Playback { playback, .. } => {
                // Глава сам источник истины: свои же сообщения, вернувшиеся
                // от сервера, он игнорирует (они уже чуть устарели).
                if self.is_host() && self.room_media() == playback.media {
                    return;
                }
                self.set_room(playback.clone()).await;
            }
            ServerMsg::Kicked { .. } => self.disconnected(),
            _ => {}
        }
    }

    async fn set_room(&mut self, state: PlaybackState) {
        self.room = Some(RoomPlayback::new(state));
        self.follow_media().await;
        self.apply().await;
    }

    /// Комната смотрит что-то другое — ссылку открываем сами,
    /// а локальный файл каждый выбирает у себя (интерфейс покажет подсказку).
    async fn follow_media(&mut self) {
        let Some(media) = self.room_media() else {
            return;
        };
        if self.loaded.as_deref() == Some(media.as_str()) {
            return;
        }
        if let Some(player) = &self.player {
            player.set_pause(true);
        }
        if is_url(&media) && !self.is_host() {
            match self.ensure_player().await {
                Ok(()) => {
                    if let Some(player) = &self.player {
                        player.load(&media);
                    }
                    self.loaded = Some(media);
                }
                Err(e) => {
                    let _ = self.app.emit("player-error", e);
                }
            }
        }
        self.emit_status();
    }

    /// Подстроить свой плеер под комнату (только для не-глав).
    async fn apply(&mut self) {
        if self.is_host() || !self.in_sync_media() {
            return;
        }
        let (Some(player), Some(room)) = (&self.player, &self.room) else {
            return;
        };
        if self.player_paused != room.state.paused {
            player.set_pause(room.state.paused);
        }
        let recently_seeked = self.last_seek.is_some_and(|t| t.elapsed() < SEEK_COOLDOWN);
        if recently_seeked {
            return;
        }
        if let Some(position) = player.time_pos().await {
            let expected = room.expected_position();
            if (position - expected).abs() > TOLERANCE {
                player.seek(expected);
                self.last_seek = Some(Instant::now());
            }
        }
    }

    // ---------- События плеера ----------

    pub async fn on_player_event(&mut self, player_id: u64, ev: PlayerEvent) {
        // Событие от старого, уже закрытого окна mpv.
        if self.player.as_ref().map(|p| p.id) != Some(player_id) {
            return;
        }
        match ev {
            PlayerEvent::Shutdown => {
                self.player = None;
                self.loaded = None;
                self.emit_status();
            }
            PlayerEvent::Pause(paused) => {
                self.player_paused = paused;
                if self.is_host() {
                    self.host_paused(paused).await;
                } else {
                    self.apply().await;
                }
            }
            PlayerEvent::Restart => {
                if self.is_host() {
                    self.host_seeked().await;
                } else {
                    self.apply().await;
                }
            }
            PlayerEvent::FileLoaded => {
                if !self.is_host() {
                    self.last_seek = None;
                    self.apply().await;
                }
            }
        }
    }

    async fn host_paused(&mut self, paused: bool) {
        if !self.in_sync_media() {
            return;
        }
        let room_paused = self.room.as_ref().map(|r| r.state.paused);
        if room_paused == Some(paused) {
            return;
        }
        let Some(player) = &self.player else {
            return;
        };
        let position = player.time_pos().await.unwrap_or(0.0);
        self.send(if paused {
            ClientMsg::Pause { position }
        } else {
            ClientMsg::Play { position }
        });
        self.set_local(paused, position);
    }

    async fn host_seeked(&mut self) {
        if !self.in_sync_media() {
            return;
        }
        let (Some(player), Some(room)) = (&self.player, &self.room) else {
            return;
        };
        let Some(position) = player.time_pos().await else {
            return;
        };
        if (position - room.expected_position()).abs() <= TOLERANCE {
            return;
        }
        let paused = room.state.paused;
        self.send(ClientMsg::Seek { position });
        self.set_local(paused, position);
    }

    /// Раз в [`SYNC_INTERVAL`]: глава сообщает позицию, остальные сверяются.
    async fn tick(&mut self) {
        if !self.is_host() {
            self.apply().await;
            return;
        }
        if !self.in_sync_media() {
            return;
        }
        let Some(player) = &self.player else {
            return;
        };
        let Some(position) = player.time_pos().await else {
            return;
        };
        let paused = self.player_paused;
        self.send(ClientMsg::Sync { position, paused });
        self.set_local(paused, position);
    }

    // ---------- Действия из интерфейса ----------

    pub async fn open_file(&mut self, path: String) -> Result<(), String> {
        let host = self.is_host();
        let room_media = self.room_media();
        if !host && !room_media.as_deref().is_some_and(|m| !is_url(m)) {
            return Err("Глава лобби ещё не выбрал файл".into());
        }

        self.ensure_player().await?;
        if let Some(player) = &self.player {
            player.set_pause(true);
            player.load(&path);
        }

        if host {
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            self.send(ClientMsg::SetMedia {
                media: name.clone(),
            });
            self.room = Some(RoomPlayback::new(PlaybackState {
                media: Some(name.clone()),
                paused: true,
                position: 0.0,
            }));
            self.loaded = Some(name);
        } else {
            // Свой файл может называться иначе — считаем, что это он.
            self.loaded = room_media;
            self.last_seek = None;
        }
        self.emit_status();
        Ok(())
    }

    pub async fn open_url(&mut self, url: String) -> Result<(), String> {
        let url = url.trim().to_string();
        if !self.is_host() {
            // Не-глава может только заново открыть ссылку, которую смотрит комната
            // (например, если случайно закрыл окно плеера).
            if self.room_media().as_deref() != Some(url.as_str()) {
                return Err("Выбирать, что смотрим, может только глава лобби".into());
            }
            self.ensure_player().await?;
            if let Some(player) = &self.player {
                player.load(&url);
            }
            self.loaded = Some(url);
            self.last_seek = None;
            self.emit_status();
            return Ok(());
        }
        if !is_url(&url) {
            return Err("Ссылка должна начинаться с http:// или https://".into());
        }
        self.ensure_player().await?;
        if let Some(player) = &self.player {
            player.set_pause(true);
            player.load(&url);
        }
        self.send(ClientMsg::SetMedia { media: url.clone() });
        self.room = Some(RoomPlayback::new(PlaybackState {
            media: Some(url.clone()),
            paused: true,
            position: 0.0,
        }));
        self.loaded = Some(url);
        self.emit_status();
        Ok(())
    }
}

// ---------- Команды для интерфейса ----------

#[tauri::command]
pub async fn open_file(session: State<'_, SharedSession>, path: String) -> Result<(), String> {
    session.lock().await.open_file(path).await
}

#[tauri::command]
pub async fn open_url(session: State<'_, SharedSession>, url: String) -> Result<(), String> {
    session.lock().await.open_url(url).await
}

#[tauri::command]
pub async fn player_status(session: State<'_, SharedSession>) -> Result<PlayerStatus, String> {
    Ok(session.lock().await.status())
}
