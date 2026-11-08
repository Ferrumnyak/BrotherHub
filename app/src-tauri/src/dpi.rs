//! Ускорение YouTube: обход замедления через ByeDPI.
//!
//! ByeDPI (`ciadpi.exe`, https://github.com/hufrea/byedpi, лицензия MIT) —
//! маленький локальный прокси. Он не ставит драйверов и не просит прав
//! администратора: через него идёт только трафик самого приложения
//! (mpv, yt-dlp, «Обзор»), а не всего компьютера. Запутывает он только
//! соединения с доменами YouTube ([`HOSTS`]), остальные проходят как есть.
//!
//! Какие настройки ByeDPI работают, зависит от провайдера, поэтому их
//! подбирает кнопка «Найти лучший обход» ([`dpi_find_best`]): по очереди
//! пробует наборы из [`PROFILES`], на каждом качает начало тестового ролика
//! и запоминает самый быстрый. Сами по себе проверки не повторяются.
//!
//! `ciadpi.exe` скачивается с GitHub при первом поиске обхода; версия и
//! SHA-256 архива закреплены ниже.

use std::{
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex as StdMutex, OnceLock,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::{
    process::{Child, Command},
    sync::{oneshot, Mutex},
};

use crate::logs;

const CIADPI_URL: &str =
    "https://github.com/hufrea/byedpi/releases/download/v0.17.3/byedpi-17.3-x86_64-w64.zip";
const CIADPI_SHA256: &str = "70d2c94147193cb915f9c6eb5144b8d404dacbcfa90bda2383b6b211afafa456";

/// Домены, соединения с которыми ByeDPI запутывает (вместе с поддоменами).
const HOSTS: &str = ":youtube.com youtu.be googlevideo.com ytimg.com ggpht.com \
                     youtube-nocookie.com youtubei.googleapis.com";

/// Ролик для замера скорости (Big Buck Bunny от Blender Foundation: длинный,
/// с 720p — есть что качать).
const TEST_VIDEO: &str = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

/// Сколько качать на каждой проверке.
const PROBE_TIME: Duration = Duration::from_secs(6);
const PROBE_BYTES: u64 = 16 * 1024 * 1024;

/// Наборы настроек ByeDPI, из которых выбирается лучший.
const PROFILES: &[(&str, &[&str])] = &[
    ("split + disorder + tlsrec", &["--split", "1", "--disorder", "3+s", "--mod-http=h,d", "--tlsrec", "1+s"]),
    ("tlsrec + disorder", &["--tlsrec", "1+s", "--disorder", "1+s"]),
    ("split + disorder (SNI)", &["--split", "1+s", "--disorder", "3+s"]),
    ("disorder", &["--disorder", "1"]),
    ("split 2 + tlsrec", &["--split", "2", "--tlsrec", "1+s"]),
    ("tlsrec 3 + split 2", &["--tlsrec", "3+s", "--split", "2"]),
    ("oob + tlsrec", &["--oob", "1", "--tlsrec", "3+s"]),
    ("oob 2 + tlsrec 5", &["--oob", "2", "--tlsrec", "5+s"]),
    ("disoob + disorder", &["--disoob", "3", "--disorder", "7"]),
    ("fake", &["--fake", "-1", "--ttl", "8"]),
    ("fake + tlsrec", &["--fake", "-1", "--ttl", "5", "--tlsrec", "3+s"]),
    ("split + oob + disorder + fake", &["--split", "1", "--oob", "1", "--disorder", "3", "--fake", "-1", "--tlsrec", "3+s"]),
];

/// Что запомнено (файл `dpi.json` в папке данных).
#[derive(Clone, Default, Serialize, Deserialize)]
struct Settings {
    enabled: bool,
    /// Название выбранного набора.
    profile: Option<String>,
    args: Vec<String>,
    /// Скорость с обходом и без него при последней проверке, байт/с.
    speed: u64,
    baseline: u64,
}

fn settings_path() -> Option<PathBuf> {
    crate::tools::tools_dir().map(|d| d.join("dpi.json"))
}

fn load_settings() -> Settings {
    settings_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(s: &Settings) {
    if let Some(path) = settings_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(s) {
            let _ = std::fs::write(path, json);
        }
    }
}

// ---------- Запущенный прокси ----------

struct Running {
    stop: oneshot::Sender<()>,
}

fn running() -> &'static Mutex<Option<Running>> {
    static R: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// Адрес прокси для mpv, yt-dlp и «Обзора» (`None` — обход выключен).
static PROXY: StdMutex<Option<String>> = StdMutex::new(None);
/// Номер запуска: чтобы упавший старый процесс не сбросил новый.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Адрес прокси (`http://127.0.0.1:порт`), если обход включён и работает.
pub fn proxy() -> Option<String> {
    PROXY.lock().unwrap().clone()
}

/// Добавить yt-dlp прокси, если обход включён.
pub fn ytdlp_proxy(cmd: &mut Command) {
    if let Some(p) = proxy() {
        cmd.arg("--proxy").arg(p);
    }
}

fn ciadpi_path() -> Option<PathBuf> {
    crate::tools::tools_dir().map(|d| d.join("byedpi").join("ciadpi.exe"))
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("Не нашёл свободный порт: {e}"))
}

/// Запустить ciadpi с настройками `args` и дождаться, пока он начнёт
/// принимать соединения.
async fn spawn(args: &[String]) -> Result<(Child, u16), String> {
    let exe = ciadpi_path().filter(|p| p.is_file()).ok_or("ByeDPI не скачан.")?;
    let port = free_port()?;
    let mut cmd = Command::new(&exe);
    cmd.args(["-i", "127.0.0.1", "-p", &port.to_string(), "--http-connect", "--hosts", HOSTS])
        .args(args)
        // Всё, что не YouTube, — без изменений.
        .arg("--auto=none")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("Не удалось запустить ByeDPI: {e}"))?;
    crate::player::bind_to_app_lifetime(&child);

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let started = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use tokio::io::AsyncReadExt;
                let _ = stderr.read_to_string(&mut err).await;
            }
            let msg = format!("ByeDPI сразу закрылся ({status}): {}", err.trim());
            logs::warn(&msg);
            return Err(msg);
        }
        if tokio::net::TcpStream::connect(addr).await.is_ok() {
            // Сообщения ByeDPI — в журнал приложения.
            if let Some(stderr) = child.stderr.take() {
                tauri::async_runtime::spawn(async move {
                    use tokio::io::AsyncBufReadExt;
                    let mut lines = tokio::io::BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        logs::info(format!("ByeDPI: {line}"));
                    }
                });
            }
            return Ok((child, port));
        }
        if started.elapsed() > Duration::from_secs(3) {
            return Err("ByeDPI не запустился.".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Остановить работающий прокси.
async fn stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    *PROXY.lock().unwrap() = None;
    if let Some(r) = running().lock().await.take() {
        let _ = r.stop.send(());
    }
}

/// Запустить прокси с настройками `args` вместо текущего.
async fn start(args: Vec<String>) -> Result<(), String> {
    stop().await;
    let (mut child, port) = spawn(&args).await?;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (stop_tx, stop_rx) = oneshot::channel();
    *running().lock().await = Some(Running { stop: stop_tx });
    *PROXY.lock().unwrap() = Some(format!("http://127.0.0.1:{port}"));
    logs::info(format!("ByeDPI работает на порту {port}: {}", args.join(" ")));

    tauri::async_runtime::spawn(async move {
        let exited = tokio::select! {
            _ = stop_rx => None,
            status = child.wait() => Some(status),
        };
        let Some(status) = exited else {
            let _ = child.kill().await;
            return;
        };
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        logs::warn(format!("ByeDPI закрылся ({status:?}), запускаю заново"));
        *PROXY.lock().unwrap() = None;
        tokio::time::sleep(Duration::from_secs(2)).await;
        if GENERATION.load(Ordering::SeqCst) == generation {
            if let Err(e) = restart(args).await {
                logs::warn(format!("ByeDPI не перезапустился: {e}"));
            }
        }
    });
    Ok(())
}

/// Перезапуск из задачи, которая следит за процессом (тип будущего
/// стёрт, иначе `start` ссылался бы сам на себя).
fn restart(
    args: Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
    Box::pin(start(args))
}

/// При запуске приложения — включить запомненный обход.
pub fn start_saved() {
    let s = load_settings();
    if !s.enabled || s.args.is_empty() || !ciadpi_path().is_some_and(|p| p.is_file()) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start(s.args).await {
            logs::warn(format!("обход YouTube не включился: {e}"));
        }
    });
}

// ---------- Скачивание ciadpi ----------

async fn ensure_ciadpi() -> Result<(), String> {
    let exe = ciadpi_path().ok_or("Не нашёл папку данных (%LOCALAPPDATA%).")?;
    if exe.is_file() {
        return Ok(());
    }
    let dir = exe.parent().unwrap().to_path_buf();
    let base = dir.parent().unwrap().to_path_buf();
    tokio::fs::create_dir_all(&base)
        .await
        .map_err(|e| format!("Не удалось создать папку {}: {e}", base.display()))?;
    logs::info(format!("скачиваю ByeDPI: {CIADPI_URL}"));

    let client = reqwest::Client::builder()
        .user_agent(concat!("BrotherHub/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let body = client
        .get(CIADPI_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Не удалось скачать ByeDPI: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Не удалось скачать ByeDPI: {e}"))?;
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(&body));
    if !hash.eq_ignore_ascii_case(CIADPI_SHA256) {
        return Err("Скачанный ByeDPI повреждён (не совпала контрольная сумма).".into());
    }

    let archive = base.join("byedpi-download.zip");
    let fresh = base.join("byedpi.new");
    let _ = tokio::fs::remove_dir_all(&fresh).await;
    tokio::fs::create_dir_all(&fresh).await.map_err(|e| e.to_string())?;
    tokio::fs::write(&archive, &body).await.map_err(|e| e.to_string())?;
    let unpacked = crate::tools::unzip(&archive, &fresh).await;
    let _ = tokio::fs::remove_file(&archive).await;
    unpacked?;
    let found = find_file(&fresh, "ciadpi.exe").ok_or("В архиве ByeDPI нет ciadpi.exe.")?;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&found, &exe)
        .await
        .map_err(|e| format!("Не удалось положить ByeDPI в {}: {e}", exe.display()))?;
    let _ = tokio::fs::remove_dir_all(&fresh).await;
    Ok(())
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if path.file_name().is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            return Some(path);
        }
    }
    None
}

// ---------- Замер скорости ----------

/// Прямая ссылка на поток тестового ролика (через `proxy`, если задан).
async fn test_stream(proxy: Option<&str>) -> Option<String> {
    let ytdlp = crate::player::find_ytdlp().unwrap_or_else(|| "yt-dlp".into());
    let mut cmd = Command::new(ytdlp);
    cmd.args([
        "--no-warnings",
        "--no-playlist",
        "-f",
        "bv[height<=720][protocol=https]/b[protocol=https]",
        "-g",
    ]);
    if let Some(p) = proxy {
        cmd.arg("--proxy").arg(p);
    }
    cmd.arg("--")
        .arg(TEST_VIDEO)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(Duration::from_secs(60), cmd.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("http"))
        .map(str::to_owned)
}

/// Скорость скачивания начала потока, байт/с (0 — не качается).
async fn measure(url: &str, proxy: Option<&str>) -> u64 {
    let builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .connect_timeout(Duration::from_secs(5));
    let builder = match proxy {
        Some(p) => match reqwest::Proxy::all(p) {
            Ok(p) => builder.proxy(p),
            Err(_) => return 0,
        },
        None => builder.no_proxy(),
    };
    let Ok(client) = builder.build() else { return 0 };
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + PROBE_TIME;
    let request = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes=0-{}", PROBE_BYTES - 1))
        .send();
    let Ok(Ok(mut resp)) = tokio::time::timeout_at(deadline, request).await else {
        return 0;
    };
    if !resp.status().is_success() {
        return 0;
    }
    let mut got = 0u64;
    while let Ok(Ok(Some(chunk))) = tokio::time::timeout_at(deadline, resp.chunk()).await {
        got += chunk.len() as u64;
        if got >= PROBE_BYTES {
            break;
        }
    }
    let ms = started.elapsed().as_millis().max(1) as u64;
    got * 1000 / ms
}

async fn measure_profile(url: &str, args: &[String]) -> u64 {
    match spawn(args).await {
        Ok((mut child, port)) => {
            let speed = measure(url, Some(&format!("http://127.0.0.1:{port}"))).await;
            let _ = child.kill().await;
            speed
        }
        Err(_) => 0,
    }
}

fn to_args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ---------- Команды интерфейса ----------

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    running: bool,
    profile: Option<String>,
    /// Байт/с.
    speed: u64,
    baseline: u64,
}

#[tauri::command]
pub fn dpi_status() -> Status {
    let s = load_settings();
    Status {
        enabled: s.enabled,
        running: proxy().is_some(),
        profile: s.profile,
        speed: s.speed,
        baseline: s.baseline,
    }
}

/// Включить или выключить найденный обход.
#[tauri::command]
pub async fn dpi_set_enabled(enabled: bool) -> Result<Status, String> {
    let mut s = load_settings();
    if enabled {
        if s.args.is_empty() {
            return Err("Сначала нажми «Найти лучший обход».".into());
        }
        ensure_ciadpi().await?;
        start(s.args.clone()).await?;
    } else {
        stop().await;
    }
    s.enabled = enabled;
    save_settings(&s);
    Ok(dpi_status())
}

#[derive(Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

/// Подобрать лучшие настройки обхода и включить их (или выключить обход,
/// если без него не медленнее).
#[tauri::command]
pub async fn dpi_find_best(app: AppHandle) -> Result<Status, String> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let Ok(_guard) = LOCK.get_or_init(|| Mutex::new(())).try_lock() else {
        return Err("Проверка уже идёт.".into());
    };
    let total = PROFILES.len() + 1;
    let progress = |done| {
        let _ = app.emit("dpi-progress", Progress { done, total });
    };
    progress(0);
    ensure_ciadpi().await?;

    // Ссылку на поток берём напрямую, а если YouTube не отвечает — через
    // первый набор настроек.
    let mut url = test_stream(proxy().as_deref()).await;
    if url.is_none() {
        if let Ok((mut child, port)) = spawn(&to_args(PROFILES[0].1)).await {
            url = test_stream(Some(&format!("http://127.0.0.1:{port}"))).await;
            let _ = child.kill().await;
        }
    }
    let url = url.ok_or("Не получилось открыть тестовый ролик YouTube. Проверь интернет.")?;

    let baseline = measure(&url, None).await;
    logs::info(format!("обход YouTube: без обхода {} КБ/с", baseline / 1024));
    progress(1);

    let mut best: Option<(&str, &[&str], u64)> = None;
    for (i, &(name, args)) in PROFILES.iter().enumerate() {
        let speed = measure_profile(&url, &to_args(args)).await;
        logs::info(format!("обход YouTube: «{name}» — {} КБ/с", speed / 1024));
        if best.map_or(true, |(_, _, b)| speed > b) {
            best = Some((name, args, speed));
        }
        progress(i + 2);
    }

    let mut s = load_settings();
    s.baseline = baseline;
    match best {
        // Обход заметно быстрее — включаем.
        Some((name, args, speed)) if speed > 0 && speed > baseline + baseline / 4 => {
            s.enabled = true;
            s.profile = Some(name.to_string());
            s.args = to_args(args);
            s.speed = speed;
            save_settings(&s);
            start(s.args.clone()).await?;
        }
        Some((_, _, speed)) if speed == 0 && baseline == 0 => {
            return Err("YouTube не качается ни так, ни через обход.".into());
        }
        // Без обхода не медленнее — выключаем.
        _ => {
            s.enabled = false;
            s.profile = None;
            s.args.clear();
            s.speed = baseline;
            save_settings(&s);
            stop().await;
        }
    }
    Ok(dpi_status())
}
