import { CSSProperties, FormEvent, ReactElement, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  isUrl,
  type ClientMsg,
  type Control,
  type PlaybackInfo,
  type Member,
  type MemberId,
  type PlaybackState,
  type PlayerKey,
  type PlayerStatus,
  type ServerMsg,
  type Track,
  type VoiceAccess,
} from "./protocol";
import { keyName, listMicrophones, VoiceClient, type VoiceStatus } from "./voice";

type VoiceMode = "open" | "ptt";

/** Значок у события в чате. */
type EventIcon = "enter" | "leave" | "play" | "pause" | "seek" | "media" | "host";

type ChatLine =
  | { key: number; kind: "chat"; name: string; text: string; mine: boolean }
  | { key: number; kind: "system"; text: string; icon: EventIcon };

// Цвета кружков участников и их имён в чате — по нику, чтобы у каждого был свой.
const SEAT_COLORS = ["#6E4A3A", "#3F5260", "#4E5A3C", "#5B3F5C", "#6A5130", "#3E4E4A", "#5E3A40", "#46466A"];
const NAME_COLORS = ["#E0A07C", "#8FB3C8", "#B7C48E", "#C79AC8", "#E3B871", "#93BDB4", "#D98E96", "#A9A9E0"];

function colorIndex(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % SEAT_COLORS.length;
}

function initial(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

/** «1 человек», «2 человека», «5 человек». */
function people(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  const word = d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? "человека" : "человек";
  return `${n} ${word}`;
}

/** Ссылку показываем коротко: сайт и начало пути. */
function mediaTitle(media: string): string {
  if (!isUrl(media)) return media;
  try {
    const u = new URL(media);
    const path = u.pathname.length > 24 ? `${u.pathname.slice(0, 24)}…` : u.pathname;
    return `${u.hostname.replace(/^www\./, "")}${path === "/" ? "" : path}`;
  } catch {
    return media;
  }
}

// При сборке установщика можно вшить адрес сервера друзей:
//   $env:VITE_DEFAULT_SERVER = "wss://example.com"; npm run bundle
const DEFAULT_SERVER = import.meta.env.VITE_DEFAULT_SERVER || "ws://127.0.0.1:8080";

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

function control(c: Control) {
  return invoke("player_control", { control: c });
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

const SUBTITLE_EXTENSIONS = ["srt", "ass", "ssa", "vtt", "sub", "sup"];

/** Выбрать файл субтитров. */
async function pickSubtitleFile(): Promise<string | null> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Субтитры", extensions: SUBTITLE_EXTENSIONS }],
  });
  return typeof path === "string" ? path : null;
}

/** Качество ссылок: высота кадра; пусто — авто (до 1080p). */
const QUALITIES: Array<{ value: string; label: string }> = [
  { value: "", label: "авто" },
  { value: "2160", label: "4K" },
  { value: "1440", label: "1440p" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
];

const CHANNEL_NAMES: Record<number, string> = { 1: "1.0", 2: "2.0", 6: "5.1", 8: "7.1" };

/** «Дубляж · RU · AC3 5.1 · внешняя» */
function trackLabel(t: Track): string {
  const parts: string[] = [];
  if (t.title) parts.push(t.title);
  if (t.lang) parts.push(t.lang.toUpperCase());
  const tech = [t.codec?.toUpperCase(), t.channels ? CHANNEL_NAMES[t.channels] ?? `${t.channels}ch` : null]
    .filter(Boolean)
    .join(" ");
  if (tech) parts.push(tech);
  if (t.external) parts.push("отдельный файл");
  return parts.length ? parts.join(" · ") : `Дорожка ${t.id}`;
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
  const [password, setPassword] = useState(() => load("password", ""));
  const [connecting, setConnecting] = useState(false);
  const [showServer, setShowServer] = useState(false);
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
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [memberMenu, setMemberMenu] = useState<MemberId | null>(null);
  const [quality, setQuality] = useState(() => load("quality", ""));

  // Голос
  const [voiceAccess, setVoiceAccess] = useState<VoiceAccess | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("off");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<Set<string>>(new Set());
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(() =>
    load("voiceMode", "open") === "ptt" ? "ptt" : "open",
  );
  const [micOn, setMicOn] = useState(true);
  const [deafened, setDeafened] = useState(false);
  const [pttKey, setPttKey] = useState<number | null>(() => {
    const v = Number(load("pttKey", ""));
    return v > 0 ? v : null;
  });
  const [pttPressed, setPttPressed] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micDevice, setMicDevice] = useState(() => load("micDevice", ""));
  const [volumes, setVolumes] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(load("volumes", "{}")) as Record<string, number>;
    } catch {
      return {};
    }
  });
  const voiceRef = useRef<VoiceClient | null>(null);
  if (voiceRef.current === null) {
    voiceRef.current = new VoiceClient({
      onStatus: (status, err) => {
        setVoiceStatus(status);
        setVoiceError(err ?? null);
      },
      onSpeakers: setSpeakers,
      onError: (message) => setVoiceError(message),
    });
  }
  const voice = voiceRef.current;

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
    const system = (text: string, icon: EventIcon) =>
      setLines((l) => [...l, { key: nextKey(), kind: "system", text, icon }]);
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
          setVoiceAccess(msg.voice);
          setLines([]);
          system(`Ты в зале «${msg.room}»`, "enter");
          if (msg.host === msg.you) system("Ты ведёшь просмотр: выбирай, что смотрим", "host");
          break;
        }
        case "member_joined":
          setMembers((m) => [...m, msg.member]);
          system(`${msg.member.name} зашёл в зал`, "enter");
          break;
        case "member_left":
          system(`${nameOf(msg.id)} ${msg.kicked ? "исключён из зала" : "вышел"}`, "leave");
          setMembers((m) => m.filter((x) => x.id !== msg.id));
          break;
        case "kicked":
          invoke("disconnect");
          setVoiceAccess(null);
          setJoinedRoom(null);
          setError(`${msg.by} исключил тебя из зала`);
          break;
        case "host_changed":
          setHost(msg.host);
          system(
            msg.host === meRef.current
              ? "Теперь просмотр ведёшь ты"
              : `Теперь просмотр ведёт ${nameOf(msg.host)}`,
            "host",
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
              system(`${by} включил «${mediaTitle(msg.playback.media ?? "")}»`, "media");
              break;
            case "play":
              system(`${by} запустил на ${at}`, "play");
              break;
            case "pause":
              system(`${by} поставил на паузу на ${at}`, "pause");
              break;
            case "seek":
              system(`${by} перемотал на ${at}`, "seek");
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
    listen<boolean>("ptt", (e) => setPttPressed(e.payload)).then(keep);
    listen<number>("ptt-captured", (e) => {
      setPttKey(e.payload);
      save("pttKey", String(e.payload));
      setCapturing(false);
    }).then(keep);
    listen<Track[]>("player-tracks", (e) => setTracks(e.payload)).then(keep);
    listen<PlayerKey>("player-key", (e) => onKeyRef.current(e.payload)).then(keep);
    listen("disconnected", () => {
      setVoiceAccess(null);
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
    save("password", password);
    try {
      await invoke("connect", { server, room, name, password: password || null });
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleLeave() {
    if (fullscreen) await applyFullscreen(false);
    setVoiceAccess(null);
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
    if (await ask(`Передать ${m.name} управление просмотром?`, { title: "BrotherWatch" })) {
      await run(() => send({ type: "transfer_host", to: m.id }));
    }
  }

  async function handleKick(m: Member) {
    if (await ask(`Исключить ${m.name} из зала?`, { title: "BrotherWatch", kind: "warning" })) {
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
      const onButton = target?.tagName === "BUTTON";
      if (e.code === "Space" && !typing && !onButton) {
        e.preventDefault();
        control({ type: "toggle_pause" }).catch((err) => setError(String(err)));
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !typing) {
        e.preventDefault();
        const delta = e.key === "ArrowLeft" ? -5 : 5;
        control({ type: "seek_by", delta }).catch((err) => setError(String(err)));
      } else if (e.key === "Escape") {
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

  // Качество ссылок: запоминается и применяется сразу, даже к открытому видео.
  useEffect(() => {
    invoke("set_quality", { height: quality ? Number(quality) : null }).catch(() => {});
  }, [quality]);

  function changeQuality(value: string) {
    setQuality(value);
    save("quality", value);
  }

  // Меню действий с участником закрывается кликом мимо него.
  useEffect(() => {
    if (memberMenu === null) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".seat-menu")) setMemberMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [memberMenu]);

  // ----- Голос -----

  // Подключение к голосовому каналу комнаты.
  useEffect(() => {
    if (!voiceAccess) {
      voice.disconnect();
      setVoiceStatus("off");
      return;
    }
    voice.connect(voiceAccess.url, voiceAccess.token, micDevice);
    return () => {
      voice.disconnect();
    };
    // Микрофон переключается отдельно, без переподключения.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceAccess]);

  // Передаём ли свой голос.
  useEffect(() => {
    if (voiceStatus !== "connected") return;
    const talking = voiceMode === "open" ? micOn : pttPressed;
    voice.setMic(talking && !deafened);
  }, [voiceStatus, voiceMode, micOn, pttPressed, deafened, voice]);

  useEffect(() => voice.setDeafened(deafened), [deafened, voice]);

  // Громкость каждого участника (запоминается по нику).
  useEffect(() => {
    for (const m of members) {
      if (m.id !== me) voice.setVolume(String(m.id), volumes[m.name] ?? 1);
    }
  }, [members, volumes, me, voice]);

  // Глобальная кнопка «нажми и говори» работает, только пока мы в комнате.
  useEffect(() => {
    const active = joinedRoom !== null && voiceMode === "ptt" && pttKey !== null;
    invoke("ptt_set_key", { key: active ? pttKey : null }).catch(() => {});
    if (!active) setPttPressed(false);
  }, [joinedRoom, voiceMode, pttKey]);

  useEffect(() => {
    invoke("ptt_capture", { enabled: capturing }).catch(() => {});
  }, [capturing]);

  useEffect(() => {
    if (voiceSettings) listMicrophones().then(setMics);
  }, [voiceSettings]);

  function changeVoiceMode(mode: VoiceMode) {
    setVoiceMode(mode);
    save("voiceMode", mode);
  }

  function changeMic(deviceId: string) {
    setMicDevice(deviceId);
    save("micDevice", deviceId);
    voice.switchMic(deviceId);
  }

  function changeVolume(name: string, value: number) {
    setVolumes((v) => {
      const next = { ...v, [name]: value };
      save("volumes", JSON.stringify(next));
      return next;
    });
  }

  // Позиция и длительность для панели управления.
  useEffect(() => {
    if (!joinedRoom || !player.running) {
      setInfo(null);
      setTracks([]);
      return;
    }
    let active = true;
    const poll = () =>
      invoke<PlaybackInfo>("player_info")
        .then((i) => active && setInfo(i))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 400);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [joinedRoom, player.running]);

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
        <div className="login-art" aria-hidden="true">
          <div className="lamp" />
          <div className="screen" />
          <div className="seats">
            {SEAT_COLORS.slice(0, 6).map((c, i) => (
              <span key={i} style={{ background: i === 2 || i === 3 ? c : undefined }} />
            ))}
          </div>
          <div className="login-brand">
            <span className="wordmark">BrotherWatch</span>
            <p>Кинозал для своих: один фильм, одна пауза, общий голосовой чат.</p>
          </div>
        </div>

        <div className="login-side">
          <form className="login-form" onSubmit={handleConnect}>
            <h1>Войти в зал</h1>
            <label>
              Как тебя зовут
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                required
                autoFocus
              />
            </label>
            <label>
              Комната
              <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={32} required />
            </label>
            <button type="submit" className="primary" disabled={connecting}>
              {connecting ? "Подключаюсь…" : "Войти"}
            </button>
            {error && <p className="error">{error}</p>}

            <details className="server-settings" open={showServer}>
              <summary
                onClick={(e) => {
                  e.preventDefault();
                  setShowServer((s) => !s);
                }}
              >
                <Icon name="chevron" size={14} />
                Сервер и пароль
              </summary>
              <label>
                Адрес сервера
                <input value={server} onChange={(e) => setServer(e.target.value)} required />
              </label>
              <label>
                Пароль сервера
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Если сервер с паролем"
                  autoComplete="off"
                />
              </label>
            </details>
          </form>
        </div>
      </main>
    );
  }

  const media = playback?.media ?? null;
  const hostName = members.find((m) => m.id === host)?.name;
  const needsFile = !isHost && media !== null && !isUrl(media) && player.loaded !== media;
  const needsReopen = !isHost && media !== null && player.loaded === media && !player.running;

  const others = members.length - 1;
  const roomStatus = isHost
    ? others > 0
      ? `Просмотр ведёшь ты, в зале ещё ${people(others)}`
      : "Просмотр ведёшь ты, в зале пока никого"
    : `${hostName ?? "Кто-то"} ведёт просмотр, в зале ${people(members.length)}`;

  const transmitting =
    voiceStatus === "connected" && !deafened && (voiceMode === "open" ? micOn : pttPressed);
  const voiceTitle =
    voiceStatus === "connected"
      ? "Голос подключён"
      : voiceStatus === "connecting"
        ? "Подключаюсь к голосу…"
        : voiceAccess
          ? "Голос отключён"
          : "Голос на сервере не настроен";
  const voiceHint = voiceError
    ? voiceError
    : voiceStatus !== "connected"
      ? ""
      : deafened
        ? "Звук выключен"
        : voiceMode === "ptt"
          ? pttKey !== null
            ? `Нажми и говори: ${keyName(pttKey)}`
            : "Назначь кнопку в настройках"
          : micOn
            ? "Микрофон включён"
            : "Микрофон выключен";

  const roomClass = ["room", fullscreen && "fullscreen", !chatOpen && "chat-hidden"]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={roomClass}>
      <section className="stage">
        {!fullscreen && (
          <header className="stage-header">
            <div className="room-title">
              <h1>{joinedRoom}</h1>
              <p>{roomStatus}</p>
            </div>
            <div className="header-actions">
              <button className="ghost" onClick={() => setChatOpen((o) => !o)} title="Tab">
                <Icon name="panel" size={17} />
                {chatOpen ? "Скрыть чат" : "Показать чат"}
              </button>
              <button className="ghost" onClick={() => applyFullscreen(true)} title="F">
                <Icon name="fullscreen" size={17} />
                На весь экран
              </button>
              <button className="ghost" onClick={handleLeave}>
                Выйти из зала
              </button>
            </div>
          </header>
        )}

        {!fullscreen && isHost && (
          <form className="source-bar" onSubmit={handleOpenUrl}>
            <label className="source-input">
              <Icon name="link" size={18} />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Вставь ссылку на YouTube, VK Видео или Rutube"
                aria-label="Ссылка на видео"
              />
              <button type="submit" className="quiet" disabled={!url.trim()}>
                Открыть
              </button>
            </label>
          </form>
        )}
        {!fullscreen && needsFile && (
          <div className="notice">
            <span>
              {hostName ?? "Ведущий"} включил «{media}». Открой у себя этот же файл.
            </span>
            <button className="primary" onClick={handleOpenFile}>
              Выбрать файл
            </button>
          </div>
        )}
        {!fullscreen && needsReopen && (
          <div className="notice">
            <span>Плеер закрыт.</span>
            <button
              className="primary"
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
            {media
              ? player.running
                ? "Загружаю видео…"
                : `Сейчас смотрят «${mediaTitle(media)}»`
              : isHost
                ? "Вставь ссылку сверху — видео начнётся у всех одновременно"
                : `Ждём, пока ${hostName ?? "ведущий"} выберет, что смотрим`}
          </div>
        </div>

        <PlayerControls
          info={info}
          canControl={isHost && player.running && player.loaded === media}
          controlHint={isHost ? "Сначала открой видео" : `Управляет ${hostName ?? "ведущий"}`}
          title={media ? mediaTitle(media) : "Ничего не выбрано"}
          status={
            !media
              ? isHost
                ? "Выбери, что смотрим"
                : "Ждём ведущего"
              : playback?.paused
                ? isHost
                  ? "На паузе"
                  : `${hostName ?? "Ведущий"} поставил на паузу`
                : "Смотрите вместе"
          }
          scrub={scrub}
          onScrub={setScrub}
          tracks={tracks}
          quality={quality}
          qualityEnabled={media !== null && isUrl(media)}
          onQuality={changeQuality}
          onError={(err) => setError(err)}
          fullscreen={fullscreen}
          onFullscreen={() => applyFullscreen(!fullscreen)}
        />
        {error && !chatOpen && (
          <p className="error stage-error" onClick={() => setError(null)} title="Скрыть">
            {error}
          </p>
        )}
      </section>

      {chatOpen && (
        <aside className="side">
          <div className="hall">
            <h2>В зале</h2>
            <ul>
              {members.map((m) => {
                const speaking = speakers.has(String(m.id));
                return (
                  <li key={m.id}>
                    <span
                      className={speaking ? "seat speaking" : "seat"}
                      style={{ background: SEAT_COLORS[colorIndex(m.name)] }}
                      title={speaking ? "Говорит" : undefined}
                    >
                      {initial(m.name)}
                    </span>
                    <span className="seat-name">
                      <span>
                        {m.name}
                        {m.id === me && <span className="muted"> (ты)</span>}
                      </span>
                      {m.id === host && <span className="seat-role">ведёт просмотр</span>}
                    </span>
                    {isHost && m.id !== me && (
                      <span className="seat-menu">
                        <button
                          className="icon"
                          aria-label={`Действия с участником ${m.name}`}
                          aria-expanded={memberMenu === m.id}
                          onClick={() => setMemberMenu((id) => (id === m.id ? null : m.id))}
                        >
                          <Icon name="more" />
                        </button>
                        {memberMenu === m.id && (
                          <span className="menu" role="menu">
                            <button
                              role="menuitem"
                              onClick={() => {
                                setMemberMenu(null);
                                handleTransfer(m);
                              }}
                            >
                              Передать управление
                            </button>
                            <button
                              role="menuitem"
                              className="danger"
                              onClick={() => {
                                setMemberMenu(null);
                                handleKick(m);
                              }}
                            >
                              Исключить из зала
                            </button>
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {voiceSettings ? (
            <div className="voice-settings">
              <h2>Голос</h2>
              <fieldset>
                <legend>Микрофон</legend>
                <label className="radio">
                  <input
                    type="radio"
                    name="voice-mode"
                    checked={voiceMode === "open"}
                    onChange={() => changeVoiceMode("open")}
                  />
                  Всегда включён, выключаю кнопкой
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="voice-mode"
                    checked={voiceMode === "ptt"}
                    onChange={() => changeVoiceMode("ptt")}
                  />
                  Нажми и говори
                </label>
              </fieldset>

              {voiceMode === "ptt" && (
                <div className="setting">
                  <span className="setting-label">Кнопка — работает и в других окнах</span>
                  <button className="quiet" onClick={() => setCapturing((c) => !c)}>
                    {capturing
                      ? "Нажми клавишу или кнопку мыши…"
                      : pttKey !== null
                        ? `${keyName(pttKey)}, изменить`
                        : "Назначить кнопку"}
                  </button>
                </div>
              )}

              <label className="setting">
                <span className="setting-label">Устройство</span>
                <select value={micDevice} onChange={(e) => changeMic(e.target.value)}>
                  <option value="">Как в Windows</option>
                  {mics
                    .filter((d) => d.deviceId && d.deviceId !== "default")
                    .map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || "Микрофон"}
                      </option>
                    ))}
                </select>
              </label>

              {members.some((m) => m.id !== me) && (
                <div className="setting">
                  <span className="setting-label">Громкость друзей</span>
                  {members
                    .filter((m) => m.id !== me)
                    .map((m) => (
                      <label key={m.id} className="volume-row">
                        <span className="seat-name">{m.name}</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={volumes[m.name] ?? 1}
                          onChange={(e) => changeVolume(m.name, Number(e.target.value))}
                          aria-label={`Громкость ${m.name}`}
                        />
                        <span className="pct">{Math.round((volumes[m.name] ?? 1) * 100)}%</span>
                      </label>
                    ))}
                </div>
              )}

              <button className="primary" onClick={() => setVoiceSettings(false)}>
                Готово
              </button>
            </div>
          ) : (
            <div className="lines">
              {lines.map((l) =>
                l.kind === "system" ? (
                  <div key={l.key} className="event">
                    <Icon name={EVENT_ICONS[l.icon]} size={12} />
                    <span>{l.text}</span>
                  </div>
                ) : (
                  <div key={l.key} className="message">
                    <span className="author" style={{ color: NAME_COLORS[colorIndex(l.name)] }}>
                      {l.name}
                    </span>
                    <span>{l.text}</span>
                  </div>
                ),
              )}
              <div ref={chatEndRef} />
            </div>
          )}

          {error && (
            <p className="error side-error" onClick={() => setError(null)} title="Скрыть">
              {error}
            </p>
          )}
          {!voiceSettings && (
            <form className="composer" onSubmit={handleSend}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Написать в зал"
                aria-label="Сообщение"
                maxLength={2000}
              />
            </form>
          )}

          <div className="voice-dock">
            <div className="voice-state">
              <span className={voiceStatus === "connected" ? "voice-title on" : "voice-title"}>
                {voiceTitle}
              </span>
              {voiceHint && (
                <span className={voiceError ? "voice-hint error" : "voice-hint"}>{voiceHint}</span>
              )}
            </div>
            {voiceMode === "open" && (
              <button
                className={micOn && !deafened ? "dock" : "dock off"}
                onClick={() => setMicOn((on) => !on)}
                disabled={voiceStatus !== "connected" || deafened}
                aria-label={micOn ? "Выключить микрофон" : "Включить микрофон"}
                title={micOn ? "Выключить микрофон" : "Включить микрофон"}
              >
                <Icon name={micOn && !deafened ? "mic" : "mic-off"} size={18} />
              </button>
            )}
            {voiceMode === "ptt" && (
              <span className={transmitting ? "dock talking" : "dock idle"} aria-hidden="true">
                <Icon name={transmitting ? "mic" : "mic-off"} size={18} />
              </span>
            )}
            <button
              className={deafened ? "dock off" : "dock"}
              onClick={() => setDeafened((d) => !d)}
              disabled={voiceStatus !== "connected"}
              aria-label={deafened ? "Включить звук" : "Выключить звук"}
              title={deafened ? "Включить звук" : "Выключить звук от всех"}
            >
              <Icon name={deafened ? "headphones-off" : "headphones"} size={18} />
            </button>
            <button
              className={voiceSettings ? "dock active" : "dock"}
              onClick={() => setVoiceSettings((v) => !v)}
              aria-label="Настройки голоса"
              title="Настройки голоса"
            >
              <Icon name="sliders" size={18} />
            </button>
          </div>
        </aside>
      )}
    </main>
  );
}

const EVENT_ICONS: Record<EventIcon, IconName> = {
  enter: "enter",
  leave: "leave",
  play: "play",
  pause: "pause",
  seek: "seek",
  media: "film",
  host: "star",
};

function PlayerControls({
  info,
  canControl,
  controlHint,
  title,
  status,
  scrub,
  onScrub,
  tracks,
  quality,
  qualityEnabled,
  onQuality,
  onError,
  fullscreen,
  onFullscreen,
}: {
  info: PlaybackInfo | null;
  canControl: boolean;
  controlHint: string;
  title: string;
  status: string;
  scrub: number | null;
  onScrub: (value: number | null) => void;
  tracks: Track[];
  quality: string;
  qualityEnabled: boolean;
  onQuality: (value: string) => void;
  onError: (message: string) => void;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  const duration = info?.duration ?? 0;
  const position = scrub ?? info?.position ?? 0;
  const paused = info?.paused ?? true;
  const volume = info?.volume ?? 100;
  const send = (c: Control) => control(c).catch((err) => onError(String(err)));

  const audioTracks = tracks.filter((t) => t.kind === "audio");
  const subTracks = tracks.filter((t) => t.kind === "sub");
  const audioValue = String(audioTracks.find((t) => t.selected)?.id ?? "off");
  const subValue = String(subTracks.find((t) => t.selected)?.id ?? "off");

  const onAudio = (value: string) =>
    send({ type: "set_audio", id: value === "off" ? null : Number(value) });

  const onSubtitle = async (value: string) => {
    if (value === "file") {
      const path = await pickSubtitleFile();
      if (path) send({ type: "add_subtitle", path });
      return;
    }
    send({ type: "set_subtitle", id: value === "off" ? null : Number(value) });
  };

  const commitScrub = () => {
    if (scrub !== null) {
      send({ type: "seek", position: scrub });
      // Даём mpv перемотаться, чтобы ползунок не прыгнул назад.
      setTimeout(() => onScrub(null), 300);
    }
  };

  const progress = duration ? Math.min(position / duration, 1) * 100 : 0;

  return (
    <div className="controls">
      <div className="seek-row">
        <span className="time">{formatTime(position)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={duration || 1}
          step={0.5}
          value={Math.min(position, duration || 1)}
          style={{ "--progress": `${progress}%` } as CSSProperties}
          disabled={!canControl || !duration}
          title={canControl ? "Перемотка: стрелки ← →" : controlHint}
          aria-label="Перемотка"
          onChange={(e) => onScrub(Number(e.target.value))}
          onPointerUp={commitScrub}
          onKeyUp={commitScrub}
        />
        <span className="time end">{duration ? formatTime(duration) : "–:––"}</span>
      </div>

      <div className="control-row">
        <button
          className="play"
          onClick={() => send({ type: "toggle_pause" })}
          disabled={!canControl}
          title={canControl ? "Пробел" : controlHint}
          aria-label={paused ? "Смотреть" : "Пауза"}
        >
          <Icon name={paused ? "play-solid" : "pause-solid"} size={18} />
        </button>
        <div className="now">
          <span className="now-title">{title}</span>
          <span className="now-status">{status}</span>
        </div>

        <label className="track-select" title="Озвучка у каждого своя">
          <span>Озвучка</span>
          <select
            value={audioValue}
            disabled={audioTracks.length === 0}
            onChange={(e) => onAudio(e.target.value)}
          >
            {audioTracks.length === 0 && <option value="off">нет</option>}
            {audioTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {trackLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="track-select" title="Субтитры у каждого свои">
          <span>Субтитры</span>
          <select value={subValue} disabled={!info} onChange={(e) => onSubtitle(e.target.value)}>
            <option value="off">нет</option>
            {subTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {trackLabel(t)}
              </option>
            ))}
            <option value="file">Загрузить из файла…</option>
          </select>
        </label>

        <label
          className="track-select"
          title={
            qualityEnabled
              ? "Качество у каждого своё. Если интернет слабый — выбери пониже"
              : "Качество выбирается только для ссылок"
          }
        >
          <span>Качество</span>
          <select
            value={quality}
            disabled={!qualityEnabled}
            onChange={(e) => onQuality(e.target.value)}
          >
            {QUALITIES.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </label>

        <label className="volume" title="Громкость фильма у каждого своя">
          <Icon name={volume > 0 ? "volume" : "mute"} size={18} />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.min(volume, 100)}
            style={{ "--progress": `${Math.min(volume, 100)}%` } as CSSProperties}
            disabled={!info}
            aria-label="Громкость фильма"
            onChange={(e) => send({ type: "volume", value: Number(e.target.value) })}
          />
        </label>
        {fullscreen && (
          <button
            className="ghost icon"
            onClick={onFullscreen}
            title="Выйти из полного экрана: Esc"
            aria-label="Выйти из полного экрана"
          >
            <Icon name="exit-fullscreen" size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

type IconName =
  | "panel"
  | "fullscreen"
  | "exit-fullscreen"
  | "folder"
  | "screen"
  | "crown"
  | "close"
  | "send"
  | "play"
  | "pause"
  | "volume"
  | "mute"
  | "audio-track"
  | "subtitles"
  | "mic"
  | "mic-off"
  | "headphones"
  | "headphones-off"
  | "settings"
  | "chevron"
  | "link"
  | "more"
  | "enter"
  | "leave"
  | "seek"
  | "film"
  | "star"
  | "sliders"
  | "play-solid"
  | "pause-solid";

const ICON_PATHS: Record<IconName, ReactElement> = {
  chevron: <polyline points="9 6 15 12 9 18" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  enter: (
    <>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <polyline points="10 8 14 12 10 16" />
      <line x1="3" y1="12" x2="14" y2="12" />
    </>
  ),
  leave: (
    <>
      <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
      <polyline points="15 8 19 12 15 16" />
      <line x1="8" y1="12" x2="19" y2="12" />
    </>
  ),
  seek: (
    <>
      <polygon points="4 6 11 12 4 18 4 6" />
      <polygon points="13 6 20 12 13 18 13 6" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="7" y1="4" x2="7" y2="20" />
      <line x1="17" y1="4" x2="17" y2="20" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </>
  ),
  star: <polygon points="12 3 14.8 9 21 9.6 16.3 13.8 17.7 20 12 16.8 6.3 20 7.7 13.8 3 9.6 9.2 9" />,
  sliders: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="9" cy="7" r="2.5" fill="var(--surface)" />
      <circle cx="15" cy="17" r="2.5" fill="var(--surface)" />
    </>
  ),
  "play-solid": <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />,
  "pause-solid": (
    <>
      <rect x="6" y="4.5" width="4.2" height="15" rx="1.4" />
      <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.4" />
    </>
  ),
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
  "exit-fullscreen": (
    <>
      <polyline points="9 4 9 9 4 9" />
      <polyline points="15 4 15 9 20 9" />
      <polyline points="9 20 9 15 4 15" />
      <polyline points="15 20 15 15 20 15" />
    </>
  ),
  play: <polygon points="7 4 20 12 7 20 7 4" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </>
  ),
  "mic-off": (
    <>
      <path d="M15 10V6a3 3 0 0 0-5.7-1.3" />
      <path d="M9 9v2a3 3 0 0 0 4.6 2.5" />
      <path d="M5 11a7 7 0 0 0 11.4 5.4" />
      <path d="M19 11a7 7 0 0 1-.6 2.8" />
      <line x1="12" y1="18" x2="12" y2="21" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </>
  ),
  headphones: (
    <>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <rect x="3" y="15" width="4" height="6" rx="1" />
      <rect x="17" y="15" width="4" height="6" rx="1" />
    </>
  ),
  "headphones-off": (
    <>
      <path d="M3 18v-6a9 9 0 0 1 15.4-6.4" />
      <path d="M21 12v6" />
      <rect x="3" y="15" width="4" height="6" rx="1" />
      <rect x="17" y="15" width="4" height="6" rx="1" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  "audio-track": (
    <>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <rect x="3" y="15" width="4" height="6" rx="1" />
      <rect x="17" y="15" width="4" height="6" rx="1" />
    </>
  ),
  subtitles: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="6" y1="11" x2="11" y2="11" />
      <line x1="13" y1="11" x2="18" y2="11" />
      <line x1="6" y1="15" x2="15" y2="15" />
    </>
  ),
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </>
  ),
  volume: (
    <>
      <polygon points="4 9 8 9 13 5 13 19 8 15 4 15 4 9" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 6a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  mute: (
    <>
      <polygon points="4 9 8 9 13 5 13 19 8 15 4 15 4 9" />
      <line x1="17" y1="9" x2="22" y2="14" />
      <line x1="22" y1="9" x2="17" y2="14" />
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
  // Значки play/pause и «⋯» залиты, остальные — контурные.
  const solid = name.endsWith("-solid") || name === "more" || name === "seek" || name === "star";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={solid ? "currentColor" : "none"}
      stroke={solid ? "none" : accent ? "var(--accent)" : "currentColor"}
      strokeWidth={1.8}
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
