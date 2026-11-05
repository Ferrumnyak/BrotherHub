//! Тесты сервера на настоящих подключениях: сервер запускается на
//! свободном порту, а «клиенты» говорят с ним по WebSocket.
//!
//! Запуск: `cargo test -p brotherwatch-server`

use std::time::Duration;

use brotherwatch_server::{serve, Config};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start(config: Config) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { serve(listener, config).await.unwrap() });
    format!("ws://{addr}/ws")
}

struct Client {
    ws: Ws,
}

impl Client {
    async fn connect(url: &str) -> Self {
        let (ws, _) = connect_async(url).await.unwrap();
        Self { ws }
    }

    async fn send(&mut self, msg: Value) {
        self.ws
            .send(Message::Text(msg.to_string().into()))
            .await
            .unwrap();
    }

    /// Следующее сообщение от сервера (или паника через 3 секунды).
    async fn next(&mut self) -> Value {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(3), self.ws.next())
                .await
                .expect("сервер молчит")
                .expect("соединение закрыто")
                .unwrap();
            if let Message::Text(text) = msg {
                return serde_json::from_str(text.as_str()).unwrap();
            }
        }
    }

    /// Ждать сообщение нужного типа, пропуская остальные.
    async fn expect(&mut self, kind: &str) -> Value {
        loop {
            let msg = self.next().await;
            if msg["type"] == kind {
                return msg;
            }
        }
    }

    async fn join(url: &str, room: &str, name: &str) -> (Self, Value) {
        let mut c = Self::connect(url).await;
        c.send(json!({"type": "join", "room": room, "name": name}))
            .await;
        let welcome = c.expect("welcome").await;
        (c, welcome)
    }
}

#[tokio::test]
async fn first_member_is_host_and_chat_reaches_everyone() {
    let url = start(Config::default()).await;
    let (mut a, wa) = Client::join(&url, "r", "Аня").await;
    assert_eq!(wa["host"], wa["you"]);
    assert_eq!(wa["resumed"], false);

    let (mut b, wb) = Client::join(&url, "r", "Боря").await;
    assert_eq!(wb["host"], wa["you"], "ведущий — тот, кто зашёл первым");
    assert_eq!(wb["members"].as_array().unwrap().len(), 2);
    assert_eq!(a.expect("member_joined").await["member"]["name"], "Боря");

    b.send(json!({"type": "chat", "text": "привет"})).await;
    for c in [&mut a, &mut b] {
        let chat = c.expect("chat").await;
        assert_eq!(chat["text"], "привет");
        assert_eq!(chat["name"], "Боря");
    }
}

#[tokio::test]
async fn only_host_controls_playback() {
    let url = start(Config::default()).await;
    let (mut a, _) = Client::join(&url, "r", "Аня").await;
    let (mut b, _) = Client::join(&url, "r", "Боря").await;

    b.send(json!({"type": "play", "position": 10.0})).await;
    let err = b.expect("error").await;
    assert!(err["message"].as_str().unwrap().contains("ведущий"));

    a.send(json!({"type": "set_media", "media": "https://example.com/v"}))
        .await;
    a.send(json!({"type": "play", "position": 5.0})).await;
    let pb = b.expect("playback").await;
    assert_eq!(pb["action"], "set_media");
    let pb = b.expect("playback").await;
    assert_eq!(pb["action"], "play");
    assert_eq!(pb["playback"]["paused"], false);
    assert!(pb["playback"]["position"].as_f64().unwrap() >= 5.0);
}

#[tokio::test]
async fn password_is_required() {
    let url = start(Config {
        password: Some("секрет".into()),
        ..Config::default()
    })
    .await;

    let mut c = Client::connect(&url).await;
    c.send(json!({"type": "join", "room": "r", "name": "Аня", "password": "не то"}))
        .await;
    assert!(c.expect("error").await["message"]
        .as_str()
        .unwrap()
        .contains("пароль"));

    c.send(json!({"type": "join", "room": "r", "name": "Аня", "password": "секрет"}))
        .await;
    c.expect("welcome").await;
}

#[tokio::test]
async fn host_role_passes_on_when_host_leaves() {
    let url = start(Config::default()).await;
    let (mut a, _) = Client::join(&url, "r", "Аня").await;
    let (mut b, wb) = Client::join(&url, "r", "Боря").await;

    a.send(json!({"type": "leave"})).await;
    let left = b.expect("member_left").await;
    assert_eq!(left["kicked"], false);
    let host = b.expect("host_changed").await;
    assert_eq!(host["host"], wb["you"]);
}

#[tokio::test]
async fn host_can_transfer_role_and_kick() {
    let url = start(Config::default()).await;
    let (mut a, _) = Client::join(&url, "r", "Аня").await;
    let (mut b, wb) = Client::join(&url, "r", "Боря").await;
    let (mut c, wc) = Client::join(&url, "r", "Вова").await;

    a.send(json!({"type": "kick", "id": wc["you"]})).await;
    assert_eq!(c.expect("kicked").await["by"], "Аня");
    let left = b.expect("member_left").await;
    assert_eq!(left["id"], wc["you"]);
    assert_eq!(left["kicked"], true);

    a.send(json!({"type": "transfer_host", "to": wb["you"]}))
        .await;
    assert_eq!(b.expect("host_changed").await["host"], wb["you"]);

    // Бывший ведущий больше не управляет.
    a.send(json!({"type": "pause", "position": 1.0})).await;
    a.expect("error").await;
}

#[tokio::test]
async fn member_can_come_back_after_connection_loss() {
    let url = start(Config::default()).await;
    let (a, wa) = Client::join(&url, "r", "Аня").await;
    let (mut b, wb) = Client::join(&url, "r", "Боря").await;

    // Связь у Ани пропала (без «leave»): место держится, а пульт сразу у Бори.
    drop(a);
    let status = b.expect("member_status").await;
    assert_eq!(status["id"], wa["you"]);
    assert_eq!(status["online"], false);
    assert_eq!(b.expect("host_changed").await["host"], wb["you"]);

    // Аня вернулась со своим пропуском — тот же id, но пульт остался у Бори.
    let mut a = Client::connect(&url).await;
    a.send(json!({
        "type": "join", "room": "r", "name": "Аня", "resume": wa["token"]
    }))
    .await;
    let back = a.expect("welcome").await;
    assert_eq!(back["resumed"], true);
    assert_eq!(back["you"], wa["you"]);
    assert_eq!(back["host"], wb["you"]);

    let status = b.expect("member_status").await;
    assert_eq!(status["online"], true);
}

#[tokio::test]
async fn place_is_freed_after_grace_period() {
    let url = start(Config {
        grace: Duration::from_millis(200),
        ..Config::default()
    })
    .await;
    let (a, wa) = Client::join(&url, "r", "Аня").await;
    let (mut b, wb) = Client::join(&url, "r", "Боря").await;

    drop(a);
    b.expect("member_status").await;
    // Пульт переходит сразу, место освобождается после grace.
    assert_eq!(b.expect("host_changed").await["host"], wb["you"]);
    let left = b.expect("member_left").await;
    assert_eq!(left["id"], wa["you"]);

    // Старый пропуск больше не действует — заходим как новый участник.
    let mut a = Client::connect(&url).await;
    a.send(json!({
        "type": "join", "room": "r", "name": "Аня", "resume": wa["token"]
    }))
    .await;
    let again = a.expect("welcome").await;
    assert_eq!(again["resumed"], false);
    assert_ne!(again["you"], wa["you"]);
}

#[tokio::test]
async fn chat_flood_is_limited() {
    let url = start(Config::default()).await;
    let (mut a, _) = Client::join(&url, "r", "Аня").await;

    for i in 0..15 {
        a.send(json!({"type": "chat", "text": format!("спам {i}")}))
            .await;
    }
    let err = a.expect("error").await;
    assert!(err["message"].as_str().unwrap().contains("часто"));
}

#[tokio::test]
async fn suggestions_roulette_and_clear() {
    let url = start(Config::default()).await;
    let (mut a, _) = Client::join(&url, "r", "Аня").await;
    let (mut b, _) = Client::join(&url, "r", "Боря").await;

    // Предлагать может любой; повтор не добавляется.
    b.send(json!({"type": "suggest", "media": "https://example.com/1"}))
        .await;
    let list = a.expect("suggestions").await;
    assert_eq!(list["list"][0]["name"], "Боря");
    b.send(json!({"type": "suggest", "media": "https://example.com/1"}))
        .await;
    assert!(b.expect("error").await["message"]
        .as_str()
        .unwrap()
        .contains("уже"));

    // Рулетку крутит только ведущий, выпадает то, что есть в списке.
    b.send(json!({"type": "spin"})).await;
    assert!(b.expect("error").await["message"]
        .as_str()
        .unwrap()
        .contains("ведущий"));
    a.send(json!({"type": "spin"})).await;
    let roulette = b.expect("roulette").await;
    assert_eq!(roulette["winner"], list["list"][0]["id"]);

    // Включили предложенное — оно пропало из списка.
    a.send(json!({"type": "set_media", "media": "https://example.com/1"}))
        .await;
    assert_eq!(b.expect("playback").await["action"], "set_media");
    assert_eq!(b.expect("suggestions").await["list"], json!([]));

    // «Открылось» доходит до всех, закрыть видео может ведущий.
    b.send(json!({"type": "loaded", "media": "https://example.com/1"}))
        .await;
    assert_eq!(a.expect("member_loaded").await["media"], "https://example.com/1");
    a.send(json!({"type": "clear_media"})).await;
    let pb = b.expect("playback").await;
    assert_eq!(pb["playback"]["media"], Value::Null);
}

#[tokio::test]
async fn voice_state_is_shared_and_kept() {
    let url = start(Config::default()).await;
    let (mut a, _) = Client::join(&url, "r", "Аня").await;
    a.send(json!({"type": "voice_state", "in_voice": true, "mic": false, "deaf": true}))
        .await;
    assert_eq!(a.expect("member_voice").await["deaf"], true);

    // Кто зашёл позже, видит значки сразу.
    let (_b, wb) = Client::join(&url, "r", "Боря").await;
    let anya = &wb["members"][0];
    assert_eq!(anya["in_voice"], true);
    assert_eq!(anya["mic"], false);
    assert_eq!(anya["deaf"], true);
}

#[tokio::test]
async fn host_role_passes_on_when_host_connection_drops() {
    let url = start(Config::default()).await;
    let (a, _) = Client::join(&url, "r", "Аня").await;
    let (mut b, wb) = Client::join(&url, "r", "Боря").await;

    // Связь у ведущего пропала (без «выхода») — пульт переходит сразу.
    drop(a);
    let changed = b.expect("host_changed").await;
    assert_eq!(changed["host"], wb["you"]);
}

#[tokio::test]
async fn roulette_respects_weights() {
    let url = start(Config::default()).await;
    let (mut a, _) = Client::join(&url, "r", "Аня").await;
    a.send(json!({"type": "suggest", "media": "https://example.com/1"}))
        .await;
    a.send(json!({"type": "suggest", "media": "https://example.com/2"}))
        .await;
    let list = loop {
        let msg = a.expect("suggestions").await;
        if msg["list"].as_array().unwrap().len() == 2 {
            break msg;
        }
    };
    let second = list["list"][1]["id"].as_u64().unwrap();
    let first = list["list"][0]["id"].as_u64().unwrap();
    for _ in 0..5 {
        a.send(json!({"type": "spin", "weights": [[first, 0.0], [second, 1.0]]}))
            .await;
        assert_eq!(a.expect("roulette").await["winner"], second);
    }
}
