//! Синхронизация воспроизведения между участниками комнаты.
//!
//! Глава лобби — источник истины: его действия в mpv (пауза, play,
//! перемотка) отправляются на сервер, плюс раз в пару секунд он сообщает
//! свою позицию. Остальные подстраивают свой mpv под состояние комнаты:
//! если позиция разошлась больше чем на [`TOLERANCE`], делают перемотку,
//! а свои пауза/перемотка у них откатываются к общему состоянию.

use std::{
    collections::VecDeque,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use brotherwatch_shared::{is_url, ClientMsg, MemberId, PlaybackState, ServerMsg, SubtitleFile};
use serde_json::Value;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};

use crate::player::{Player, PlayerEvent, PlayerEventMsg};
use crate::video::VideoHost;

/// Допустимое расхождение с главой, секунды.
const TOLERANCE: f64 = 0.7;
/// Как часто глава сообщает позицию.
const SYNC_INTERVAL: Duration = Duration::from_secs(2);
/// После перемотки даём плееру время загрузиться, прежде чем снова
/// поправлять позицию (важно для онлайн-видео, где перемотка небыстрая).
const SEEK_COOLDOWN: Duration = Duration::from_secs(4);
/// Сколько висят сообщения чата поверх видео (вместе с затуханием).
const OVERLAY_TTL: Duration = Duration::from_secs(7);
/// Плавное появление и затухание сообщений, секунды.
const OVERLAY_FADE_IN: f64 = 0.3;
const OVERLAY_FADE_OUT: f64 = 1.5;
/// Как часто перерисовывать сообщения во время затухания.
const OVERLAY_FRAME: Duration = Duration::from_millis(80);
/// Сколько последних сообщений показывать поверх видео.
const OVERLAY_LINES: usize = 4;

pub type SharedSession = Arc<Mutex<Session>>;

/// Позиция, длительность и громкость для панели управления.
#[derive(Clone, Serialize)]
pub struct PlaybackInfo {
    position: Option<f64>,
    duration: Option<f64>,
    paused: bool,
    volume: Option<f64>,
    /// Название, которое отдал сайт (для истории просмотров).
    title: Option<String>,
    /// Доиграло до конца (для «дальше — по списку»).
    ended: bool,
}

/// Обложка для трека без картинки (SoundCloud и т.п.) — событие `player-cover`.
#[derive(Clone, Serialize)]
pub struct Cover {
    image: Option<String>,
    title: Option<String>,
    artist: Option<String>,
}

/// Самый большой файл субтитров, который можно раздать (как на сервере).
const MAX_SUBTITLES_BYTES: usize = 768 * 1024;

/// Кнопки панели управления.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Control {
    TogglePause,
    /// Запустить (автозапуск, когда видео открылось у всех).
    Play,
    Seek {
        position: f64,
    },
    SeekBy {
        delta: f64,
    },
    Volume {
        value: f64,
    },
    /// Аудиодорожка (`None` — без звука).
    SetAudio {
        id: Option<i64>,
    },
    /// Субтитры (`None` — выключить).
    SetSubtitle {
        id: Option<i64>,
    },
    /// Подключить субтитры из файла.
    AddSubtitle {
        path: String,
    },
}

/// Дорожка видео/аудио/субтитров (событие `player-tracks`).
#[derive(Debug, Clone, Serialize)]
pub struct Track {
    id: i64,
    /// `audio`, `sub` или `video`.
    kind: String,
    title: Option<String>,
    lang: Option<String>,
    codec: Option<String>,
    channels: Option<i64>,
    /// Отдельный файл (а не дорожка внутри видео).
    external: bool,
    selected: bool,
}

impl Track {
    fn from_mpv(v: &serde_json::Value) -> Option<Self> {
        let text = |key: &str| v.get(key).and_then(|x| x.as_str()).map(String::from);
        Some(Self {
            id: v.get("id")?.as_i64()?,
            kind: text("type")?,
            title: text("title"),
            lang: text("lang"),
            codec: text("codec"),
            channels: v.get("demux-channel-count").and_then(|x| x.as_i64()),
            external: v.get("external").and_then(|x| x.as_bool()).unwrap_or(false),
            selected: v.get("selected").and_then(|x| x.as_bool()).unwrap_or(false),
        })
    }
}

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
    /// Текущая скорость плеера: не-ведущий слегка ускоряется или
    /// замедляется, чтобы незаметно догнать ведущего.
    speed: f64,
    /// Когда mpv сообщил об ошибке загрузки. Ошибку показываем, только если
    /// за пару секунд так ничего и не загрузилось: при смене качества и у
    /// некоторых сайтов mpv сообщает о промежуточных ошибках, а видео
    /// потом всё равно открывается.
    load_failed_at: Option<Instant>,
    /// Ссылка, которую уже открывали заново после ошибки: YouTube иногда
    /// обрывает соединение на старте, и со второго раза всё открывается.
    retried: Option<String>,
    /// Качество ссылок: высота кадра (`None` — авто, до 1080p).
    quality: Option<u32>,
    /// После смены качества ждём загрузки, чтобы сбросить начальную позицию.
    reloading: bool,
    /// Показывать сообщения чата поверх видео (когда панель чата скрыта).
    overlay_enabled: bool,
    overlay: VecDeque<(Instant, String, String)>,
    /// Субтитры, которые ведущий раздал к текущему видео.
    subtitles: Option<SubtitleFile>,
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
            speed: 1.0,
            load_failed_at: None,
            retried: None,
            quality: None,
            reloading: false,
            overlay_enabled: false,
            overlay: VecDeque::new(),
            subtitles: None,
        }));

        // События от mpv.
        let s = session.clone();
        tauri::async_runtime::spawn(async move {
            while let Some((id, ev)) = events_rx.recv().await {
                s.lock().await.on_player_event(id, ev).await;
            }
        });

        // Плавное появление и затухание сообщений поверх видео.
        let s = session.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(OVERLAY_FRAME);
            loop {
                interval.tick().await;
                s.lock().await.animate_overlay();
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
        // Вне комнаты видео не видно — закрываем плеер, чтобы не играл звук.
        if self.player.take().is_some() {
            self.loaded = None;
            self.overlay.clear();
            self.emit_status();
        }
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
            let wid = self.app.state::<VideoHost>().wid();
            let player = Player::spawn(self.player_events.clone(), wid, self.quality).await?;
            self.player = Some(player);
            self.speed = 1.0;
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
                subtitles,
                ..
            } => {
                self.me = Some(*you);
                self.host = Some(*host);
                self.subtitles = subtitles.clone();
                self.set_room(playback.clone()).await;
                // Видео уже было открыто (вернулись после обрыва) — субтитры сразу.
                if self.loaded.is_some() && self.loaded == self.room_media() {
                    self.apply_subtitles();
                }
            }
            ServerMsg::Subtitles { subtitles } => {
                self.subtitles = subtitles.clone();
                if subtitles.is_none() {
                    if let Some(player) = &self.player {
                        player.command(serde_json::json!(["sub-remove"]));
                    }
                } else if self.loaded.is_some() && self.loaded == self.room_media() {
                    self.apply_subtitles();
                }
            }
            ServerMsg::HostChanged { host } => {
                self.host = Some(*host);
                // Ведущий — эталон времени, он всегда идёт с обычной скоростью.
                if self.is_host() {
                    self.reset_speed();
                }
            }
            ServerMsg::Playback { playback, .. } => {
                // Новое видео — субтитры прошлого больше не нужны (сервер их тоже сбросил).
                if playback.media != self.room_media() {
                    self.subtitles = None;
                }
                // Глава сам источник истины: свои же сообщения, вернувшиеся
                // от сервера, он игнорирует (они уже чуть устарели).
                if self.is_host() && self.room_media() == playback.media {
                    return;
                }
                self.set_room(playback.clone()).await;
            }
            ServerMsg::Kicked { .. } => self.disconnected(),
            ServerMsg::Chat { name, text, .. } => self.push_overlay(name, text),
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
            // Ведущий закрыл видео — закрываем и у себя.
            if self.loaded.take().is_some() {
                if let Some(player) = &self.player {
                    player.stop();
                }
                crate::logs::info("видео закрыто");
                self.emit_status();
            }
            return;
        };
        if self.loaded.as_deref() == Some(media.as_str()) {
            return;
        }
        if let Some(player) = &self.player {
            player.set_pause(true);
        }
        if is_url(&media) && !self.is_host() {
            let opened = match self.ensure_player().await {
                Ok(()) => self.load_media(&media).await,
                Err(e) => Err(e),
            };
            if let Err(e) = opened {
                crate::logs::error(format!("не открылось видео комнаты: {e}"));
                let _ = self.app.emit("player-error", e);
            }
            // Даже если не открылось, второй раз сами не пробуем —
            // можно открыть ссылку заново вручную.
            self.loaded = Some(media);
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
        let Some(position) = player.time_pos().await else {
            return;
        };
        let expected = room.expected_position();
        // > 0 — мы впереди ведущего, < 0 — отстаём.
        let drift = position - expected;

        let (seek, speed) = catch_up(drift, room.state.paused, self.speed);
        if seek {
            player.seek(expected);
            self.last_seek = Some(Instant::now());
        }
        if (speed - self.speed).abs() > f64::EPSILON {
            player.set_speed(speed);
            self.speed = speed;
        }
    }

    /// Вернуть обычную скорость (новый файл, стали ведущим и т.п.).
    fn reset_speed(&mut self) {
        if (self.speed - 1.0).abs() > f64::EPSILON {
            if let Some(player) = &self.player {
                player.set_speed(1.0);
            }
            self.speed = 1.0;
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
                crate::logs::info("плеер закрылся");
                self.player = None;
                self.loaded = None;
                self.emit_status();
                self.emit_tracks().await;
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
            PlayerEvent::TracksChanged => self.emit_tracks().await,
            PlayerEvent::LoadFailed => {
                crate::logs::warn(format!(
                    "плеер не смог открыть {} — подробности в журнале mpv",
                    self.loaded.as_deref().unwrap_or("видео")
                ));
                // Один раз пробуем ещё — молча, без ошибки на экране.
                if let Some(url) = self.loaded.clone() {
                    if is_url(&url) && self.retried.as_deref() != Some(url.as_str()) {
                        self.retried = Some(url.clone());
                        crate::logs::info("пробую открыть ещё раз");
                        if self.load_media(&url).await.is_ok() {
                            return;
                        }
                    }
                }
                self.load_failed_at = Some(Instant::now());
            }
            PlayerEvent::Key(key) => {
                let _ = self.app.emit("player-key", key);
            }
            PlayerEvent::FileLoaded if self.reloading => {
                self.load_failed_at = None;
                self.reloading = false;
                if let Some(player) = &self.player {
                    player.clear_start();
                }
                if self.is_host() {
                    // Пока ссылка перезагружалась, общий фильм шёл дальше —
                    // догоняем комнату, а не откатываем всех назад.
                    if let (Some(player), Some(room)) = (&self.player, &self.room) {
                        player.seek(room.expected_position());
                    }
                    self.last_seek = Some(Instant::now());
                } else {
                    self.last_seek = None;
                    self.apply().await;
                }
            }
            PlayerEvent::FileLoaded => {
                crate::logs::info("видео загрузилось");
                self.apply_subtitles();
                self.emit_cover().await;
                // Ведущий запустит видео, когда оно откроется у всех.
                if let Some(media) = self.loaded.clone() {
                    self.send(ClientMsg::Loaded { media });
                }
                self.load_failed_at = None;
                self.reset_speed();
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
        // Сразу после перезагрузки в другом качестве — это не перемотка ведущего.
        if self
            .last_seek
            .is_some_and(|t| t.elapsed() < Duration::from_millis(1500))
        {
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

    // ---------- Чат поверх видео ----------

    pub fn set_overlay_enabled(&mut self, enabled: bool) {
        self.overlay_enabled = enabled;
        self.overlay.clear();
        self.render_overlay();
    }

    fn push_overlay(&mut self, name: &str, text: &str) {
        if !self.overlay_enabled {
            return;
        }
        // Стикер поверх видео не нарисовать — показываем подпись.
        let text = if text.starts_with("[[sticker:") && text.ends_with("]]") {
            "отправил стикер"
        } else {
            text
        };
        self.overlay
            .push_back((Instant::now(), name.to_string(), text.to_string()));
        while self.overlay.len() > OVERLAY_LINES {
            self.overlay.pop_front();
        }
        self.render_overlay();
    }

    /// Кадр анимации: убрать истёкшие сообщения и перерисовать остальные
    /// с нужной прозрачностью.
    fn animate_overlay(&mut self) {
        if self.overlay.is_empty() {
            return;
        }
        self.overlay.retain(|(at, _, _)| at.elapsed() < OVERLAY_TTL);
        self.render_overlay();
    }

    fn render_overlay(&self) {
        let Some(player) = &self.player else {
            return;
        };
        if self.overlay.is_empty() {
            player.set_overlay("");
            return;
        }
        // ASS-разметка: левый нижний угол, ник янтарным, текст белым.
        // Цвета в ASS пишутся как BGR: f2c879 → 79C8F2.
        let lines: Vec<String> = self
            .overlay
            .iter()
            .map(|(at, name, text)| {
                format!(
                    "{{\\alpha&H{:02X}&\\c&H79C8F2&\\fnSegoe UI Semibold}}{}{{\\c&HFFFFFF&\\fnSegoe UI}}  {}",
                    overlay_alpha(at.elapsed().as_secs_f64()),
                    ass_escape(name),
                    ass_escape(text)
                )
            })
            .collect();
        // Левый нижний угол, мягкая тёмная обводка вместо подложки.
        let ass = format!(
            "{{\\an1\\pos(32,672)\\fnSegoe UI Semibold\\fs26\\bord2\\3c&H101010&\\blur1.2\\shad0}}{}",
            lines.join("\\N")
        );
        player.set_overlay(&ass);
    }

    /// Сообщить об ошибке загрузки, если видео так и не открылось.
    async fn report_load_failure(&mut self) {
        let Some(at) = self.load_failed_at else {
            return;
        };
        if at.elapsed() < Duration::from_millis(2500) {
            return;
        }
        self.load_failed_at = None;
        // Что-то всё-таки играет — значит, ошибка была промежуточной.
        if let Some(player) = &self.player {
            if player.get_f64("duration").await.is_some() {
                return;
            }
        }
        let what = match self.loaded.as_deref() {
            Some(m) if is_url(m) => {
                "Не удалось открыть ссылку: сайт не поддерживается, \
                 видео защищено от копирования или недоступно"
            }
            _ => "Не удалось открыть файл: формат не поддерживается или файл повреждён",
        };
        let _ = self.app.emit("player-error", what);
    }

    // ---------- Панель управления ----------

    /// Выбрать качество ссылок. Если сейчас открыта ссылка — перезапустить
    /// её в новом качестве с того же места.
    pub async fn set_quality(&mut self, quality: Option<u32>) {
        if self.quality == quality {
            return;
        }
        self.quality = quality;
        let Some(player) = &self.player else {
            return;
        };
        // Сайты из `sites`: качество выбираем сами — берём другой поток.
        if let Some(media) = self.loaded.clone().filter(|m| crate::sites::handles(m)) {
            let position = player.time_pos().await;
            match crate::sites::resolve(&media, quality).await {
                Ok(stream) => {
                    player.load_at(&stream, position);
                    self.reloading = true;
                }
                Err(e) => {
                    crate::logs::error(format!("не удалось сменить качество: {e}"));
                    let _ = self.app.emit("player-error", e);
                }
            }
            return;
        }
        if !self.loaded.as_deref().is_some_and(is_url) {
            // Новое качество подхватится при следующей ссылке.
            player.command(serde_json::json!([
                "set_property",
                "ytdl-format",
                crate::player::ytdl_format(quality)
            ]));
            return;
        }
        let position = player.time_pos().await;
        player.reload_with_quality(quality, position);
        self.reloading = true;
    }

    /// Отправить интерфейсу список дорожек.
    async fn emit_tracks(&self) {
        let tracks: Vec<Track> = match &self.player {
            Some(player) => player
                .get("track-list")
                .await
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(Track::from_mpv)
                .collect(),
            None => Vec::new(),
        };
        let _ = self.app.emit("player-tracks", tracks);
    }

    pub fn control(&mut self, control: Control) -> Result<(), String> {
        let Some(player) = &self.player else {
            return Ok(());
        };
        // Громкость и дорожки у каждого свои, а паузой и перемоткой
        // управляет глава. Его действия попадут в mpv, а оттуда — на сервер.
        let shared = matches!(
            control,
            Control::TogglePause | Control::Play | Control::Seek { .. } | Control::SeekBy { .. }
        );
        if shared && !self.is_host() {
            return Err("Паузой и перемоткой управляет ведущий".into());
        }
        match control {
            Control::TogglePause => player.set_pause(!self.player_paused),
            Control::Play => player.set_pause(false),
            Control::Seek { position } => player.seek(position.max(0.0)),
            Control::SeekBy { delta } => player.seek_by(delta),
            Control::Volume { value } => player.set_volume(value),
            Control::SetAudio { id } => player.set_track("aid", id),
            Control::SetSubtitle { id } => player.set_track("sid", id),
            Control::AddSubtitle { path } => player.add_subtitle(&path),
        }
        Ok(())
    }

    /// Раз в [`SYNC_INTERVAL`]: глава сообщает позицию, остальные сверяются.
    async fn tick(&mut self) {
        self.report_load_failure().await;
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

    /// Открыть ссылку в плеере. Ссылки с сайтов, которые yt-dlp не знает
    /// (см. [`crate::sites`]), сначала превращаем в прямую ссылку на поток.
    async fn load_media(&self, url: &str) -> Result<(), String> {
        crate::logs::info(format!("открываю ссылку: {url}"));
        let _ = self.app.emit("player-cover", None::<Cover>);
        let target = if crate::sites::handles(url) {
            crate::sites::resolve(url, self.quality)
                .await
                .inspect_err(|e| crate::logs::error(format!("не удалось разобрать ссылку: {e}")))?
        } else {
            url.to_string()
        };
        if let Some(player) = &self.player {
            player.load(&target);
        }
        Ok(())
    }

    /// Подключить раздачу ведущего к открытому видео.
    fn apply_subtitles(&self) {
        let (Some(player), Some(file)) = (&self.player, &self.subtitles) else {
            return;
        };
        match write_subtitles(file) {
            Ok(path) => {
                crate::logs::info(format!("субтитры для всех: {}", file.name));
                player.add_subtitle(&path.to_string_lossy());
            }
            Err(e) => crate::logs::warn(format!("не получилось подключить субтитры: {e}")),
        }
    }

    /// Нет картинки (музыка с SoundCloud и т.п.) — показываем обложку из
    /// того, что отдал yt-dlp. Есть картинка — обложка не нужна.
    async fn emit_cover(&self) {
        let Some(player) = &self.player else {
            return;
        };
        let has_video = player.get("current-tracks/video").await.is_some();
        if has_video {
            let _ = self.app.emit("player-cover", None::<Cover>);
            return;
        }
        let info = player
            .get("user-data/mpv/ytdl/json-subprocess-result")
            .await
            .and_then(ytdl_info);
        let text = |key: &str| {
            info.as_ref()
                .and_then(|i| i.get(key))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let image = text("thumbnail").or_else(|| {
            info.as_ref()
                .and_then(|i| i.get("thumbnails"))
                .and_then(Value::as_array)
                .and_then(|list| list.last())
                .and_then(|t| t.get("url"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        let title = text("track").or_else(|| text("title")).or(player
            .get("media-title")
            .await
            .and_then(|v| v.as_str().map(str::to_string)));
        let artist = text("artist").or_else(|| text("uploader")).or_else(|| text("channel"));
        let _ = self.app.emit("player-cover", Some(Cover { image, title, artist }));
    }

    /// Раздать субтитры всем (только ведущий).
    pub fn share_subtitles(&self, file: Option<SubtitleFile>) -> Result<(), String> {
        if !self.is_host() {
            return Err("Субтитры для всех добавляет тот, у кого пульт".into());
        }
        if self.room_media().is_none() {
            return Err("Сначала включи видео".into());
        }
        self.send(ClientMsg::SetSubtitles { subtitles: file });
        Ok(())
    }

    // ---------- Действия из интерфейса ----------

    /// Ведущий закрывает видео у всех.
    pub fn close_media(&mut self) -> Result<(), String> {
        if !self.is_host() {
            return Err("Закрыть видео может только ведущий".into());
        }
        self.send(ClientMsg::ClearMedia);
        self.room = Some(RoomPlayback::new(PlaybackState {
            media: None,
            paused: true,
            position: 0.0,
        }));
        if self.loaded.take().is_some() {
            if let Some(player) = &self.player {
                player.stop();
            }
        }
        crate::logs::info("ведущий закрыл видео");
        self.emit_status();
        Ok(())
    }

    pub async fn open_file(&mut self, path: String) -> Result<(), String> {
        let host = self.is_host();
        let room_media = self.room_media();
        if !host && !room_media.as_deref().is_some_and(|m| !is_url(m)) {
            return Err("Ведущий ещё не выбрал файл".into());
        }

        self.ensure_player().await?;
        crate::logs::info(format!("открываю файл: {path}"));
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
                return Err("Выбирать, что смотрим, может только ведущий".into());
            }
            self.ensure_player().await?;
            self.load_media(&url).await?;
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
        }
        // Если ссылку не разобрать, комнате её не отправляем.
        self.load_media(&url).await?;
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

/// Расхождение, после которого догоняем перемоткой, а не скоростью.
const SEEK_DRIFT: f64 = 3.0;
/// Расхождение, с которого начинаем подгонять скорость.
const NUDGE_START: f64 = 0.25;
/// Расхождение, при котором возвращаем обычную скорость.
const NUDGE_DONE: f64 = 0.06;
/// На сколько ускоряемся/замедляемся: 5 % на слух почти незаметно
/// (mpv сохраняет высоту звука).
const NUDGE: f64 = 0.05;

/// Как догнать ведущего: `(перемотать?, скорость)`.
///
/// Большое расхождение — перемотка. Небольшое — плавно: чуть быстрее, если
/// отстаём, чуть медленнее, если убежали вперёд, пока не сравняемся.
fn catch_up(drift: f64, paused: bool, current_speed: f64) -> (bool, f64) {
    if paused {
        return (drift.abs() > TOLERANCE, 1.0);
    }
    if drift.abs() > SEEK_DRIFT {
        return (true, 1.0);
    }
    let speed = if drift < -NUDGE_START {
        1.0 + NUDGE
    } else if drift > NUDGE_START {
        1.0 - NUDGE
    } else if drift.abs() < NUDGE_DONE {
        1.0
    } else {
        current_speed // почти догнали — продолжаем как шли
    };
    (false, speed)
}

/// Прозрачность сообщения по его возрасту: 0x00 — видно, 0xFF — нет.
fn overlay_alpha(age: f64) -> u8 {
    let ttl = OVERLAY_TTL.as_secs_f64();
    let visibility = if age < OVERLAY_FADE_IN {
        age / OVERLAY_FADE_IN
    } else if age > ttl - OVERLAY_FADE_OUT {
        (ttl - age) / OVERLAY_FADE_OUT
    } else {
        1.0
    };
    // Плавнее на глаз, чем линейно.
    let eased = visibility.clamp(0.0, 1.0).powf(1.6);
    (255.0 * (1.0 - eased)).round() as u8
}

/// Убрать из текста символы, которые ASS понимает как разметку.
fn ass_escape(text: &str) -> String {
    text.replace('\\', "/")
        .replace('{', "(")
        .replace('}', ")")
        .replace('\n', " ")
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

#[tauri::command]
pub async fn set_chat_overlay(
    session: State<'_, SharedSession>,
    enabled: bool,
) -> Result<(), String> {
    session.lock().await.set_overlay_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub async fn player_info(session: State<'_, SharedSession>) -> Result<PlaybackInfo, String> {
    // Сессию держим только чтобы взять плеер, а ответы mpv ждём уже без неё
    // и все сразу: этот опрос идёт 2–3 раза в секунду из каждого окна.
    let (probe, paused) = {
        let s = session.lock().await;
        (s.player.as_ref().map(|p| p.probe()), s.player_paused)
    };
    let Some(p) = probe else {
        return Ok(PlaybackInfo {
            position: None,
            duration: None,
            paused: true,
            volume: None,
            title: None,
            ended: false,
        });
    };
    let (position, duration, volume, title, ended) = tokio::join!(
        p.get_f64("time-pos"),
        p.get_f64("duration"),
        p.get_f64("volume"),
        p.get("media-title"),
        p.get("eof-reached"),
    );
    Ok(PlaybackInfo {
        position,
        duration,
        paused,
        volume,
        title: title.and_then(|v| v.as_str().map(str::to_string)),
        ended: ended.and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

#[tauri::command]
pub async fn close_media(session: State<'_, SharedSession>) -> Result<(), String> {
    session.lock().await.close_media()
}

#[tauri::command]
pub async fn player_control(
    session: State<'_, SharedSession>,
    control: Control,
) -> Result<(), String> {
    session.lock().await.control(control)
}

/// Курсор над видео: прячем, пока в полном экране скрыта панель.
#[tauri::command]
pub async fn player_cursor(session: State<'_, SharedSession>, hidden: bool) -> Result<(), String> {
    if let Some(player) = session.lock().await.player.as_ref() {
        let mode = if hidden { "always" } else { "1000" };
        player.command(serde_json::json!(["set_property", "cursor-autohide", mode]));
    }
    Ok(())
}

/// Субтитры для всех из файла (`path`) или по ссылке (`url`).
#[tauri::command]
pub async fn subtitles_share(
    session: State<'_, SharedSession>,
    path: Option<String>,
    url: Option<String>,
) -> Result<String, String> {
    let (name, bytes) = if let Some(path) = path {
        let name = Path::new(&path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "subtitles.srt".into());
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|e| format!("Не получилось прочитать файл: {e}"))?;
        (name, bytes)
    } else if let Some(url) = url {
        download_subtitles(url.trim()).await?
    } else {
        return Err("Выбери файл или вставь ссылку".into());
    };
    let file = subtitle_file(name, &bytes)?;
    let name = file.name.clone();
    session.lock().await.share_subtitles(Some(file))?;
    Ok(name)
}

/// Убрать субтитры у всех.
#[tauri::command]
pub async fn subtitles_clear(session: State<'_, SharedSession>) -> Result<(), String> {
    session.lock().await.share_subtitles(None)
}

#[tauri::command]
pub async fn set_quality(
    session: State<'_, SharedSession>,
    height: Option<u32>,
) -> Result<(), String> {
    session.lock().await.set_quality(height).await;
    Ok(())
}

// ---------- Субтитры ----------

/// Данные yt-dlp, которые сохранил ytdl_hook mpv: `{"stdout": "<json>"}`.
fn ytdl_info(v: Value) -> Option<Value> {
    let v = match v {
        Value::String(s) => serde_json::from_str(&s).ok()?,
        v => v,
    };
    let stdout = v.get("stdout")?.as_str()?;
    serde_json::from_str(stdout).ok()
}

async fn download_subtitles(url: &str) -> Result<(String, Vec<u8>), String> {
    if !is_url(url) {
        return Err("Ссылка должна начинаться с http:// или https://".into());
    }
    let mut response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Не получилось скачать субтитры: {e}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Загрузка прервалась: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_SUBTITLES_BYTES * 2 {
            return Err("Файл по ссылке слишком большой для субтитров".into());
        }
    }
    let name = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_string)))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "subtitles.srt".into());
    Ok((name, bytes))
}

/// Проверить файл и перевести текст в UTF-8 (русские .srt часто в Windows-1251).
fn subtitle_file(name: String, bytes: &[u8]) -> Result<SubtitleFile, String> {
    if bytes.starts_with(b"PK") || bytes.starts_with(b"Rar!") || bytes.starts_with(&[0x37, 0x7A]) {
        return Err("Это архив — распакуй его и выбери файл .srt".into());
    }
    let text = decode_text(bytes);
    if text.trim().is_empty() {
        return Err("Файл субтитров пустой".into());
    }
    if text.trim_start().starts_with("<!DOCTYPE") || text.trim_start().starts_with("<html") {
        return Err("По ссылке веб-страница, а не файл субтитров — нужна прямая ссылка на .srt".into());
    }
    if text.len() > MAX_SUBTITLES_BYTES {
        return Err("Файл субтитров слишком большой".into());
    }
    let lower = name.to_ascii_lowercase();
    let known = [".srt", ".vtt", ".ass", ".ssa"].iter().any(|e| lower.ends_with(e));
    let name = if known {
        name
    } else if text.trim_start().starts_with("WEBVTT") {
        format!("{name}.vtt")
    } else if text.contains("[Script Info]") {
        format!("{name}.ass")
    } else {
        format!("{name}.srt")
    };
    Ok(SubtitleFile { name, text })
}

fn decode_text(bytes: &[u8]) -> String {
    if let Some((encoding, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding.decode_without_bom_handling(&bytes[bom..]).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => encoding_rs::WINDOWS_1251.decode(bytes).0.into_owned(),
    }
}

/// Записать раздачу во временную папку — mpv подключает субтитры из файла.
fn write_subtitles(file: &SubtitleFile) -> std::io::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join("brotherhub-subtitles");
    std::fs::create_dir_all(&dir)?;
    let safe: String = file
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() || ".-_ ".contains(c) { c } else { '_' })
        .collect();
    let path = dir.join(safe);
    std::fs::write(&path, file.text.as_bytes())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtitles_are_decoded_and_named() {
        let cp1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]; // «Привет»
        let f = subtitle_file("film".into(), &cp1251).unwrap();
        assert_eq!(f.text, "Привет");
        assert_eq!(f.name, "film.srt");
        let bom = [&[0xef, 0xbb, 0xbf][..], "WEBVTT\n".as_bytes()].concat();
        let f = subtitle_file("x".into(), &bom).unwrap();
        assert_eq!(f.name, "x.vtt");
        assert!(subtitle_file("a.zip".into(), b"PK\x03\x04").is_err());
    }

    #[test]
    fn small_lag_is_caught_up_by_speed_not_seek() {
        assert_eq!(catch_up(-1.0, false, 1.0), (false, 1.0 + NUDGE));
        assert_eq!(catch_up(1.0, false, 1.0), (false, 1.0 - NUDGE));
    }

    #[test]
    fn big_lag_is_fixed_by_seek() {
        assert_eq!(catch_up(-10.0, false, 1.0 + NUDGE), (true, 1.0));
    }

    #[test]
    fn speed_returns_to_normal_when_in_sync() {
        assert_eq!(catch_up(0.01, false, 1.0 + NUDGE), (false, 1.0));
        // Между «начать» и «закончить» — продолжаем догонять.
        assert_eq!(catch_up(-0.1, false, 1.0 + NUDGE), (false, 1.0 + NUDGE));
        assert_eq!(catch_up(-0.1, false, 1.0), (false, 1.0));
    }

    #[test]
    fn on_pause_only_seek_when_far() {
        assert_eq!(catch_up(-0.3, true, 1.0 + NUDGE), (false, 1.0));
        assert_eq!(catch_up(-2.0, true, 1.0), (true, 1.0));
    }

    #[test]
    fn chat_overlay_fades_in_and_out() {
        assert_eq!(overlay_alpha(0.0), 0xFF);
        assert_eq!(overlay_alpha(2.0), 0x00);
        let ttl = OVERLAY_TTL.as_secs_f64();
        assert_eq!(overlay_alpha(ttl), 0xFF);
        assert!(overlay_alpha(ttl - 0.5) > 0x00);
    }

    #[test]
    fn ass_markup_is_escaped() {
        assert_eq!(ass_escape("{\\b1}жирный\nтекст"), "(/b1)жирный текст");
    }
}
