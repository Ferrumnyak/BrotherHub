//! Управление плеером mpv.
//!
//! mpv запускается отдельным процессом и управляется через JSON IPC:
//! на Windows это именованный канал (named pipe), на Linux — unix-сокет.
//! Протокол: https://mpv.io/manual/stable/#json-ipc
//!
//! Где искать mpv и yt-dlp — см. [`find_mpv`] и [`find_ytdlp`].

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, Mutex},
};

/// Что произошло в плеере.
#[derive(Debug, Clone, Copy)]
pub enum PlayerEvent {
    /// Изменилось свойство `pause`.
    Pause(bool),
    /// Воспроизведение (пере)запустилось — после перемотки или загрузки файла.
    Restart,
    /// Файл загружен.
    FileLoaded,
    /// Окно mpv закрыли или процесс завершился.
    Shutdown,
}

/// Событие с номером плеера, от которого оно пришло.
pub type PlayerEventMsg = (u64, PlayerEvent);

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

static NEXT_PLAYER_ID: AtomicU64 = AtomicU64::new(1);

pub struct Player {
    pub id: u64,
    write_tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_request: AtomicU64,
    _child: Child,
}

impl Player {
    pub async fn spawn(events: mpsc::UnboundedSender<PlayerEventMsg>) -> Result<Self, String> {
        let id = NEXT_PLAYER_ID.fetch_add(1, Ordering::Relaxed);
        let ipc = ipc_path(id);
        let mpv = find_mpv();

        let mut cmd = Command::new(&mpv);
        cmd.args([
            "--idle=yes",
            "--force-window=yes",
            "--keep-open=yes",
            "--pause=yes",
            "--title=BrotherWatch",
            "--no-terminal",
            "--ytdl-format=bestvideo[height<=?1080]+bestaudio/best",
        ])
        .arg(format!("--input-ipc-server={ipc}"))
        .kill_on_drop(true);
        if let Some(ytdlp) = find_ytdlp() {
            cmd.arg(format!("--script-opts=ytdl_hook-ytdl_path={ytdlp}"));
        }
        // Не показывать чёрное консольное окно рядом с плеером.
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "не удалось запустить mpv ({mpv}): {e}. \
                     Установи mpv и проверь, что команда `mpv --version` работает в терминале."
            )
        })?;

        let stream = connect_ipc(&ipc, &mut child).await?;
        let (read, mut write) = tokio::io::split(stream);

        // Запись команд в mpv.
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<String>();
        tauri::async_runtime::spawn(async move {
            while let Some(line) = write_rx.recv().await {
                if write.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        // Чтение ответов и событий из mpv.
        let pending: Pending = Arc::default();
        let pending_reader = pending.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(event) = v.get("event").and_then(Value::as_str) {
                    let ev = match event {
                        "property-change"
                            if v.get("name").and_then(Value::as_str) == Some("pause") =>
                        {
                            v.get("data")
                                .and_then(Value::as_bool)
                                .map(PlayerEvent::Pause)
                        }
                        "playback-restart" => Some(PlayerEvent::Restart),
                        "file-loaded" => Some(PlayerEvent::FileLoaded),
                        _ => None,
                    };
                    if let Some(ev) = ev {
                        let _ = events.send((id, ev));
                    }
                } else if let Some(req) = v.get("request_id").and_then(Value::as_u64) {
                    if let Some(tx) = pending_reader.lock().await.remove(&req) {
                        let _ = tx.send(v);
                    }
                }
            }
            let _ = events.send((id, PlayerEvent::Shutdown));
        });

        let player = Self {
            id,
            write_tx,
            pending,
            next_request: AtomicU64::new(1),
            _child: child,
        };
        player.command(json!(["observe_property", 1, "pause"]));
        Ok(player)
    }

    fn send_line(&self, request_id: u64, args: Value) {
        let mut line = json!({ "command": args, "request_id": request_id }).to_string();
        line.push('\n');
        let _ = self.write_tx.send(line);
    }

    /// Отправить команду, не дожидаясь ответа.
    pub fn command(&self, args: Value) {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        self.send_line(id, args);
    }

    /// Прочитать свойство mpv.
    pub async fn get(&self, property: &str) -> Option<Value> {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.send_line(id, json!(["get_property", property]));

        let reply = tokio::time::timeout(Duration::from_secs(2), rx).await;
        let reply = match reply {
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

    pub fn load(&self, path_or_url: &str) {
        self.command(json!(["loadfile", path_or_url, "replace"]));
    }

    pub fn set_pause(&self, paused: bool) {
        self.command(json!(["set_property", "pause", paused]));
    }

    pub fn seek(&self, position: f64) {
        self.command(json!(["seek", position, "absolute"]));
    }

    /// Текущая позиция в секундах (если файл загружен).
    pub async fn time_pos(&self) -> Option<f64> {
        self.get("time-pos").await.and_then(|v| v.as_f64())
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // Вежливо закрыть mpv; если не успеет — процесс убьётся kill_on_drop.
        self.command(json!(["quit"]));
    }
}

/// Первый существующий файл из списка.
fn first_existing(candidates: Vec<PathBuf>) -> Option<String> {
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Стандартные места, куда ставят программу `app` (имя exe — `exe`).
#[cfg(windows)]
fn install_locations(app: &str, exe: &str) -> Vec<PathBuf> {
    let mut list = Vec::new();
    // Рядом с BrotherWatch.exe — сюда будем класть mpv в установщике.
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    {
        list.push(dir.join(app).join(exe));
    }
    // Scoop: настоящий exe, а не «прослойка» из shims.
    if let Some(scoop) = std::env::var_os("SCOOP") {
        list.push(
            PathBuf::from(scoop)
                .join("apps")
                .join(app)
                .join("current")
                .join(exe),
        );
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let scoop = PathBuf::from(home).join("scoop");
        list.push(scoop.join("apps").join(app).join("current").join(exe));
        list.push(scoop.join("shims").join(exe));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        list.push(PathBuf::from(local).join("Programs").join(app).join(exe));
    }
    list.push(PathBuf::from(r"C:\Program Files").join(app).join(exe));
    list
}

#[cfg(not(windows))]
fn install_locations(_app: &str, _exe: &str) -> Vec<PathBuf> {
    Vec::new()
}

/// Путь к mpv: переменная `BROTHERWATCH_MPV`, затем стандартные места
/// установки, иначе просто `mpv` из PATH.
fn find_mpv() -> String {
    if let Ok(path) = std::env::var("BROTHERWATCH_MPV") {
        return path;
    }
    let exe = if cfg!(windows) { "mpv.exe" } else { "mpv" };
    first_existing(install_locations("mpv", exe)).unwrap_or_else(|| "mpv".into())
}

/// Путь к yt-dlp, если он стоит в стандартном месте. Если нет — mpv
/// сам поищет yt-dlp в PATH.
fn find_ytdlp() -> Option<String> {
    if let Ok(path) = std::env::var("BROTHERWATCH_YTDLP") {
        return Some(path);
    }
    let exe = if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    first_existing(install_locations("yt-dlp", exe))
}

#[cfg(windows)]
fn ipc_path(id: u64) -> String {
    format!(r"\\.\pipe\brotherwatch-mpv-{}-{id}", std::process::id())
}

#[cfg(unix)]
fn ipc_path(id: u64) -> String {
    format!("/tmp/brotherwatch-mpv-{}-{id}.sock", std::process::id())
}

/// mpv создаёт канал не сразу после запуска — ждём до 10 секунд.
async fn connect_ipc(
    path: &str,
    child: &mut Child,
) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send + 'static, String> {
    let mut last_error = String::new();
    for _ in 0..100 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("mpv сразу завершился ({status})"));
        }
        match open_ipc(path).await {
            Ok(stream) => return Ok(stream),
            Err(e) => last_error = e.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("не удалось подключиться к mpv: {last_error}"))
}

#[cfg(windows)]
async fn open_ipc(path: &str) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    tokio::net::windows::named_pipe::ClientOptions::new().open(path)
}

#[cfg(unix)]
async fn open_ipc(path: &str) -> std::io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(path).await
}
