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
    /// Выбрать, что смотрим (название файла или ссылка).
    SetMedia { media: String },
    /// Запустить воспроизведение с позиции (в секундах).
    Play { position: f64 },
    /// Поставить на паузу на позиции (в секундах).
    Pause { position: f64 },
    /// Перемотать на позицию (в секундах).
    Seek { position: f64 },
}

/// Сообщения от сервера к клиенту.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Ответ на успешный вход в комнату.
    Welcome {
        you: MemberId,
        room: String,
        members: Vec<Member>,
        playback: PlaybackState,
    },
    MemberJoined { member: Member },
    MemberLeft { id: MemberId },
    Chat {
        from: MemberId,
        name: String,
        text: String,
    },
    /// Состояние воспроизведения изменилось (кто-то нажал play/pause/перемотал).
    Playback {
        playback: PlaybackState,
        by: String,
    },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Member {
    pub id: MemberId,
    pub name: String,
}

/// Общее для комнаты состояние воспроизведения.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaybackState {
    /// Что смотрим. `None` — пока ничего не выбрано.
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
