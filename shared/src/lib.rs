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
    Join {
        room: String,
        name: String,
        /// Пароль сервера, если он задан.
        #[serde(default)]
        password: Option<String>,
        /// Пропуск из прошлого `Welcome` — вернуться на своё место после
        /// обрыва связи (тот же id, та же роль ведущего).
        #[serde(default)]
        resume: Option<String>,
    },
    /// Выйти из комнаты насовсем (без ожидания переподключения).
    Leave,
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
        /// Пропуск для возвращения после обрыва связи.
        token: String,
        /// `true` — вернулись на своё место после обрыва связи.
        resumed: bool,
        room: String,
        host: MemberId,
        members: Vec<Member>,
        playback: PlaybackState,
        /// Пропуск в голосовой канал комнаты (`None` — голос на сервере не настроен).
        voice: Option<VoiceAccess>,
    },
    MemberJoined {
        member: Member,
    },
    /// У участника пропала (`online: false`) или вернулась связь.
    MemberStatus {
        id: MemberId,
        online: bool,
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

/// Куда и с каким пропуском подключаться к голосовому серверу LiveKit.
/// Участник голосового канала опознаётся по `MemberId` (строкой).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceAccess {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Member {
    pub id: MemberId,
    pub name: String,
    /// `false` — связь пропала, ждём переподключения.
    #[serde(default = "yes")]
    pub online: bool,
}

fn yes() -> bool {
    true
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

#[cfg(test)]
mod tests {
    use super::*;

    // Формат сообщений должен совпадать с app/src/protocol.ts.

    #[test]
    fn client_messages_from_json() {
        let join: ClientMsg =
            serde_json::from_str(r#"{"type":"join","room":"r","name":"n"}"#).unwrap();
        assert!(matches!(
            join,
            ClientMsg::Join {
                password: None,
                resume: None,
                ..
            }
        ));

        let chat: ClientMsg = serde_json::from_str(r#"{"type":"chat","text":"привет"}"#).unwrap();
        assert!(matches!(chat, ClientMsg::Chat { text } if text == "привет"));

        let leave: ClientMsg = serde_json::from_str(r#"{"type":"leave"}"#).unwrap();
        assert!(matches!(leave, ClientMsg::Leave));

        let transfer: ClientMsg =
            serde_json::from_str(r#"{"type":"transfer_host","to":7}"#).unwrap();
        assert!(matches!(transfer, ClientMsg::TransferHost { to: 7 }));
    }

    #[test]
    fn server_messages_to_json() {
        let msg = ServerMsg::Playback {
            playback: PlaybackState {
                media: Some("https://example.com/v".into()),
                paused: false,
                position: 12.5,
            },
            action: Some(PlaybackAction::SetMedia),
            by: Some("Ferrum".into()),
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "playback");
        assert_eq!(v["action"], "set_media");
        assert_eq!(v["playback"]["position"], 12.5);

        let status = serde_json::to_value(ServerMsg::MemberStatus {
            id: 3,
            online: false,
        })
        .unwrap();
        assert_eq!(status["type"], "member_status");
    }

    #[test]
    fn member_online_by_default() {
        let m: Member = serde_json::from_str(r#"{"id":1,"name":"n"}"#).unwrap();
        assert!(m.online);
    }

    #[test]
    fn url_detection() {
        assert!(is_url("https://vkvideo.ru/video-1_2"));
        assert!(is_url("  HTTP://example.com"));
        assert!(!is_url("Interstellar.2014.mkv"));
        assert!(!is_url("httpfile.mkv"));
    }
}
