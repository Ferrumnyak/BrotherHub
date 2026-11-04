import { FormEvent, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClientMsg, Member, MemberId, PlaybackState, ServerMsg } from "./protocol";

type ChatLine =
  | { key: number; kind: "chat"; name: string; text: string; mine: boolean }
  | { key: number; kind: "system"; text: string };

const DEFAULT_SERVER = "ws://127.0.0.1:8080";

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

export default function App() {
  const [server, setServer] = useState(() => load("server", DEFAULT_SERVER));
  const [name, setName] = useState(() => load("name", ""));
  const [room, setRoom] = useState(() => load("room", "brotherhood"));
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [joinedRoom, setJoinedRoom] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");

  const meRef = useRef<MemberId | null>(null);
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  const keyRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Подписка на события от Rust-части приложения.
  useEffect(() => {
    const nextKey = () => ++keyRef.current;
    const system = (text: string) =>
      setLines((l) => [...l, { key: nextKey(), kind: "system", text }]);

    const onMessage = (msg: ServerMsg) => {
      switch (msg.type) {
        case "welcome":
          meRef.current = msg.you;
          setJoinedRoom(msg.room);
          setMembers(msg.members);
          setPlayback(msg.playback);
          setLines([]);
          system(`Ты в комнате «${msg.room}»`);
          break;
        case "member_joined":
          setMembers((m) => [...m, msg.member]);
          system(`${msg.member.name} зашёл`);
          break;
        case "member_left":
          {
            const left = membersRef.current.find((x) => x.id === msg.id);
            if (left) system(`${left.name} вышел`);
            setMembers((m) => m.filter((x) => x.id !== msg.id));
          }
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
        case "playback":
          setPlayback(msg.playback);
          break;
        case "error":
          setError(msg.message);
          break;
      }
    };

    let active = true;
    const unlisteners: Array<() => void> = [];
    const keep = (unlisten: () => void) => (active ? unlisteners.push(unlisten) : unlisten());

    listen<ServerMsg>("server-message", (e) => onMessage(e.payload)).then(keep);
    listen("disconnected", () => {
      setJoinedRoom(null);
      setError("Соединение с сервером потеряно");
    }).then(keep);

    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

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
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await send({ type: "chat", text });
    } catch (err) {
      setError(String(err));
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
          {playback?.media ? (
            <>
              <div className="media-title">{playback.media}</div>
              <div className="muted">
                {playback.paused ? "На паузе" : "Идёт"} · {formatTime(playback.position)}
              </div>
            </>
          ) : (
            <div className="muted">Пока ничего не выбрано. Плеер появится на следующем шаге.</div>
          )}
        </div>

        <div className="members">
          <h3>В комнате · {members.length}</h3>
          <ul>
            {members.map((m) => (
              <li key={m.id}>
                {m.name}
                {m.id === meRef.current && <span className="muted"> (ты)</span>}
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
          <p className="error" onClick={() => setError(null)}>
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
