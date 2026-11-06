//! Протокол BrotherHub.
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
        /// Аватарка: `emoji:🍿` или `color:3`.
        #[serde(default)]
        avatar: Option<String>,
        /// Постоянный случайный номер устройства. Кто создал комнату,
        /// тот её хозяин: вернувшись, он снова получает пульт.
        #[serde(default)]
        device: Option<String>,
    },
    /// Выйти из комнаты насовсем (без ожидания переподключения).
    Leave,
    /// Сообщение в текстовый чат (`reply` — ответ на чьё-то сообщение).
    Chat {
        text: String,
        #[serde(default)]
        reply: Option<ChatReply>,
    },
    /// Я печатаю — чтобы остальные видели «… печатает».
    Typing,
    /// Мой статус («отошёл») и аватарка. `None` — без статуса / как по умолчанию.
    Profile {
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        avatar: Option<String>,
    },
    /// Предложить сразу несколько (серии из плейлиста).
    SuggestMany { media: Vec<String> },
    /// Предложить, что посмотреть (ссылку или название файла).
    Suggest { media: String },
    /// Убрать предложение (своё — любой, чужое — только ведущий).
    RemoveSuggestion { id: u64 },
    /// У меня открылось это видео — для автозапуска, когда готовы все.
    Loaded { media: String },
    /// Мой микрофон и звук — чтобы остальные видели значки в списке.
    VoiceState { in_voice: bool, mic: bool, deaf: bool },
    /// Реакция — эмодзи, пролетающий поверх видео у всех.
    React { emoji: String },
    /// Запустить рулетку по списку предложений (может любой): через минуту
    /// сервер сам её крутит. `weights` — шансы (id → вес, по умолчанию у всех 1).
    Spin {
        #[serde(default)]
        weights: Vec<(u64, f64)>,
        /// Крутить сразу, без отсчёта.
        #[serde(default)]
        now: bool,
        #[serde(default)]
        key: Option<String>,
    },
    /// Отменить рулетку до того, как она закрутилась (ведущий или кто запустил).
    CancelRoulette,
    /// Тайно задать шансы рулетки (id предложения → вес). Пустой список —
    /// убрать свою подкрутку. Никому не пересылается.
    Rig {
        weights: Vec<(u64, f64)>,
        #[serde(default)]
        key: Option<String>,
    },

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
    /// Закрыть видео у всех.
    ClearMedia,
    /// Субтитры к текущему видео для всех (`None` — убрать).
    SetSubtitles { subtitles: Option<SubtitleFile> },
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
        /// Что предложили посмотреть.
        #[serde(default)]
        suggestions: Vec<Suggestion>,
        /// Субтитры к текущему видео, если ведущий их добавил.
        #[serde(default)]
        subtitles: Option<SubtitleFile>,
        /// Рулетка уже запущена: сколько секунд до кручения и кто запустил.
        #[serde(default)]
        roulette: Option<RouletteCountdown>,
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
        #[serde(default)]
        reply: Option<ChatReply>,
    },
    /// Участник печатает.
    Typing {
        id: MemberId,
    },
    /// Участник сменил статус или аватарку.
    MemberProfile {
        id: MemberId,
        status: Option<String>,
        avatar: Option<String>,
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
    /// Список предложений изменился (присылается целиком).
    Suggestions {
        list: Vec<Suggestion>,
    },
    /// Ведущий крутанул рулетку — выпало предложение `winner`.
    Roulette {
        winner: u64,
        by: String,
    },
    /// У участника открылось видео `media`.
    MemberLoaded {
        id: MemberId,
        media: String,
    },
    /// Участник включил или выключил микрофон или звук.
    MemberVoice {
        id: MemberId,
        in_voice: bool,
        mic: bool,
        deaf: bool,
    },
    /// Кто-то отправил реакцию.
    Reaction {
        from: MemberId,
        name: String,
        emoji: String,
    },
    /// Ведущий добавил (`Some`) или убрал (`None`) субтитры к видео.
    Subtitles {
        subtitles: Option<SubtitleFile>,
    },
    /// Рулетку запустили — закрутится через `seconds` секунд.
    RouletteCountdown {
        seconds: f64,
        by: String,
    },
    /// Рулетку отменили (`by` — кто; `None` — некому крутить: список опустел).
    RouletteCancelled {
        by: Option<String>,
    },
}

/// На какое сообщение ответили: кто написал и начало текста.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatReply {
    pub name: String,
    pub text: String,
}

/// Отсчёт до кручения рулетки.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RouletteCountdown {
    pub seconds: f64,
    pub by: String,
}

/// Файл субтитров, который ведущий раздаёт всем (.srt, .vtt, .ass).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubtitleFile {
    /// Имя файла — по нему видно, что это за субтитры, и из него берётся формат.
    pub name: String,
    /// Содержимое в UTF-8.
    pub text: String,
}

/// Предложение, что посмотреть.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Suggestion {
    pub id: u64,
    pub media: String,
    /// Кто предложил.
    pub by: MemberId,
    pub name: String,
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
    /// Подключён к голосу.
    #[serde(default)]
    pub in_voice: bool,
    /// Микрофон включён.
    #[serde(default)]
    pub mic: bool,
    /// Выключил себе звук от всех.
    #[serde(default)]
    pub deaf: bool,
    /// Статус: «отошёл», «смотрю краем глаза»…
    #[serde(default)]
    pub status: Option<String>,
    /// Аватарка: `emoji:🍿` или `color:3` (`None` — буква на цветном круге).
    #[serde(default)]
    pub avatar: Option<String>,
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
        assert!(matches!(chat, ClientMsg::Chat { text, reply: None } if text == "привет"));
        let reply: ClientMsg = serde_json::from_str(
            r#"{"type":"chat","text":"да","reply":{"name":"Аня","text":"идём?"}}"#,
        )
        .unwrap();
        assert!(matches!(reply, ClientMsg::Chat { reply: Some(r), .. } if r.name == "Аня"));
        let typing: ClientMsg = serde_json::from_str(r#"{"type":"typing"}"#).unwrap();
        assert!(matches!(typing, ClientMsg::Typing));

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
    fn new_messages_round_trip() {
        let spin: ClientMsg = serde_json::from_str(r#"{"type":"spin"}"#).unwrap();
        assert!(matches!(spin, ClientMsg::Spin { weights, now: false, .. } if weights.is_empty()));
        let rigged: ClientMsg =
            serde_json::from_str(r#"{"type":"spin","weights":[[3,5.0]]}"#).unwrap();
        assert!(matches!(rigged, ClientMsg::Spin { weights, .. } if weights == vec![(3, 5.0)]));
        let clear: ClientMsg = serde_json::from_str(r#"{"type":"clear_media"}"#).unwrap();
        assert!(matches!(clear, ClientMsg::ClearMedia));
        let voice: ClientMsg =
            serde_json::from_str(r#"{"type":"voice_state","in_voice":true,"mic":false,"deaf":true}"#)
                .unwrap();
        assert!(matches!(
            voice,
            ClientMsg::VoiceState {
                in_voice: true,
                mic: false,
                deaf: true
            }
        ));
        let v = serde_json::to_value(ServerMsg::Roulette {
            winner: 4,
            by: "Ferrum".into(),
        })
        .unwrap();
        assert_eq!(v["type"], "roulette");
        assert_eq!(v["winner"], 4);
    }

    #[test]
    fn reactions_and_subtitles() {
        let react: ClientMsg = serde_json::from_str(r#"{"type":"react","emoji":"🔥"}"#).unwrap();
        assert!(matches!(react, ClientMsg::React { emoji } if emoji == "🔥"));
        let subs: ClientMsg = serde_json::from_str(
            r#"{"type":"set_subtitles","subtitles":{"name":"a.srt","text":"1"}}"#,
        )
        .unwrap();
        assert!(matches!(subs, ClientMsg::SetSubtitles { subtitles: Some(f) } if f.name == "a.srt"));
        let off: ClientMsg =
            serde_json::from_str(r#"{"type":"set_subtitles","subtitles":null}"#).unwrap();
        assert!(matches!(off, ClientMsg::SetSubtitles { subtitles: None }));
        let v = serde_json::to_value(ServerMsg::Reaction {
            from: 1,
            name: "Ferrum".into(),
            emoji: "😂".into(),
        })
        .unwrap();
        assert_eq!(v["type"], "reaction");
    }

    #[test]
    fn url_detection() {
        assert!(is_url("https://vkvideo.ru/video-1_2"));
        assert!(is_url("  HTTP://example.com"));
        assert!(!is_url("Interstellar.2014.mkv"));
        assert!(!is_url("httpfile.mkv"));
    }
}
