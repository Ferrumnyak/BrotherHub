//! macOS: mpv как библиотека (libmpv) внутри приложения.
//!
//! На macOS окно другой программы встроить в своё нельзя, а `--wid` у
//! нынешнего видео mpv для macOS (Vulkan) не работает. Поэтому mpv работает
//! прямо в процессе BrotherHub, а его окно без рамки становится дочерним
//! окном главного (video.rs): macOS сама двигает его вместе с главным.
//! Управление то же, что на Windows: JSON IPC через сокет
//! `input-ipc-server` (player.rs), — меняется только запуск.
//!
//! libmpv подгружается при первом запуске плеера (`dlopen`): скачанная
//! приложением (папка `libmpv` в папке данных, см. tools.rs) или из Homebrew.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use crate::logs;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlerror() -> *const c_char;
}

const RTLD_NOW: c_int = 0x2;
const RTLD_LOCAL: c_int = 0x4;
const MPV_FORMAT_INT64: c_int = 4;
const MPV_EVENT_SHUTDOWN: c_int = 1;

/// Начало `mpv_event` — нужен только номер события.
#[repr(C)]
struct Event {
    event_id: c_int,
}

struct Api {
    create: unsafe extern "C" fn() -> *mut c_void,
    initialize: unsafe extern "C" fn(*mut c_void) -> c_int,
    set_option_string: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
    command_string: unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int,
    get_property: unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut c_void) -> c_int,
    wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *mut Event,
    terminate_destroy: unsafe extern "C" fn(*mut c_void),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
}

/// Где искать libmpv: `BROTHERHUB_LIBMPV`, скачанная приложением, Homebrew.
fn candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(p) = std::env::var_os("BROTHERHUB_LIBMPV") {
        list.push(PathBuf::from(p));
    }
    if let Some(dir) = crate::tools::tools_dir() {
        list.push(dir.join("libmpv").join("libmpv.2.dylib"));
    }
    list.push(PathBuf::from("/opt/homebrew/lib/libmpv.2.dylib"));
    list.push(PathBuf::from("/usr/local/lib/libmpv.2.dylib"));
    list
}

/// Путь к libmpv, если она есть.
pub fn find() -> Option<PathBuf> {
    candidates().into_iter().find(|p| p.is_file())
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(load).as_ref().map_err(Clone::clone)
}

fn load() -> Result<Api, String> {
    let path = find().ok_or("Не нашёл libmpv — плеер не скачан.")?;
    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let lib = unsafe { dlopen(c_path.as_ptr(), RTLD_NOW | RTLD_LOCAL) };
    if lib.is_null() {
        let why = unsafe { CStr::from_ptr(dlerror()) }.to_string_lossy().into_owned();
        return Err(format!("Не удалось загрузить libmpv ({}): {why}", path.display()));
    }
    logs::info(format!("libmpv: {}", path.display()));
    macro_rules! sym {
        ($name:literal) => {{
            let p = unsafe { dlsym(lib, concat!($name, "\0").as_ptr() as *const c_char) };
            if p.is_null() {
                return Err(format!("В libmpv нет функции {}", $name));
            }
            unsafe { std::mem::transmute::<*mut c_void, _>(p) }
        }};
    }
    Ok(Api {
        create: sym!("mpv_create"),
        initialize: sym!("mpv_initialize"),
        set_option_string: sym!("mpv_set_option_string"),
        command_string: sym!("mpv_command_string"),
        get_property: sym!("mpv_get_property"),
        wait_event: sym!("mpv_wait_event"),
        terminate_destroy: sym!("mpv_terminate_destroy"),
        error_string: sym!("mpv_error_string"),
    })
}

fn error_text(api: &Api, code: c_int) -> String {
    unsafe { CStr::from_ptr((api.error_string)(code)) }.to_string_lossy().into_owned()
}

/// Ключ командной строки mpv → имя и значение опции.
fn option(arg: &str) -> Option<(&str, &str)> {
    let arg = arg.strip_prefix("--")?;
    Some(match arg.split_once('=') {
        Some((name, value)) => (name, value),
        None => match arg.strip_prefix("no-") {
            Some(name) => (name, "no"),
            None => (arg, "yes"),
        },
    })
}

/// Ключи, собранные для запуска mpv программой, — в опции libmpv.
pub fn args_of(cmd: &tokio::process::Command) -> Vec<String> {
    cmd.as_std()
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect()
}

struct Inner {
    /// Пусто — mpv уже закрыт.
    handle: Mutex<usize>,
}

/// Запущенный mpv. Закрывается командой `quit` (при Drop тоже); сам
/// экземпляр уничтожает поток событий, когда mpv завершится.
pub struct Mpv {
    inner: Arc<Inner>,
}

impl Mpv {
    /// Запустить mpv с ключами `args` (как в командной строке, без
    /// адресов видео). Его окно становится дочерним окном главного — место
    /// `slot` в video.rs (0 — фильм, 1 — ролик сбоку).
    pub fn start(args: &[String], slot: usize) -> Result<Self, String> {
        let api = api()?;
        let handle = unsafe { (api.create)() };
        if handle.is_null() {
            return Err("libmpv не запустилась".into());
        }
        // Окно без рамки, которое не меняет размер само и не перетаскивается:
        // размер и место задаёт video.rs.
        let own = [
            "--force-window=yes",
            "--border=no",
            "--window-dragging=no",
            "--keepaspect-window=no",
            "--auto-window-resize=no",
            "--hidpi-window-scale=no",
            "--focus-on=never",
            "--geometry=16x16+0+0",
        ];
        for arg in args.iter().map(String::as_str).chain(own) {
            let Some((name, value)) = option(arg) else {
                continue;
            };
            let (Ok(n), Ok(v)) = (CString::new(name), CString::new(value)) else {
                continue;
            };
            let r = unsafe { (api.set_option_string)(handle, n.as_ptr(), v.as_ptr()) };
            if r < 0 {
                logs::warn(format!("libmpv: ключ {arg} не принят ({})", error_text(api, r)));
            }
        }
        let r = unsafe { (api.initialize)(handle) };
        if r < 0 {
            unsafe { (api.terminate_destroy)(handle) };
            return Err(format!("libmpv не запустилась: {}", error_text(api, r)));
        }

        let inner = Arc::new(Inner { handle: Mutex::new(handle as usize) });
        let events = inner.clone();
        let raw = handle as usize;
        // События читаем (иначе копятся) и ждём завершения mpv.
        std::thread::spawn(move || loop {
            let ev = unsafe { (api.wait_event)(raw as *mut c_void, -1.0) };
            if !ev.is_null() && unsafe { (*ev).event_id } == MPV_EVENT_SHUTDOWN {
                // Отпускаем блокировку до уничтожения: оно может ждать
                // главный поток, а тот — эту блокировку (quit).
                *events.handle.lock().unwrap() = 0;
                unsafe { (api.terminate_destroy)(raw as *mut c_void) };
                break;
            }
        });
        // Окно у mpv появляется не сразу — ждём его (до 10 секунд).
        let mpv = Self { inner };
        let watch = Mpv { inner: mpv.inner.clone() };
        std::thread::spawn(move || {
            for _ in 0..100 {
                if let Some(window) = watch.window() {
                    crate::video::adopt(slot, window);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            std::mem::forget(watch);
        });
        Ok(mpv)
    }

    /// NSWindow mpv (свойство `window-id`).
    fn window(&self) -> Option<isize> {
        let api = api().ok()?;
        let h = self.inner.handle.lock().unwrap();
        if *h == 0 {
            return None;
        }
        let mut id: i64 = 0;
        let r = unsafe {
            (api.get_property)(*h as *mut c_void, c"window-id".as_ptr(), MPV_FORMAT_INT64, &mut id as *mut i64 as *mut c_void)
        };
        (r >= 0 && id != 0).then_some(id as isize)
    }

    /// Команда mpv строкой, как в input.conf (`loadfile "…" append`).
    pub fn command(&self, command: &str) {
        let (Ok(api), Ok(c)) = (api(), CString::new(command)) else {
            return;
        };
        let h = self.inner.handle.lock().unwrap();
        if *h != 0 {
            let r = unsafe { (api.command_string)(*h as *mut c_void, c.as_ptr()) };
            if r < 0 {
                logs::warn(format!("libmpv: команда «{command}» не выполнилась ({})", error_text(api, r)));
            }
        }
    }

    /// Закрыть mpv (повторно — ничего не делает). В своём потоке: команда
    /// ждёт ответа mpv, а тот может ждать главный поток, откуда нас зовут.
    pub fn quit(&self) {
        let mpv = Mpv { inner: self.inner.clone() };
        std::thread::spawn(move || {
            mpv.command("quit");
            std::mem::forget(mpv);
        });
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        self.quit();
    }
}

#[cfg(test)]
mod tests {
    use super::option;

    #[test]
    fn options_from_args() {
        assert_eq!(option("--idle=yes"), Some(("idle", "yes")));
        assert_eq!(option("--no-terminal"), Some(("terminal", "no")));
        assert_eq!(option("--osc"), Some(("osc", "yes")));
        assert_eq!(option("--script-opts=a=b,c=d"), Some(("script-opts", "a=b,c=d")));
        assert_eq!(option("ytdl://x"), None);
    }
}
