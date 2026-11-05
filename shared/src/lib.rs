//! Протокол BrotherWatch.
//!
//! Клиент и сервер обмениваются JSON-сообщениями по WebSocket.
//! Каждое сообщение — объект с полем `type`, например:
//! `{"type":"chat","text":"привет"}`.
//!
//! Если меняешь что-то здесь — поменяй и `app/src/protocol.ts`.

use serde::{Deserialize, Serialize};

/// Идентификатор участника, выдаётся сервером при подключении.
pub type MemberId = u64;

/// Сообщения от клиента к серверу.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Войти в комнату (создаётся автоматически, если её нет).
    Join { room: String, name: String },
    /// Сообщение в текстовый чат.
    Chat { text: String },

    // --- Только для главы лобби ---
    /// Выбрать, что смотрим (название файла или ссылка).
    SetMedia { media: String },
    /// Запустить воспроизведение с позиции (в секундах).
    Play { position: f64 },
    /// Поставить на паузу на позиции (в секундах).
    Pause { position: f64 },
    /// Перемотать на позицию (в секундах).
    Seek { position: f64 },
    /// Регулярный отчёт главы о позиции, чтобы остальные не уезжали.
    Sync { position: f64, paused: bool },
    /// Передать роль главы другому участнику.
    TransferHost { to: MemberId },
    /// Исключить участника из комнаты.
    Kick { id: MemberId },
}

/// Сообщения от сервера к клиенту.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Ответ на успешный вход в комнату.
    Welcome {
        you: MemberId,
        room: String,
        host: MemberId,
        members: Vec<Member>,
        playback: PlaybackState,
    },
    MemberJoined {
        member: Member,
    },
    /// Участник ушёл сам (`kicked: false`) или его исключили.
    MemberLeft {
        id: MemberId,
        kicked: bool,
    },
    /// Тебя исключили из комнаты.
    Kicked {
        by: String,
    },
    /// Сменился глава лобби.
    HostChanged {
        host: MemberId,
    },
    Chat {
        from: MemberId,
        name: String,
        text: String,
    },
    /// Новое состояние воспроизведения.
    /// `action` и `by` пустые, если это просто регулярная синхронизация.
    Playback {
        playback: PlaybackState,
        action: Option<PlaybackAction>,
        by: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackAction {
    SetMedia,
    Play,
    Pause,
    Seek,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Member {
    pub id: MemberId,
    pub name: String,
}

/// Общее для комнаты состояние воспроизведения.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaybackState {
    /// Что смотрим: имя файла или ссылка. `None` — пока ничего не выбрано.
    pub media: Option<String>,
    pub paused: bool,
    /// Позиция в секундах на момент отправки сообщения.
    pub position: f64,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            media: None,
            paused: true,
            position: 0.0,
        }
    }
}

/// Является ли `media` ссылкой (а не именем локального файла).
pub fn is_url(media: &str) -> bool {
    let m = media.trim_start().to_ascii_lowercase();
    m.starts_with("http://") || m.starts_with("https://")
}
