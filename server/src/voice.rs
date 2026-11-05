//! Голосовая связь через LiveKit.
//!
//! Сам звук идёт через сервер LiveKit, а наш сервер решает, кого туда
//! пускать: при входе в комнату выдаёт участнику короткоживущий пропуск
//! (JWT), а при выходе или исключении — выкидывает из голосового канала.
//!
//! Настройки (переменные окружения):
//! - `LIVEKIT_URL` — адрес LiveKit для клиентов, например `wss://example.com:7880`;
//! - `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — ключи из конфигурации LiveKit;
//! - `LIVEKIT_API_URL` — адрес API для сервера (по умолчанию тот же, что
//!   `LIVEKIT_URL`, только `http(s)://`).
//!
//! С флагом `--dev` используются значения `livekit-server --dev`.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use brotherwatch_shared::MemberId;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

/// Сколько живёт пропуск. Он нужен только для подключения: дальше
/// LiveKit сам продлевает его подключённым участникам.
const TOKEN_TTL_SECS: u64 = 5 * 60;

#[derive(Clone)]
pub struct LiveKit {
    /// Адрес для клиентов.
    pub url: String,
    api_url: String,
    key: String,
    secret: String,
}

impl LiveKit {
    /// Настройки из окружения. `None` — голос выключен.
    pub fn from_env(dev: bool) -> Option<Self> {
        let var = |name: &str, dev_value: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .or_else(|| dev.then(|| dev_value.to_string()))
        };
        let url = var("LIVEKIT_URL", "ws://127.0.0.1:7880")?;
        let (Some(key), Some(secret)) = (
            var("LIVEKIT_API_KEY", "devkey"),
            var("LIVEKIT_API_SECRET", "secret"),
        ) else {
            tracing::warn!(
                "LIVEKIT_URL задан, но нет LIVEKIT_API_KEY / LIVEKIT_API_SECRET — голос выключен"
            );
            return None;
        };
        // ws:// → http://, wss:// → https://
        let api_url = std::env::var("LIVEKIT_API_URL")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| url.replacen("ws", "http", 1));
        Some(Self {
            url,
            api_url,
            key,
            secret,
        })
    }

    /// Имя голосового канала для комнаты.
    fn room_name(room: &str) -> String {
        format!("bw-{room}")
    }

    /// Пропуск участника в голосовой канал комнаты: только эта комната,
    /// только микрофон.
    pub fn join_token(&self, room: &str, id: MemberId, name: &str) -> String {
        let now = unix_now();
        self.sign(json!({
            "iss": self.key,
            "sub": id.to_string(),
            "name": name,
            "nbf": now.saturating_sub(10),
            "exp": now + TOKEN_TTL_SECS,
            "video": {
                "room": Self::room_name(room),
                "roomJoin": true,
                "canPublish": true,
                "canSubscribe": true,
                "canPublishData": false,
                // Голос и показ экрана со звуком; камеры у нас нет.
                "canPublishSources": ["microphone", "screen_share", "screen_share_audio"],
            },
        }))
    }

    /// Выкинуть участника из голосового канала комнаты.
    pub async fn remove_participant(&self, room: &str, id: MemberId) {
        let now = unix_now();
        let token = self.sign(json!({
            "iss": self.key,
            "sub": "brotherwatch-server",
            "nbf": now.saturating_sub(10),
            "exp": now + 60,
            "video": { "room": Self::room_name(room), "roomAdmin": true },
        }));
        let url = format!(
            "{}/twirp/livekit.RoomService/RemoveParticipant",
            self.api_url.trim_end_matches('/')
        );
        let body = json!({ "room": Self::room_name(room), "identity": id.to_string() });
        match reqwest::Client::new()
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                tracing::info!("участник {id} убран из голосового канала «{room}»");
            }
            // 404 — его и так нет в голосовом канале.
            Ok(r) => tracing::debug!("LiveKit RemoveParticipant: {}", r.status()),
            Err(e) => tracing::warn!("не удалось обратиться к LiveKit ({url}): {e}"),
        }
    }

    /// JWT с подписью HS256.
    fn sign(&self, claims: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let message = format!("{header}.{payload}");
        let mut mac = Hmac::<Sha256>::new_from_slice(self.secret.as_bytes())
            .expect("HMAC принимает ключ любой длины");
        mac.update(message.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{message}.{signature}")
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
