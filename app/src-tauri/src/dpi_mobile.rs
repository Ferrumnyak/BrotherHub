//! Ускорение YouTube на телефоне — пока нет (см. dpi.rs).

/// Адрес прокси обхода (на телефоне пока не бывает).
pub fn proxy() -> Option<String> {
    None
}

pub fn ytdlp_proxy(_cmd: &mut tokio::process::Command) {}
