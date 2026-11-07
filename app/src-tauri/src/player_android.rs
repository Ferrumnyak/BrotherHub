//! Плеер на Android.
//!
//! На компьютере видео показывает mpv, а мы говорим с ним строками JSON IPC
//! (player.rs). На телефоне mpv нет — видео показывает ExoPlayer из
//! Kotlin-части приложения (`PlayerPlugin.kt`), а ссылки разбирает
//! yt-dlp, встроенный в APK (youtubedl-android).
//!
//! Чтобы не переписывать всю синхронизацию (session.rs), Kotlin-плеер
//! понимает те же строки, что и mpv: `loadfile`, `seek`, `set_property`,
//! `get_property`, — и присылает те же события (`property-change`,
//! `file-loaded`, `playback-restart`, `end-file`). Здесь только доставка
//! строк: команды уходят вызовом `send`, ответы и события забираются
//! долгим опросом `poll`.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Wry,
};
use tokio::sync::{mpsc, oneshot, Mutex};

/// Что произошло в плеере.
#[derive(Debug, Clone, Copy)]
pub enum PlayerEvent {
    /// Изменилось свойство `pause`.
    Pause(bool),
    /// Воспроизведение (пере)запустилось — после перемотки или загрузки файла.
    Restart,
    /// Файл загружен.
    FileLoaded,
    /// Файл или ссылку не удалось открыть.
    LoadFailed,
    /// Изменился список дорожек.
    TracksChanged,
    /// Клавиша (на телефоне не бывает, оставлено для общего кода).
    #[allow(dead_code)]
    Key(PlayerKey),
    /// Плеер закрылся.
    Shutdown,
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum PlayerKey {
    Fullscreen,
    ExitFullscreen,
    ToggleChat,
}

/// Событие с номером плеера, от которого оно пришло.
pub type PlayerEventMsg = (u64, PlayerEvent);

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

static NEXT_PLAYER_ID: AtomicU64 = AtomicU64::new(1);
static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

/// Kotlin-часть плеера (класс `com.ferrumnyak.brotherwatch.PlayerPlugin`).
pub fn plugin() -> TauriPlugin<Wry> {
    Builder::<Wry>::new("bhplayer")
        .setup(|_app, api| {
            let handle = api.register_android_plugin("com.ferrumnyak.brotherwatch", "PlayerPlugin")?;
            let _ = HANDLE.set(handle);
            Ok(())
        })
        .build()
}

/// Вызвать команду Kotlin-плеера.
pub async fn call(command: &str, payload: Value) -> Result<Value, String> {
    let handle = HANDLE.get().ok_or("плеер Android не подключился")?;
    handle
        .run_mobile_plugin_async::<Value>(command, payload)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct Polled {
    #[serde(default)]
    lines: Vec<String>,
    #[serde(default = "yes")]
    alive: bool,
}

fn yes() -> bool {
    true
}

pub struct Player {
    pub id: u64,
    write_tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_request: Arc<AtomicU64>,
}

/// Чтение свойств без самого плеера (как на компьютере, см. player.rs).
#[derive(Clone)]
pub struct Probe {
    write_tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_request: Arc<AtomicU64>,
}

impl Probe {
    pub async fn get(&self, property: &str) -> Option<Value> {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let line = json!({ "command": ["get_property", property], "request_id": id }).to_string();
        let _ = self.write_tx.send(line);

        let reply = match tokio::time::timeout(Duration::from_secs(2), rx).await {
            Ok(Ok(v)) => v,
            _ => {
                self.pending.lock().await.remove(&id);
                return None;
            }
        };
        if reply.get("error").and_then(Value::as_str) != Some("success") {
            return None;
        }
        reply.get("data").cloned()
    }

    pub async fn get_f64(&self, property: &str) -> Option<f64> {
        self.get(property).await.and_then(|v| v.as_f64())
    }
}

impl Player {
    /// Запустить плеер. `wid` на телефоне не нужен: картинка всегда
    /// под интерфейсом, в прямоугольнике из `set_video_rect`.
    pub async fn spawn(
        events: mpsc::UnboundedSender<PlayerEventMsg>,
        _wid: Option<isize>,
        quality: Option<u32>,
    ) -> Result<Self, String> {
        let id = NEXT_PLAYER_ID.fetch_add(1, Ordering::Relaxed);
        call("start", json!({ "player": id, "format": ytdl_format(quality) }))
            .await
            .map_err(|e| {
                let msg = format!("не удалось запустить плеер: {e}");
                crate::logs::error(&msg);
                msg
            })?;
        crate::logs::info(format!("запускаю плеер #{id} (Android)"));

        // Команды: копим то, что пришло подряд, и отправляем одним вызовом.
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<String>();
        tauri::async_runtime::spawn(async move {
            while let Some(first) = write_rx.recv().await {
                let mut lines = vec![first];
                while let Ok(more) = write_rx.try_recv() {
                    lines.push(more);
                }
                if let Err(e) = call("send", json!({ "player": id, "lines": lines })).await {
                    crate::logs::warn(format!("плеер не принял команду: {e}"));
                }
            }
        });

        // Ответы и события — долгим опросом.
        let pending: Pending = Arc::default();
        let pending_reader = pending.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let polled = match call("poll", json!({ "player": id })).await {
                    Ok(v) => serde_json::from_value::<Polled>(v).unwrap_or(Polled {
                        lines: Vec::new(),
                        alive: true,
                    }),
                    Err(e) => {
                        crate::logs::warn(format!("плеер не отвечает: {e}"));
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        continue;
                    }
                };
                for line in polled.lines {
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(event) = v.get("event").and_then(Value::as_str) {
                        if let Some(ev) = parse_event(event, &v) {
                            let _ = events.send((id, ev));
                        }
                    } else if let Some(req) = v.get("request_id").and_then(Value::as_u64) {
                        if let Some(tx) = pending_reader.lock().await.remove(&req) {
                            let _ = tx.send(v);
                        }
                    }
                }
                if !polled.alive {
                    break;
                }
            }
            let _ = events.send((id, PlayerEvent::Shutdown));
        });

        Ok(Self {
            id,
            write_tx,
            pending,
            next_request: Arc::new(AtomicU64::new(1)),
        })
    }

    fn send_line(&self, request_id: u64, args: Value) {
        let line = json!({ "command": args, "request_id": request_id }).to_string();
        let _ = self.write_tx.send(line);
    }

    /// Отправить команду, не дожидаясь ответа.
    pub fn command(&self, args: Value) {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        self.send_line(id, args);
    }

    pub fn probe(&self) -> Probe {
        Probe {
            write_tx: self.write_tx.clone(),
            pending: self.pending.clone(),
            next_request: self.next_request.clone(),
        }
    }

    pub async fn get(&self, property: &str) -> Option<Value> {
        self.probe().get(property).await
    }

    pub fn load(&self, path_or_url: &str) {
        self.command(json!(["set_property", "force-media-title", ""]));
        self.command(json!(["loadfile", path_or_url, "replace"]));
    }

    /// Заранее разобранные ссылки на телефоне не используются (prefetch.rs).
    pub fn load_ready(&self, ready: &crate::prefetch::Ready) {
        self.command(json!(["set_property", "force-media-title", ready.title.clone().unwrap_or_default()]));
        self.command(json!(["loadfile", ready.open, "replace"]));
    }

    pub fn load_at(&self, url: &str, at: Option<f64>) {
        if let Some(at) = at {
            self.command(json!(["set_property", "start", format!("{at:.2}")]));
        }
        self.load(url);
    }

    pub fn stop(&self) {
        self.command(json!(["stop"]));
    }

    pub fn set_pause(&self, paused: bool) {
        self.command(json!(["set_property", "pause", paused]));
    }

    pub fn seek(&self, position: f64) {
        self.command(json!(["seek", position, "absolute"]));
    }

    /// Чат поверх видео на телефоне рисует сам интерфейс.
    pub fn set_overlay(&self, _ass: &str) {}

    pub fn seek_by(&self, delta: f64) {
        self.command(json!(["seek", delta, "relative"]));
    }

    pub fn set_track(&self, kind: &str, id: Option<i64>) {
        match id {
            Some(id) => self.command(json!(["set_property", kind, id])),
            None => self.command(json!(["set_property", kind, "no"])),
        }
    }

    pub fn add_subtitle(&self, path: &str) {
        self.command(json!(["sub-add", path, "select"]));
    }

    pub fn set_speed(&self, speed: f64) {
        self.command(json!(["set_property", "speed", speed]));
    }

    pub fn set_volume(&self, volume: f64) {
        self.command(json!(["set_property", "volume", volume.clamp(0.0, 130.0)]));
    }

    pub async fn get_f64(&self, property: &str) -> Option<f64> {
        self.get(property).await.and_then(|v| v.as_f64())
    }

    pub fn reload_with_quality(&self, quality: Option<u32>, resume_at: Option<f64>) {
        self.command(json!(["set_property", "ytdl-format", ytdl_format(quality)]));
        if let Some(at) = resume_at {
            self.command(json!(["set_property", "start", format!("{at:.2}")]));
        }
        self.command(json!(["playlist-play-index", "current"]));
    }

    pub fn clear_start(&self) {
        self.command(json!(["set_property", "start", "none"]));
    }

    pub async fn time_pos(&self) -> Option<f64> {
        self.get("time-pos").await.and_then(|v| v.as_f64())
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.command(json!(["quit"]));
    }
}

fn parse_event(event: &str, v: &Value) -> Option<PlayerEvent> {
    let name = v.get("name").and_then(Value::as_str);
    match event {
        "property-change" if name == Some("pause") => {
            v.get("data").and_then(Value::as_bool).map(PlayerEvent::Pause)
        }
        "property-change" if name == Some("track-list") => Some(PlayerEvent::TracksChanged),
        "playback-restart" => Some(PlayerEvent::Restart),
        "file-loaded" => Some(PlayerEvent::FileLoaded),
        "end-file" if v.get("reason").and_then(Value::as_str) == Some("error") => {
            Some(PlayerEvent::LoadFailed)
        }
        _ => None,
    }
}

/// Формат для yt-dlp — тот же, что на компьютере (см. player.rs).
/// На телефоне по умолчанию до 720p: экран маленький, а трафик мобильный.
pub fn ytdl_format(quality: Option<u32>) -> String {
    let h = quality.unwrap_or(720);
    format!(
        "bestvideo[height<=?{h}][vcodec!^=av01]+bestaudio/\
         bestvideo[height<=?{h}]+bestaudio/best[height<=?{h}]/best/bestaudio"
    )
}

/// Отдельного yt-dlp на телефоне нет: он внутри Kotlin-части.
pub fn find_ytdlp() -> Option<String> {
    None
}
