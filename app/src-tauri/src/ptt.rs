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
//! События для интерфейса:
//! - `ptt` — `true`/`false`: кнопка нажата/отпущена;
//! - `ptt-captured` — код кнопки, нажатой в режиме назначения.

use tauri::AppHandle;

#[tauri::command]
pub fn ptt_set_key(app: AppHandle, key: Option<u32>) {
    imp::set_key(&app, key);
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

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;

    pub fn set_key(_app: &AppHandle, _key: Option<u32>) {}
    pub fn capture(_app: &AppHandle, _enabled: bool) {}
}
