//! «Нажми и говори»: глобальная клавиша или кнопка мыши.
//!
//! На Windows ставятся низкоуровневые хуки клавиатуры и мыши
//! (`WH_KEYBOARD_LL`, `WH_MOUSE_LL`), как в Discord: клавиша работает,
//! даже когда активно другое окно, и при этом не «съедается» — нажатие
//! доходит до остальных программ как обычно.
//!
//! Код кнопки: для клавиатуры — virtual-key code Windows, для мыши —
//! `0x1_0000 | номер` (3 — средняя, 4 и 5 — боковые).
//!
//! На macOS — перехват событий (`CGEventTap`) с разрешения «Мониторинг
//! ввода»; коды клавиш переводятся в коды Windows (см. `imp::vk` для macOS).
//!
//! Так же работает и клавиша «вкл/выкл микрофон» (для режима «всегда включён»).
//!
//! События для интерфейса:
//! - `ptt` — `true`/`false`: кнопка нажата/отпущена;
//! - `mute-toggle` — нажата клавиша включения/выключения микрофона;
//! - `ptt-captured` — код кнопки, нажатой в режиме назначения.

use tauri::AppHandle;

#[tauri::command]
pub fn ptt_set_key(app: AppHandle, key: Option<u32>) {
    imp::set_key(&app, key);
}

/// Клавиша «вкл/выкл микрофон» (`None` — нет).
#[tauri::command]
pub fn mute_set_key(app: AppHandle, key: Option<u32>) {
    imp::set_mute_key(&app, key);
}

/// Следующее нажатие станет новой кнопкой (придёт событием `ptt-captured`).
#[tauri::command]
pub fn ptt_capture(app: AppHandle, enabled: bool) {
    imp::capture(&app, enabled);
}

#[cfg(windows)]
mod imp {
    use std::sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        OnceLock,
    };

    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP,
        WM_MBUTTONDOWN, WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    const MOUSE: u32 = 0x1_0000;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static HOOKS: OnceLock<()> = OnceLock::new();
    /// Назначенная кнопка (0 — режим выключен).
    static KEY: AtomicU32 = AtomicU32::new(0);
    static CAPTURE: AtomicBool = AtomicBool::new(false);
    static PRESSED: AtomicBool = AtomicBool::new(false);
    /// Клавиша «вкл/выкл микрофон» (0 — нет).
    static MUTE_KEY: AtomicU32 = AtomicU32::new(0);
    static MUTE_DOWN: AtomicBool = AtomicBool::new(false);

    pub fn set_mute_key(app: &AppHandle, key: Option<u32>) {
        start(app);
        MUTE_KEY.store(key.unwrap_or(0), Ordering::SeqCst);
        MUTE_DOWN.store(false, Ordering::SeqCst);
    }

    pub fn set_key(app: &AppHandle, key: Option<u32>) {
        start(app);
        KEY.store(key.unwrap_or(0), Ordering::SeqCst);
        // Сменили кнопку, пока старая зажата, — «отпускаем».
        if PRESSED.swap(false, Ordering::SeqCst) {
            emit("ptt", false);
        }
    }

    pub fn capture(app: &AppHandle, enabled: bool) {
        start(app);
        CAPTURE.store(enabled, Ordering::SeqCst);
    }

    /// Хуки ставятся один раз, в отдельном потоке со своим циклом сообщений.
    fn start(app: &AppHandle) {
        let _ = APP.set(app.clone());
        HOOKS.get_or_init(|| {
            std::thread::spawn(|| unsafe {
                let module = GetModuleHandleW(std::ptr::null());
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            });
        });
    }

    fn emit<T: serde::Serialize + Clone>(event: &str, payload: T) {
        if let Some(app) = APP.get() {
            let _ = app.emit(event, payload);
        }
    }

    fn handle(code: u32, down: bool) {
        if down && CAPTURE.swap(false, Ordering::SeqCst) {
            emit("ptt-captured", code);
            return;
        }
        let mute = MUTE_KEY.load(Ordering::SeqCst);
        // Переключаем по нажатию; автоповтор зажатой клавиши не считается.
        if mute != 0 && mute == code && MUTE_DOWN.swap(down, Ordering::SeqCst) != down && down {
            emit("mute-toggle", ());
        }
        let key = KEY.load(Ordering::SeqCst);
        if key == 0 || key != code {
            return;
        }
        // Автоповтор зажатой клавиши шлёт много KEYDOWN — сообщаем только смену.
        if PRESSED.swap(down, Ordering::SeqCst) != down {
            emit("ptt", down);
        }
    }

    // Хуки должны отвечать быстро, поэтому внутри — только сравнение кода.
    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            match wparam as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => handle(info.vkCode, true),
                WM_KEYUP | WM_SYSKEYUP => handle(info.vkCode, false),
                _ => {}
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
            // Для боковых кнопок номер (1 или 2) лежит в старшем слове mouseData.
            let xbutton = if (info.mouseData >> 16) & 0xFFFF == 1 {
                4
            } else {
                5
            };
            match wparam as u32 {
                WM_MBUTTONDOWN => handle(MOUSE | 3, true),
                WM_MBUTTONUP => handle(MOUSE | 3, false),
                WM_XBUTTONDOWN => handle(MOUSE | xbutton, true),
                WM_XBUTTONUP => handle(MOUSE | xbutton, false),
                _ => {}
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
}

/// macOS: перехват событий клавиатуры и мыши (`CGEventTap`) только на
/// чтение — нажатия, как и на Windows, доходят до программ как обычно.
/// Нужно разрешение «Мониторинг ввода» (Системные настройки →
/// Конфиденциальность и безопасность); пока его нет, раз в несколько секунд
/// пробуем снова — после разрешения клавиша заработает без перезапуска.
///
/// Коды клавиш переводятся в коды Windows ([`vk`]): так интерфейс
/// показывает названия клавиш и хранит настройку одинаково на всех системах.
#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::{
        atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering},
        OnceLock,
    };
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};

    const MOUSE: u32 = 0x1_0000;
    /// Клавиша, для которой нет кода Windows: `0x2_0000 | код macOS`.
    const MAC_KEY: u32 = 0x2_0000;

    type TapCallback =
        extern "C" fn(proxy: *mut c_void, kind: u32, event: *mut c_void, user: *mut c_void) -> *mut c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: TapCallback,
            user_info: *mut c_void,
        ) -> *mut c_void;
        fn CGEventTapEnable(tap: *mut c_void, enable: bool);
        fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
        fn CGEventGetFlags(event: *mut c_void) -> u64;
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *mut c_void, order: isize) -> *mut c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(run_loop: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
        static kCFRunLoopCommonModes: *const c_void;
    }

    // CGEventTapLocation / Placement / Options.
    const SESSION_TAP: u32 = 1;
    const HEAD_INSERT: u32 = 0;
    const LISTEN_ONLY: u32 = 1;
    // CGEventType.
    const KEY_DOWN: u32 = 10;
    const KEY_UP: u32 = 11;
    const FLAGS_CHANGED: u32 = 12;
    const OTHER_MOUSE_DOWN: u32 = 25;
    const OTHER_MOUSE_UP: u32 = 26;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    // CGEventField.
    const MOUSE_BUTTON_NUMBER: u32 = 3;
    const KEYBOARD_AUTOREPEAT: u32 = 8;
    const KEYBOARD_KEYCODE: u32 = 9;

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static STARTED: OnceLock<()> = OnceLock::new();
    static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
    static KEY: AtomicU32 = AtomicU32::new(0);
    static CAPTURE: AtomicBool = AtomicBool::new(false);
    static PRESSED: AtomicBool = AtomicBool::new(false);
    static MUTE_KEY: AtomicU32 = AtomicU32::new(0);
    static MUTE_DOWN: AtomicBool = AtomicBool::new(false);

    pub fn set_mute_key(app: &AppHandle, key: Option<u32>) {
        MUTE_KEY.store(key.unwrap_or(0), Ordering::SeqCst);
        MUTE_DOWN.store(false, Ordering::SeqCst);
        if key.is_some() {
            start(app);
        }
    }

    pub fn set_key(app: &AppHandle, key: Option<u32>) {
        KEY.store(key.unwrap_or(0), Ordering::SeqCst);
        if PRESSED.swap(false, Ordering::SeqCst) {
            emit("ptt", false);
        }
        if key.is_some() {
            start(app);
        }
    }

    pub fn capture(app: &AppHandle, enabled: bool) {
        CAPTURE.store(enabled, Ordering::SeqCst);
        if enabled {
            start(app);
        }
    }

    /// Перехват ставится один раз (и только когда клавиша действительно
    /// нужна — чтобы не спрашивать разрешение у тех, кто ею не пользуется).
    fn start(app: &AppHandle) {
        let _ = APP.set(app.clone());
        STARTED.get_or_init(|| {
            std::thread::spawn(|| unsafe {
                if !CGPreflightListenEventAccess() {
                    crate::logs::info("клавиша микрофона: прошу разрешение «Мониторинг ввода»");
                    CGRequestListenEventAccess();
                }
                let mask = (1u64 << KEY_DOWN)
                    | (1u64 << KEY_UP)
                    | (1u64 << FLAGS_CHANGED)
                    | (1u64 << OTHER_MOUSE_DOWN)
                    | (1u64 << OTHER_MOUSE_UP);
                let mut warned = false;
                let tap = loop {
                    let tap = CGEventTapCreate(
                        SESSION_TAP,
                        HEAD_INSERT,
                        LISTEN_ONLY,
                        mask,
                        callback,
                        std::ptr::null_mut(),
                    );
                    if !tap.is_null() {
                        break tap;
                    }
                    if !warned {
                        crate::logs::warn(
                            "клавиша микрофона не работает: нет разрешения «Мониторинг ввода» \
                             (Системные настройки → Конфиденциальность и безопасность)",
                        );
                        warned = true;
                    }
                    std::thread::sleep(Duration::from_secs(3));
                };
                crate::logs::info("клавиша микрофона: перехват клавиатуры включён");
                TAP.store(tap, Ordering::SeqCst);
                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
                CFRunLoopRun();
            });
        });
    }

    fn emit<T: serde::Serialize + Clone>(event: &str, payload: T) {
        if let Some(app) = APP.get() {
            let _ = app.emit(event, payload);
        }
    }

    fn handle(code: u32, down: bool) {
        if down && CAPTURE.swap(false, Ordering::SeqCst) {
            emit("ptt-captured", code);
            return;
        }
        let mute = MUTE_KEY.load(Ordering::SeqCst);
        if mute != 0 && mute == code && MUTE_DOWN.swap(down, Ordering::SeqCst) != down && down {
            emit("mute-toggle", ());
        }
        let key = KEY.load(Ordering::SeqCst);
        if key == 0 || key != code {
            return;
        }
        if PRESSED.swap(down, Ordering::SeqCst) != down {
            emit("ptt", down);
        }
    }

    /// Нажата ли клавиша-модификатор: по «левым/правым» битам флагов
    /// (`NX_DEVICE…KEYMASK`), а Caps Lock и Fn — по общим.
    fn modifier_down(mac: u16, flags: u64) -> Option<bool> {
        let bit = match mac {
            0x38 => 0x0000_0002, // левый Shift
            0x3C => 0x0000_0004, // правый Shift
            0x3B => 0x0000_0001, // левый Control
            0x3E => 0x0000_2000, // правый Control
            0x3A => 0x0000_0020, // левый Option
            0x3D => 0x0000_0040, // правый Option
            0x37 => 0x0000_0008, // левый Command
            0x36 => 0x0000_0010, // правый Command
            0x39 => 0x0001_0000, // Caps Lock
            0x3F => 0x0080_0000, // Fn
            _ => return None,
        };
        Some(flags & bit != 0)
    }

    extern "C" fn callback(_proxy: *mut c_void, kind: u32, event: *mut c_void, _user: *mut c_void) -> *mut c_void {
        unsafe {
            match kind {
                TAP_DISABLED_BY_TIMEOUT | TAP_DISABLED_BY_USER_INPUT => {
                    let tap = TAP.load(Ordering::SeqCst);
                    if !tap.is_null() {
                        CGEventTapEnable(tap, true);
                    }
                }
                KEY_DOWN | KEY_UP => {
                    if kind == KEY_DOWN && CGEventGetIntegerValueField(event, KEYBOARD_AUTOREPEAT) != 0 {
                        return event;
                    }
                    let mac = CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE) as u16;
                    handle(vk(mac), kind == KEY_DOWN);
                }
                FLAGS_CHANGED => {
                    let mac = CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE) as u16;
                    if let Some(down) = modifier_down(mac, CGEventGetFlags(event)) {
                        handle(vk(mac), down);
                    }
                }
                OTHER_MOUSE_DOWN | OTHER_MOUSE_UP => {
                    // 2 — средняя, 3 и 4 — боковые (как 3, 4 и 5 на Windows).
                    let button = CGEventGetIntegerValueField(event, MOUSE_BUTTON_NUMBER);
                    if (2..=4).contains(&button) {
                        handle(MOUSE | (button as u32 + 1), kind == OTHER_MOUSE_DOWN);
                    }
                }
                _ => {}
            }
        }
        event
    }

    /// Код клавиши macOS (kVK_…) → virtual-key code Windows.
    fn vk(mac: u16) -> u32 {
        const LETTERS: &[(u16, u8)] = &[
            (0x00, b'A'), (0x0B, b'B'), (0x08, b'C'), (0x02, b'D'), (0x0E, b'E'),
            (0x03, b'F'), (0x05, b'G'), (0x04, b'H'), (0x22, b'I'), (0x26, b'J'),
            (0x28, b'K'), (0x25, b'L'), (0x2E, b'M'), (0x2D, b'N'), (0x1F, b'O'),
            (0x23, b'P'), (0x0C, b'Q'), (0x0F, b'R'), (0x01, b'S'), (0x11, b'T'),
            (0x20, b'U'), (0x09, b'V'), (0x0D, b'W'), (0x07, b'X'), (0x10, b'Y'),
            (0x06, b'Z'),
            (0x1D, b'0'), (0x12, b'1'), (0x13, b'2'), (0x14, b'3'), (0x15, b'4'),
            (0x17, b'5'), (0x16, b'6'), (0x1A, b'7'), (0x1C, b'8'), (0x19, b'9'),
        ];
        if let Some(&(_, c)) = LETTERS.iter().find(|(m, _)| *m == mac) {
            return c as u32;
        }
        let code = match mac {
            // F1–F20
            0x7A => 0x70, 0x78 => 0x71, 0x63 => 0x72, 0x76 => 0x73, 0x60 => 0x74,
            0x61 => 0x75, 0x62 => 0x76, 0x64 => 0x77, 0x65 => 0x78, 0x6D => 0x79,
            0x67 => 0x7A, 0x6F => 0x7B, 0x69 => 0x7C, 0x6B => 0x7D, 0x71 => 0x7E,
            0x6A => 0x7F, 0x40 => 0x80, 0x4F => 0x81, 0x50 => 0x82, 0x5A => 0x83,
            // Модификаторы (Command — как клавиша Windows).
            0x38 => 0xA0, 0x3C => 0xA1, 0x3B => 0xA2, 0x3E => 0xA3,
            0x3A => 0xA4, 0x3D => 0xA5, 0x37 => 0x5B, 0x36 => 0x5C, 0x39 => 0x14,
            // Прочие.
            0x31 => 0x20, // пробел
            0x24 => 0x0D, // Return
            0x4C => 0x0D, // Enter на цифровой клавиатуре
            0x30 => 0x09, // Tab
            0x35 => 0x1B, // Esc
            0x33 => 0x08, // Delete (Backspace)
            0x75 => 0x2E, // Forward Delete
            0x73 => 0x24, 0x77 => 0x23, 0x74 => 0x21, 0x79 => 0x22, // Home End PgUp PgDn
            0x7B => 0x25, 0x7E => 0x26, 0x7C => 0x27, 0x7D => 0x28, // стрелки
            0x72 => 0x2D, // Help/Insert
            // Цифровая клавиатура.
            0x52 => 0x60, 0x53 => 0x61, 0x54 => 0x62, 0x55 => 0x63, 0x56 => 0x64,
            0x57 => 0x65, 0x58 => 0x66, 0x59 => 0x67, 0x5B => 0x68, 0x5C => 0x69,
            0x43 => 0x6A, 0x45 => 0x6B, 0x4E => 0x6D, 0x41 => 0x6E, 0x4B => 0x6F,
            // Знаки.
            0x29 => 0xBA, 0x18 => 0xBB, 0x2B => 0xBC, 0x1B => 0xBD, 0x2F => 0xBE,
            0x2C => 0xBF, 0x32 => 0xC0, 0x21 => 0xDB, 0x2A => 0xDC, 0x1E => 0xDD,
            0x27 => 0xDE, 0x0A => 0xE2,
            _ => MAC_KEY | mac as u32,
        };
        code
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use tauri::AppHandle;

    pub fn set_key(_app: &AppHandle, _key: Option<u32>) {}
    pub fn set_mute_key(_app: &AppHandle, _key: Option<u32>) {}
    pub fn capture(_app: &AppHandle, _enabled: bool) {}
}
