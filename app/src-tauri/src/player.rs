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
    /// Файл или ссылку не удалось открыть.
    LoadFailed,
    /// Изменился список дорожек (загрузился файл, подхватились внешние).
    TracksChanged,
    /// Нажата клавиша, которую обрабатывает приложение (см. [`INPUT_CONF`]).
    Key(PlayerKey),
    /// Окно mpv закрыли или процесс завершился.
    Shutdown,
}

/// Клавиши в окне видео, которые обрабатывает приложение, а не mpv.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlayerKey {
    Fullscreen,
    ExitFullscreen,
    ToggleChat,
}

/// Свои настройки клавиш mpv. Выход из плеера отключён (иначе встроенное
/// видео пропадёт по случайному нажатию `q`), а полный экран и чат
/// переключает приложение: mpv присылает нам `script-message`.
const INPUT_CONF: &str = "\
q ignore
Q ignore
CLOSE_WIN ignore
f script-message bw fullscreen
MBTN_LEFT_DBL script-message bw fullscreen
ESC script-message bw exit-fullscreen
TAB script-message bw toggle-chat
";

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
    /// Запустить mpv. `wid` — окно, в которое встроить видео
    /// (`None` — отдельное окно).
    pub async fn spawn(
        events: mpsc::UnboundedSender<PlayerEventMsg>,
        wid: Option<isize>,
        quality: Option<u32>,
    ) -> Result<Self, String> {
        let id = NEXT_PLAYER_ID.fetch_add(1, Ordering::Relaxed);
        let ipc = ipc_path(id);
        let mpv = find_mpv();

        let mut cmd = Command::new(&mpv);
        cmd.args([
            "--idle=yes",
            "--force-window=yes",
            "--keep-open=yes",
            "--pause=yes",
            "--title=BrotherHub",
            "--no-terminal",
            // Декодировать видео на видеокарте, если она умеет (4K и HEVC
            // без нагрузки на процессор); иначе — процессором, как раньше.
            "--hwdec=auto-safe",
            // Запас для онлайн-видео, чтобы не подтормаживало.
            "--cache=yes",
            "--demuxer-max-bytes=150MiB",
            "--demuxer-readahead-secs=30",
            // Встроенный mpv по умолчанию не принимает клавиатуру — включаем.
            "--input-vo-keyboard=yes",
            // Управление — панелью приложения, свою панель mpv прячем.
            "--osc=no",
            // Шрифты экранных подсказок и обычных (не ASS) субтитров.
            "--osd-font=Segoe UI Semibold",
            "--osd-font-size=36",
            "--sub-font=Segoe UI Semibold",
            "--sub-border-size=2.5",
            "--sub-shadow-offset=1",
            // Озвучка и субтитры отдельными файлами рядом с видео или в
            // типичных подпапках раздач — подхватываются автоматически.
            "--audio-file-auto=fuzzy",
            "--sub-auto=fuzzy",
            "--audio-file-paths=Rus Sound;RUS Sound;Sound;Sounds;Audio;Звук;Озвучка",
            "--sub-file-paths=Subs;Subtitles;Rus Subs;RUS Subs;Sub;Субтитры",
            // По умолчанию — русская озвучка, если она есть.
            "--alang=ru,rus,russian",
        ])
        .arg(format!("--input-ipc-server={ipc}"))
        .kill_on_drop(true);
        cmd.arg(format!("--ytdl-format={}", ytdl_format(quality)));
        if let Some(wid) = wid {
            cmd.arg(format!("--wid={wid}"));
        }
        let input_conf = std::env::temp_dir().join("brotherwatch-input.conf");
        if std::fs::write(&input_conf, INPUT_CONF).is_ok() {
            cmd.arg(format!("--input-conf={}", input_conf.display()));
        }
        let ytdlp = find_ytdlp();
        if let Some(ytdlp) = &ytdlp {
            cmd.arg(format!("--script-opts=ytdl_hook-ytdl_path={ytdlp}"));
        }
        // Сертификаты Mozilla + Windows, иначе часть сайтов не открывается
        // (см. certs.rs).
        if let Some(ca) = crate::certs::ca_bundle() {
            cmd.arg(format!("--tls-ca-file={}", ca.display()));
        }
        // Подробный журнал плеера и yt-dlp (см. logs.rs).
        let log_file = crate::logs::mpv_log_path(id);
        if let Some(log) = &log_file {
            cmd.arg(format!("--log-file={}", log.display()));
        }
        crate::logs::info(format!(
            "запускаю плеер #{id}: {mpv}; yt-dlp: {}; журнал: {}",
            ytdlp.as_deref().unwrap_or("из PATH"),
            log_file
                .as_deref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "нет".into())
        ));
        // Не показывать чёрное консольное окно рядом с плеером.
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| {
            let msg = format!(
                "не удалось запустить mpv ({mpv}): {e}. \
                     Установи mpv и проверь, что команда `mpv --version` работает в терминале."
            );
            crate::logs::error(&msg);
            msg
        })?;

        // mpv завершится вместе с приложением, как бы оно ни закрылось.
        bind_to_app_lifetime(&child);

        let stream = connect_ipc(&ipc, &mut child).await.inspect_err(|e| crate::logs::error(e))?;
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
                        "property-change"
                            if v.get("name").and_then(Value::as_str) == Some("track-list") =>
                        {
                            Some(PlayerEvent::TracksChanged)
                        }
                        "playback-restart" => Some(PlayerEvent::Restart),
                        "file-loaded" => Some(PlayerEvent::FileLoaded),
                        "end-file" if v.get("reason").and_then(Value::as_str) == Some("error") => {
                            Some(PlayerEvent::LoadFailed)
                        }
                        "client-message" => parse_key(&v).map(PlayerEvent::Key),
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
        player.command(json!(["observe_property", 2, "track-list"]));
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

    /// Открыть другую ссылку и начать с позиции `at` (сбросить потом
    /// через [`Player::clear_start`]).
    pub fn load_at(&self, url: &str, at: Option<f64>) {
        if let Some(at) = at {
            self.command(json!(["set_property", "start", format!("{at:.2}")]));
        }
        self.load(url);
    }

    /// Закрыть видео: окно плеера остаётся, но пустое.
    pub fn stop(&self) {
        self.command(json!(["stop"]));
    }

    pub fn set_pause(&self, paused: bool) {
        self.command(json!(["set_property", "pause", paused]));
    }

    pub fn seek(&self, position: f64) {
        self.command(json!(["seek", position, "absolute"]));
    }

    /// Показать поверх видео текст в формате ASS (пустая строка — убрать).
    pub fn set_overlay(&self, ass: &str) {
        let format = if ass.is_empty() { "none" } else { "ass-events" };
        self.command(json!({
            "name": "osd-overlay",
            "id": 1,
            "format": format,
            "data": ass,
        }));
    }

    /// Перемотать относительно текущей позиции.
    pub fn seek_by(&self, delta: f64) {
        self.command(json!(["seek", delta, "relative"]));
    }

    /// Выбрать дорожку: `kind` — `aid` (аудио) или `sid` (субтитры),
    /// `None` — выключить.
    pub fn set_track(&self, kind: &str, id: Option<i64>) {
        match id {
            Some(id) => self.command(json!(["set_property", kind, id])),
            None => self.command(json!(["set_property", kind, "no"])),
        }
    }

    /// Подключить субтитры из файла и сразу их включить.
    pub fn add_subtitle(&self, path: &str) {
        self.command(json!(["sub-add", path, "select"]));
    }

    /// Скорость воспроизведения (1.0 — обычная).
    pub fn set_speed(&self, speed: f64) {
        self.command(json!(["set_property", "speed", speed]));
    }

    pub fn set_volume(&self, volume: f64) {
        self.command(json!(["set_property", "volume", volume.clamp(0.0, 130.0)]));
    }

    /// Прочитать числовое свойство.
    pub async fn get_f64(&self, property: &str) -> Option<f64> {
        self.get(property).await.and_then(|v| v.as_f64())
    }

    /// Сменить качество ссылки и перезапустить её с позиции `resume_at`.
    pub fn reload_with_quality(&self, quality: Option<u32>, resume_at: Option<f64>) {
        self.command(json!(["set_property", "ytdl-format", ytdl_format(quality)]));
        if let Some(at) = resume_at {
            // `start` действует на следующую загрузку; после неё сбрасываем.
            self.command(json!(["set_property", "start", format!("{at:.2}")]));
        }
        self.command(json!(["playlist-play-index", "current"]));
    }

    /// Убрать начальную позицию, заданную для перезагрузки.
    pub fn clear_start(&self) {
        self.command(json!(["set_property", "start", "none"]));
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

/// Привязать процесс mpv к жизни приложения.
///
/// На Windows процесс кладётся в Job Object с флагом
/// `KILL_ON_JOB_CLOSE`: когда BrotherHub завершается (крестик, Alt+F4,
/// диспетчер задач, падение), Windows закрывает задание и убивает mpv
/// вместе с запущенным им yt-dlp.
#[cfg(windows)]
fn bind_to_app_lifetime(child: &Child) {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // Одно задание на всё приложение; его handle не закрываем до выхода.
    static JOB: OnceLock<isize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as isize
    });
    if job == 0 {
        return;
    }
    if let Some(process) = child.raw_handle() {
        unsafe {
            AssignProcessToJobObject(job as HANDLE, process as HANDLE);
        }
    }
}

#[cfg(not(windows))]
fn bind_to_app_lifetime(_child: &Child) {}

/// Обновить yt-dlp, который скачало или положило рядом с собой приложение.
///
/// Сайты часто меняются, и старый yt-dlp перестаёт открывать ссылки,
/// поэтому при каждом запуске приложения он тихо обновляет сам себя.
/// yt-dlp, установленный отдельно (например, через Scoop), не трогаем.
pub fn update_bundled_ytdlp() {
    let exe = exe_name("yt-dlp");
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("yt-dlp").join(&exe))),
        crate::tools::tools_dir().map(|d| d.join("yt-dlp").join(&exe)),
    ];
    for ytdlp in candidates.into_iter().flatten().filter(|p| p.is_file()) {
        std::thread::spawn(move || {
            let mut cmd = std::process::Command::new(ytdlp);
            cmd.arg("-U")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            let _ = cmd.status();
        });
    }
}

/// `script-message bw <действие>` из [`INPUT_CONF`].
fn parse_key(v: &Value) -> Option<PlayerKey> {
    let args = v.get("args")?.as_array()?;
    if args.first()?.as_str()? != "bw" {
        return None;
    }
    match args.get(1)?.as_str()? {
        "fullscreen" => Some(PlayerKey::Fullscreen),
        "exit-fullscreen" => Some(PlayerKey::ExitFullscreen),
        "toggle-chat" => Some(PlayerKey::ToggleChat),
        _ => None,
    }
}

/// Формат для yt-dlp: лучшее видео не выше `quality` строк (по умолчанию —
/// 1080p) плюс лучший звук; если такого нет — лучшее, что есть.
pub fn ytdl_format(quality: Option<u32>) -> String {
    let h = quality.unwrap_or(1080);
    format!("bestvideo[height<=?{h}]+bestaudio/best[height<=?{h}]/best")
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
    // Рядом с BrotherHub.exe (так было в установщике до версии 0.2).
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    {
        list.push(dir.join(app).join(exe));
    }
    // Скачанный при первом запуске (см. tools.rs).
    if let Some(dir) = crate::tools::tools_dir() {
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
fn install_locations(app: &str, exe: &str) -> Vec<PathBuf> {
    crate::tools::tools_dir()
        .map(|dir| dir.join(app).join(exe))
        .into_iter()
        .collect()
}

/// Имя исполняемого файла программы: `mpv.exe` на Windows, `mpv` в других системах.
pub fn exe_name(app: &str) -> String {
    if cfg!(windows) {
        format!("{app}.exe")
    } else {
        app.to_owned()
    }
}

/// Есть ли программа `exe` в PATH.
fn in_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}

/// Найдётся ли mpv (иначе его нужно скачать — см. tools.rs).
pub fn mpv_available() -> bool {
    let exe = exe_name("mpv");
    std::env::var_os("BROTHERWATCH_MPV").is_some()
        || first_existing(install_locations("mpv", &exe)).is_some()
        || in_path(&exe)
}

/// Найдётся ли yt-dlp — у нас или в PATH, где его ищет mpv.
pub fn ytdlp_available() -> bool {
    let exe = exe_name("yt-dlp");
    std::env::var_os("BROTHERWATCH_YTDLP").is_some()
        || first_existing(install_locations("yt-dlp", &exe)).is_some()
        || in_path(&exe)
}

/// Путь к mpv: переменная `BROTHERWATCH_MPV`, затем стандартные места
/// установки, иначе просто `mpv` из PATH.
fn find_mpv() -> String {
    if let Ok(path) = std::env::var("BROTHERWATCH_MPV") {
        return path;
    }
    first_existing(install_locations("mpv", &exe_name("mpv"))).unwrap_or_else(|| "mpv".into())
}

/// Путь к yt-dlp, если он стоит в стандартном месте. Если нет — mpv
/// сам поищет yt-dlp в PATH.
fn find_ytdlp() -> Option<String> {
    if let Ok(path) = std::env::var("BROTHERWATCH_YTDLP") {
        return Some(path);
    }
    first_existing(install_locations("yt-dlp", &exe_name("yt-dlp")))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_format() {
        assert_eq!(
            ytdl_format(None),
            "bestvideo[height<=?1080]+bestaudio/best[height<=?1080]/best"
        );
        assert!(ytdl_format(Some(480)).contains("height<=?480"));
    }

    #[test]
    fn keys_from_mpv() {
        let v: Value =
            serde_json::from_str(r#"{"event":"client-message","args":["bw","toggle-chat"]}"#)
                .unwrap();
        assert!(matches!(parse_key(&v), Some(PlayerKey::ToggleChat)));
        let other: Value =
            serde_json::from_str(r#"{"event":"client-message","args":["x","y"]}"#).unwrap();
        assert!(parse_key(&other).is_none());
    }
}
