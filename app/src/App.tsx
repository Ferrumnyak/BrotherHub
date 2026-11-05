import { FormEvent, ReactElement, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  isUrl,
  type ClientMsg,
  type Member,
  type MemberId,
  type PlaybackState,
  type PlayerKey,
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
  const [chatOpen, setChatOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const meRef = useRef<MemberId | null>(null);
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  const keyRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef(false);
  fullscreenRef.current = fullscreen;

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
    listen<PlayerKey>("player-key", (e) => onKeyRef.current(e.payload)).then(keep);
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
    if (fullscreen) await applyFullscreen(false);
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

  // ----- Полный экран и панель чата -----

  async function applyFullscreen(next: boolean) {
    try {
      await getCurrentWindow().setFullscreen(next);
    } catch (err) {
      setError(String(err));
      return;
    }
    setFullscreen(next);
    setChatOpen(!next);
  }

  const onKey = (key: PlayerKey) => {
    if (key === "fullscreen") applyFullscreen(!fullscreenRef.current);
    else if (key === "exit-fullscreen") {
      if (fullscreenRef.current) applyFullscreen(false);
    } else if (key === "toggle-chat") setChatOpen((open) => !open);
  };
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  // Те же клавиши, когда фокус в интерфейсе (а не в окне видео).
  useEffect(() => {
    if (!joinedRoom) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (e.key === "Escape") {
        onKeyRef.current("exit-fullscreen");
      } else if (e.key === "Tab" && !typing) {
        e.preventDefault();
        onKeyRef.current("toggle-chat");
      } else if (e.code === "KeyF" && !typing && !e.ctrlKey && !e.altKey) {
        onKeyRef.current("fullscreen");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [joinedRoom]);

  // Сообщения поверх видео, пока панель чата скрыта.
  useEffect(() => {
    invoke("set_chat_overlay", { enabled: joinedRoom !== null && !chatOpen }).catch(() => {});
  }, [joinedRoom, chatOpen]);

  // Окно видео mpv лежит поверх области .video — сообщаем, где она.
  useEffect(() => {
    const el = videoRef.current;
    const show = joinedRoom !== null && player.running && el !== null;
    const update = () => {
      if (!show || !el) {
        invoke("set_video_rect", { rect: null }).catch(() => {});
        return;
      }
      const r = el.getBoundingClientRect();
      const k = window.devicePixelRatio || 1;
      invoke("set_video_rect", {
        rect: {
          x: Math.round(r.left * k),
          y: Math.round(r.top * k),
          width: Math.round(r.width * k),
          height: Math.round(r.height * k),
        },
      }).catch(() => {});
    };
    update();
    if (!show || !el) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      invoke("set_video_rect", { rect: null }).catch(() => {});
    };
  }, [joinedRoom, player.running, chatOpen, fullscreen]);

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
  const needsReopen = !isHost && media !== null && player.loaded === media && !player.running;

  const roomClass = ["room", fullscreen && "fullscreen", !chatOpen && "chat-hidden"]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={roomClass}>
      {!fullscreen && (
        <header>
          <div className="title">
            <span className="brand">BrotherWatch</span>
            <span className="muted">/</span>
            <span>{joinedRoom}</span>
          </div>
          <div className="actions">
            <button className="secondary" onClick={() => setChatOpen((o) => !o)} title="Tab">
              <Icon name="panel" />
              {chatOpen ? "Скрыть чат" : "Показать чат"}
            </button>
            <button className="secondary" onClick={() => applyFullscreen(true)} title="F">
              <Icon name="fullscreen" />
              Полный экран
            </button>
            <button className="secondary" onClick={handleLeave}>
              Выйти
            </button>
          </div>
        </header>
      )}

      <div className="body">
        <section className="stage">
          {!fullscreen && isHost && (
            <div className="toolbar">
              <button onClick={handleOpenFile}>
                <Icon name="folder" />
                Открыть файл
              </button>
              <form onSubmit={handleOpenUrl}>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Ссылка: YouTube, VK Видео, Rutube…"
                  aria-label="Ссылка на видео"
                />
                <button type="submit" className="secondary">
                  Открыть
                </button>
              </form>
            </div>
          )}
          {!fullscreen && needsFile && (
            <div className="toolbar notice">
              <span>
                {hostName ?? "Глава лобби"} включил «{media}». Открой у себя этот же фильм или серию.
              </span>
              <button onClick={handleOpenFile}>
                <Icon name="folder" />
                Выбрать файл
              </button>
            </div>
          )}
          {!fullscreen && needsReopen && (
            <div className="toolbar notice">
              <span>Плеер закрыт.</span>
              <button
                onClick={() =>
                  media && isUrl(media) ? run(() => invoke("open_url", { url: media })) : handleOpenFile()
                }
              >
                Открыть снова
              </button>
            </div>
          )}

          <div className="video" ref={videoRef}>
            <div className="video-placeholder">
              <Icon name="screen" size={56} />
              <span>
                {media
                  ? player.running
                    ? "Загрузка видео…"
                    : `Сейчас смотрят «${media}»`
                  : isHost
                    ? "Выбери, что смотрим: файл или ссылку"
                    : `Ждём, пока ${hostName ?? "глава лобби"} выберет, что смотрим`}
              </span>
            </div>
          </div>

          {!fullscreen && (
            <div className="statusbar">
              <span className={media ? "dot on" : "dot"} />
              <span className="media-name">{media ?? "Ничего не выбрано"}</span>
              {media && (
                <span className="muted">· {playback?.paused ? "на паузе" : "идёт"}</span>
              )}
              <span className="spacer" />
              {error && !chatOpen ? (
                <span className="error small" onClick={() => setError(null)} title="Скрыть">
                  {error}
                </span>
              ) : (
                <span className="muted small">F — полный экран · Tab — чат</span>
              )}
            </div>
          )}
        </section>

        {chatOpen && (
          <aside className="side">
            <div className="members">
              <h3>В комнате · {members.length}</h3>
              <ul>
                {members.map((m) => (
                  <li key={m.id}>
                    <span className="crown-slot">
                      {m.id === host && <Icon name="crown" label="Глава лобби" accent />}
                    </span>
                    <span className="member-name">{m.name}</span>
                    {m.id === me && <span className="muted"> (ты)</span>}
                    {isHost && m.id !== me && (
                      <span className="member-actions">
                        <button
                          className="icon"
                          aria-label={`Сделать ${m.name} главой лобби`}
                          title="Сделать главой лобби"
                          onClick={() => handleTransfer(m)}
                        >
                          <Icon name="crown" />
                        </button>
                        <button
                          className="icon"
                          aria-label={`Исключить ${m.name}`}
                          title="Исключить"
                          onClick={() => handleKick(m)}
                        >
                          <Icon name="close" />
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

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
                aria-label="Сообщение"
                maxLength={2000}
              />
              <button type="submit" aria-label="Отправить">
                <Icon name="send" />
              </button>
            </form>
          </aside>
        )}
      </div>
    </main>
  );
}

type IconName = "panel" | "fullscreen" | "folder" | "screen" | "crown" | "close" | "send";

const ICON_PATHS: Record<IconName, ReactElement> = {
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </>
  ),
  fullscreen: (
    <>
      <polyline points="4 9 4 4 9 4" />
      <polyline points="20 9 20 4 15 4" />
      <polyline points="4 15 4 20 9 20" />
      <polyline points="20 15 20 20 15 20" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  screen: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polygon points="10 9 15 12 10 15 10 9" />
    </>
  ),
  crown: <path d="M3 18h18l-2-11-5 5-2-7-2 7-5-5z" />,
  close: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  send: (
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </>
  ),
};

function Icon({
  name,
  size = 16,
  label,
  accent = false,
}: {
  name: IconName;
  size?: number;
  label?: string;
  accent?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={accent ? "var(--accent)" : "currentColor"}
      strokeWidth={size > 24 ? 1.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
