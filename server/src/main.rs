//! Запуск сервера BrotherWatch.
//!
//! Настройки — переменные окружения:
//! - `BROTHERWATCH_ADDR` — адрес (по умолчанию `0.0.0.0:8080`);
//! - `BROTHERWATCH_PASSWORD` — пароль для входа (по умолчанию без пароля);
//! - `LIVEKIT_*` — голосовая связь, см. [`brotherwatch_server::voice`].
//!
//! `--dev` — режим разработки: голос через `livekit-server --dev` на этом ПК.

use brotherwatch_server::{serve, voice::LiveKit, Config};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let dev = std::env::args().any(|a| a == "--dev");
    let addr = std::env::var("BROTHERWATCH_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let config = Config {
        password: std::env::var("BROTHERWATCH_PASSWORD")
            .ok()
            .filter(|p| !p.is_empty()),
        livekit: LiveKit::from_env(dev),
        special_key: std::env::var("BROTHERWATCH_SPECIAL_KEY")
            .ok()
            .filter(|k| !k.is_empty()),
        ..Config::default()
    };

    if config.password.is_none() {
        tracing::warn!(
            "пароль не задан (BROTHERWATCH_PASSWORD) — войти может любой, кто знает адрес"
        );
    }
    match &config.livekit {
        Some(lk) => tracing::info!("голосовая связь: {}", lk.url),
        None => tracing::warn!(
            "голосовая связь выключена (нет LIVEKIT_URL; для разработки — флаг --dev)"
        ),
    }

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("не удалось занять адрес {addr}: {e}"));
    tracing::info!("BrotherWatch server слушает {addr}");
    serve(listener, config).await.expect("сервер упал");
}
