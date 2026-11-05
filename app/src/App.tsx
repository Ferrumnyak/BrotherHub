import { FormEvent, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  isUrl,
  type ClientMsg,
  type Member,
  type MemberId,
  type PlaybackState,
  type PlayerStatus,
  type ServerMsg,
} from "./protocol";

type ChatLine =
  | { key: number; kind: "chat"; name: string; text: string; mine: boolean }
  | { key: number; kind: "system"; text: string };

const DEFAULT_SERVER = "ws://127.0.0.1:8080";

const VIDEO_EXTENSIONS = [
  "mkv", "mp4", "avi", "mov", "webm", "m4v", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg",
];

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* не страшно, просто не запомним */
  }
}

function send(msg: ClientMsg) {
  return invoke("send", { msg });
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Выбрать видеофайл в стандартном окне Windows. */
async function pickVideoFile(): Promise<string | null> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Видео", extensions: VIDEO_EXTENSIONS },
      { name: "Все файлы", extensions: ["*"] },
    ],
  });
  return typeof path === "string" ? path : null;
}

export default function App() {
  const [server, setServer] = useState(() => load("server", DEFAULT_SERVER));
  const [name, setName] = useState(() => load("name", ""));
  const [room, setRoom] = useState(() => load("room", "brotherhood"));
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [joinedRoom, setJoinedRoom] = useState<string | null>(null);
  const [me, setMe] = useState<MemberId | null>(null);
  const [host, setHost] = useState<MemberId | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [player, setPlayer] = useState<PlayerStatus>({ running: false, loaded: null });
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [url, setUrl] = useState("");

  const meRef = useRef<MemberId | null>(null);
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  const keyRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const isHost = me !== null && me === host;

  // Подписка на события от Rust-части приложения.
  useEffect(() => {
    const nextKey = () => ++keyRef.current;
    const system = (text: string) =>
      setLines((l) => [...l, { key: nextKey(), kind: "system", text }]);
    const nameOf = (id: MemberId) =>
      membersRef.current.find((m) => m.id === id)?.name ?? "кто-то";

    const onMessage = (msg: ServerMsg) => {
      switch (msg.type) {
        case "welcome": {
          meRef.current = msg.you;
          setMe(msg.you);
          setHost(msg.host);
          setJoinedRoom(msg.room);
          setMembers(msg.members);
          setPlayback(msg.playback);
          setLines([]);
          system(`Ты в комнате «${msg.room}»`);
          if (msg.host === msg.you) system("👑 Ты глава лобби");
          break;
        }
        case "member_joined":
          setMembers((m) => [...m, msg.member]);
          system(`${msg.member.name} зашёл`);
          break;
        case "member_left":
          system(`${nameOf(msg.id)} ${msg.kicked ? "исключён из комнаты" : "вышел"}`);
          setMembers((m) => m.filter((x) => x.id !== msg.id));
          break;
        case "kicked":
          invoke("disconnect");
          setJoinedRoom(null);
          setError(`Тебя исключил из комнаты ${msg.by}`);
          break;
        case "host_changed":
          setHost(msg.host);
          system(
            msg.host === meRef.current
              ? "👑 Теперь ты глава лобби"
              : `👑 Теперь глава лобби — ${nameOf(msg.host)}`,
          );
          break;
        case "chat":
          setLines((l) => [
            ...l,
            {
              key: nextKey(),
              kind: "chat",
              name: msg.name,
              text: msg.text,
              mine: msg.from === meRef.current,
            },
          ]);
          break;
        case "playback": {
          setPlayback(msg.playback);
          const at = formatTime(msg.playback.position);
          const by = msg.by ?? "";
          switch (msg.action) {
            case "set_media":
              system(`${by} включил «${msg.playback.media ?? ""}»`);
              break;
            case "play":
              system(`▶ ${by} запустил (${at})`);
              break;
            case "pause":
              system(`⏸ ${by} поставил на паузу (${at})`);
              break;
            case "seek":
              system(`⏩ ${by} перемотал на ${at}`);
              break;
          }
          break;
        }
        case "error":
          setError(msg.message);
          break;
      }
    };

    let active = true;
    const unlisteners: Array<() => void> = [];
    const keep = (unlisten: () => void) => (active ? unlisteners.push(unlisten) : unlisten());

    listen<ServerMsg>("server-message", (e) => onMessage(e.payload)).then(keep);
    listen<PlayerStatus>("player-status", (e) => setPlayer(e.payload)).then(keep);
    listen<string>("player-error", (e) => setError(e.payload)).then(keep);
    listen("disconnected", () => {
      setJoinedRoom(null);
      setError("Соединение с сервером потеряно");
    }).then(keep);

    invoke<PlayerStatus>("player_status").then((s) => active && setPlayer(s));

    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    save("server", server);
    save("name", name);
    save("room", room);
    try {
      await invoke("connect", { server, room, name });
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleLeave() {
    await invoke("disconnect");
    setJoinedRoom(null);
    setMembers([]);
    setPlayback(null);
    setHost(null);
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await run(() => send({ type: "chat", text }));
  }

  async function handleOpenFile() {
    const path = await pickVideoFile();
    if (path) await run(() => invoke("open_file", { path }));
  }

  async function handleOpenUrl(e: FormEvent) {
    e.preventDefault();
    const link = url.trim();
    if (!link) return;
    await run(() => invoke("open_url", { url: link }));
    setUrl("");
  }

  async function handleTransfer(m: Member) {
    if (await ask(`Передать роль главы лобби игроку ${m.name}?`, { title: "BrotherWatch" })) {
      await run(() => send({ type: "transfer_host", to: m.id }));
    }
  }

  async function handleKick(m: Member) {
    if (await ask(`Исключить ${m.name} из комнаты?`, { title: "BrotherWatch", kind: "warning" })) {
      await run(() => send({ type: "kick", id: m.id }));
    }
  }

  if (!joinedRoom) {
    return (
      <main className="login">
        <form className="card" onSubmit={handleConnect}>
          <h1>BrotherWatch</h1>
          <p className="muted">Смотрим вместе</p>
          <label>
            Сервер
            <input value={server} onChange={(e) => setServer(e.target.value)} required />
          </label>
          <label>
            Комната
            <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={32} required />
          </label>
          <label>
            Ник
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              placeholder="Как тебя называть"
              required
              autoFocus
            />
          </label>
          <button type="submit" disabled={connecting}>
            {connecting ? "Подключаюсь…" : "Войти"}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </main>
    );
  }

  const media = playback?.media ?? null;
  const hostName = members.find((m) => m.id === host)?.name;
  const needsFile = !isHost && media !== null && !isUrl(media) && player.loaded !== media;
  const needsReopen = !isHost && media !== null && isUrl(media) && !player.running;

  return (
    <main className="room">
      <header>
        <h2>{joinedRoom}</h2>
        <button className="secondary" onClick={handleLeave}>
          Выйти
        </button>
      </header>

      <section className="stage">
        <div className="now-playing">
          {media ? (
            <>
              <div className="media-title">{media}</div>
              <div className="muted">
                {playback?.paused ? "⏸ На паузе" : "▶ Идёт"}
                {player.running ? "" : " · плеер закрыт"}
              </div>
            </>
          ) : (
            <div className="muted">
              {isHost
                ? "Выбери, что смотрим: файл или ссылку"
                : `Ждём, пока ${hostName ?? "глава лобби"} выберет, что смотрим`}
            </div>
          )}

          {needsFile && (
            <div className="prompt">
              <p>Открой у себя этот же фильм или серию</p>
              <button onClick={handleOpenFile}>Выбрать файл</button>
            </div>
          )}
          {needsReopen && (
            <div className="prompt">
              <button onClick={() => run(() => invoke("open_url", { url: media }))}>
                Открыть плеер снова
              </button>
            </div>
          )}
          {!isHost && media && !isUrl(media) && player.loaded === media && !player.running && (
            <div className="prompt">
              <button onClick={handleOpenFile}>Открыть файл снова</button>
            </div>
          )}

          {isHost && (
            <div className="host-controls">
              <button onClick={handleOpenFile}>📁 Открыть файл</button>
              <form onSubmit={handleOpenUrl}>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Ссылка: YouTube, VK Видео, Rutube…"
                />
                <button type="submit">Открыть</button>
              </form>
              <p className="muted small">
                Управляй просмотром прямо в окне плеера: пробел — пауза, стрелки — перемотка.
              </p>
            </div>
          )}
        </div>

        <div className="members">
          <h3>В комнате · {members.length}</h3>
          <ul>
            {members.map((m) => (
              <li key={m.id}>
                {m.id === host && <span title="Глава лобби">👑 </span>}
                {m.name}
                {m.id === me && <span className="muted"> (ты)</span>}
                {isHost && m.id !== me && (
                  <span className="member-actions">
                    <button
                      className="icon"
                      title="Сделать главой лобби"
                      onClick={() => handleTransfer(m)}
                    >
                      👑
                    </button>
                    <button className="icon" title="Исключить" onClick={() => handleKick(m)}>
                      ✕
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <aside className="chat">
        <div className="lines">
          {lines.map((l) =>
            l.kind === "system" ? (
              <div key={l.key} className="line system">
                {l.text}
              </div>
            ) : (
              <div key={l.key} className={l.mine ? "line mine" : "line"}>
                <span className="author">{l.name}</span>
                <span>{l.text}</span>
              </div>
            ),
          )}
          <div ref={chatEndRef} />
        </div>
        {error && (
          <p className="error" onClick={() => setError(null)} title="Скрыть">
            {error}
          </p>
        )}
        <form className="composer" onSubmit={handleSend}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Сообщение…"
            maxLength={2000}
          />
          <button type="submit">➤</button>
        </form>
      </aside>
    </main>
  );
}
