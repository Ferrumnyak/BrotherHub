import {
  CSSProperties,
  FormEvent,
  ReactElement,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
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
  type Suggestion,
  type Track,
  type VoiceAccess,
} from "./protocol";
import { EMOJI_GROUPS, recentEmoji, rememberEmoji } from "./emoji";
import { EmojiGlyph, RichText } from "./RichText";
import { RouletteWheel, SPIN_MS } from "./Roulette";
import { STICKERS, StickerArt, stickerFromMessage, stickerMessage } from "./stickers";
import { keyName, listMicrophones, VoiceClient, type ScreenShare, type VoiceStatus } from "./voice";

type VoiceMode = "open" | "ptt";

/** Значок у события в чате. */
type EventIcon = "enter" | "leave" | "play" | "pause" | "seek" | "media" | "host" | "suggest" | "roulette";

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

/** Высота панели плеера поверх видео в полном экране, CSS-пиксели. */
const OVERLAY_HEIGHT = 150;
/** Высота панели поверх видео в мини-окне. */
const MINI_OVERLAY_HEIGHT = 84;
/** Размер мини-окна (внутренняя часть, без заголовка). */
const MINI_WIDTH = 480;
const MINI_HEIGHT = 340;
/** Уже этого окно считается узким: чат прячется сам. */
const NARROW_WIDTH = 760;
/** Автозапуск: сколько ждать, пока видео откроется у всех. */
const AUTOPLAY_WAIT_MS = 15_000;
/** Через сколько прячется сообщение об ошибке. */
const ERROR_HIDE_MS = 7_000;

/** Что нужно панели плеера поверх видео (событие `overlay-state`). */
interface OverlayState {
  /** Панель поверх мини-окна, а не полного экрана. */
  mini: boolean;
  canControl: boolean;
  controlHint: string;
  title: string;
  status: string;
  tracks: Track[];
  quality: string;
  qualityEnabled: boolean;
}

function hostNameOf(members: Member[], host: MemberId | null): string | undefined {
  return members.find((m) => m.id === host)?.name;
}

/** Подпись под названием фильма в панели плеера. */
function playbackStatus(
  playback: PlaybackState | null,
  isHost: boolean,
  hostName: string | undefined,
): string {
  if (!playback?.media) return isHost ? "Выбери, что смотрим" : "Ждём, что выберут";
  if (playback.paused) return isHost ? "На паузе" : `${hostName ?? "Ведущий"} поставил на паузу`;
  return "Смотрите вместе";
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
const DEFAULT_SERVER = import.meta.env.VITE_DEFAULT_SERVER || "wss://bw.sokolovds.com";

/** Сохранённый адрес сервера; устаревший или явно ошибочный заменяем на адрес по умолчанию. */
function savedServer(): string {
  const saved = load("server", DEFAULT_SERVER).trim();
  const outdated =
    !saved ||
    saved.includes("127.0.0.1") ||
    saved.includes("localhost") ||
    // Адрес голосового сервера вписывать сюда не нужно — его присылает сервер.
    saved.includes("livekit");
  return outdated ? DEFAULT_SERVER : saved;
}

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

/**
 * Открыть папку с логами. В ней папка «1» — этот запуск, «2» — предыдущий
 * и так далее: её и нужно прислать, если что-то сломалось.
 */
export function LogsButton() {
  return (
    <button
      type="button"
      className="quiet"
      title="Папка «1» — этот запуск, «2» — предыдущий. Пришли её, если что-то не работает."
      onClick={() => invoke("open_logs").catch(() => {})}
    >
      Открыть папку с логами
    </button>
  );
}

/** Левая половина экрана входа: экран, свет лампы и ряд кресел. */
export function LoginArt() {
  return (
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
  );
}

export default function App() {
  const [server, setServer] = useState(savedServer);
  const [name, setName] = useState(() => load("name", ""));
  const [room, setRoom] = useState(() => load("room", "brotherhood"));
  const [password, setPassword] = useState(() => load("password", ""));
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
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
  // Мини-окно поверх всех окон: только видео и короткая панель.
  const [mini, setMini] = useState(false);
  const miniRestore = useRef<{
    size: PhysicalSize;
    position: PhysicalPosition;
    maximized: boolean;
    chat: boolean;
  } | null>(null);
  // Трансляция экрана: чужая, которую показываем, и показываю ли я свою.
  const [screenShare, setScreenShare] = useState<ScreenShare | null>(null);
  const [sharing, setSharing] = useState(false);
  /** Открыто окно выбора, что показывать. */
  const [picking, setPicking] = useState(false);
  const screenRef = useRef<HTMLVideoElement>(null);
  // Что посмотреть: общий список, рулетка и вкладка справа.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const suggestionsRef = useRef<Suggestion[]>([]);
  suggestionsRef.current = suggestions;
  const [sideTab, setSideTab] = useState<"chat" | "suggest">("chat");
  const [spin, setSpin] = useState<{ list: Suggestion[]; winner: number; by: string } | null>(
    null,
  );
  const [spinIndex, setSpinIndex] = useState<number | null>(null);
  const [spinDone, setSpinDone] = useState(false);
  // Секретный пульт админа и «подкрученные» шансы (id предложения → вес).
  const [adminOpen, setAdminOpen] = useState(false);
  const [weights, setWeights] = useState<Map<number, number>>(new Map());
  // Автозапуск: у кого уже открылось видео, и чего ждём.
  const [loadedBy, setLoadedBy] = useState<Map<MemberId, string>>(new Map());
  const autoplayRef = useRef<{ media: string; since: number } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(recentEmoji);
  /** Раздел смайликов: -1 — недавние. */
  const [emojiGroup, setEmojiGroup] = useState(0);
  const [stickersOpen, setStickersOpen] = useState(false);
  const draftRef = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [memberMenu, setMemberMenu] = useState<MenuAnchor | null>(null);
  const [quality, setQuality] = useState(() => load("quality", ""));
  const [controlsHidden, setControlsHidden] = useState(false);
  const overControlsRef = useRef(false);

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
      onScreenShare: setScreenShare,
      onLocalScreenShare: setSharing,
    });
  }
  const voice = voiceRef.current;
  const voiceStatusRef = useRef(voiceStatus);
  voiceStatusRef.current = voiceStatus;

  const meRef = useRef<MemberId | null>(null);
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  const keyRef = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const fullscreenRef = useRef(false);
  fullscreenRef.current = fullscreen;
  const miniRef = useRef(false);
  miniRef.current = mini;

  const isHost = me !== null && me === host;
  const isHostRef = useRef(false);
  isHostRef.current = isHost;

  const addSystem = (text: string, icon: EventIcon) =>
    setLines((l) => [...l, { key: ++keyRef.current, kind: "system", text, icon }]);

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
          setSuggestions(msg.suggestions ?? []);
          setReconnecting(false);
          if (msg.resumed) {
            // Вернулись на своё место: чат и голос оставляем как были.
            system("Связь восстановлена", "enter");
            if (voiceStatusRef.current !== "connected") setVoiceAccess(msg.voice);
            break;
          }
          setVoiceAccess(msg.voice);
          setLines([]);
          system(`Ты в зале «${msg.room}»`, "enter");
          if (msg.host === msg.you) system("Пульт у тебя: выбирай, что смотрим", "host");
          break;
        }
        case "member_status":
          setMembers((m) => m.map((x) => (x.id === msg.id ? { ...x, online: msg.online } : x)));
          break;
        case "member_joined":
          setMembers((m) => [...m, msg.member]);
          system(`${msg.member.name} зашёл в зал`, "enter");
          break;
        case "member_left":
          system(
            msg.kicked ? `${nameOf(msg.id)} делал -вайб, поэтому вышел` : `${nameOf(msg.id)} вышел`,
            "leave",
          );
          setMembers((m) => m.filter((x) => x.id !== msg.id));
          break;
        case "kicked":
          invoke("disconnect");
          setVoiceAccess(null);
          setJoinedRoom(null);
          setError(`${msg.by} выгнал тебя из зала`);
          break;
        case "host_changed":
          setHost(msg.host);
          system(
            msg.host === meRef.current
              ? "Теперь пульт у тебя"
              : `Пульт теперь у ${nameOf(msg.host)}`,
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
          // Новое видео по ссылке запустится само, когда откроется у всех
          // (это делает ведущий, см. эффект автозапуска). Любое ручное
          // действие ведущего автозапуск отменяет.
          if (msg.action === "set_media") {
            const media = msg.playback.media;
            autoplayRef.current =
              media && isUrl(media) ? { media, since: Date.now() } : null;
          } else if (msg.action) {
            autoplayRef.current = null;
          }
          switch (msg.action) {
            case "set_media":
              system(
                msg.playback.media
                  ? `${by} включил «${mediaTitle(msg.playback.media)}»`
                  : `${by} закрыл видео`,
                "media",
              );
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
        case "suggestions": {
          const known = new Set(suggestionsRef.current.map((x) => x.id));
          for (const x of msg.list) {
            if (!known.has(x.id)) system(`${x.name} предлагает «${mediaTitle(x.media)}»`, "suggest");
          }
          suggestionsRef.current = msg.list;
          setSuggestions(msg.list);
          break;
        }
        case "roulette": {
          const list = suggestionsRef.current;
          const winner = list.findIndex((x) => x.id === msg.winner);
          if (winner < 0) break;
          system(`${msg.by} крутит рулетку…`, "roulette");
          setSideTab("suggest");
          setSpinDone(false);
          setSpin({ list, winner, by: msg.by });
          break;
        }
        case "member_loaded":
          setLoadedBy((m) => new Map(m).set(msg.id, msg.media));
          break;
        case "member_voice":
          setMembers((m) =>
            m.map((x) =>
              x.id === msg.id ? { ...x, in_voice: msg.in_voice, mic: msg.mic, deaf: msg.deaf } : x,
            ),
          );
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
    listen("reconnecting", () => setReconnecting(true)).then(keep);
    listen("disconnected", () => {
      setReconnecting(false);
      setVoiceAccess(null);
      setJoinedRoom(null);
      setError("Не получилось восстановить связь с сервером. Проверь интернет и зайди снова");
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
    setEmojiOpen(false);
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
    if (!isHost) {
      await handleSuggest();
      return;
    }
    await run(() => invoke("open_url", { url: link }));
    setUrl("");
  }

  async function handleSuggest() {
    const link = url.trim();
    if (!link) return;
    if (!isUrl(link)) {
      setError("Ссылка должна начинаться с http:// или https://");
      return;
    }
    await run(() => send({ type: "suggest", media: link }));
    setUrl("");
    setSideTab("suggest");
    if (!mini) setChatOpen(true);
  }

  function insertEmoji(emoji: string) {
    setRecent(rememberEmoji(emoji));
    const input = draftRef.current;
    const at = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? at;
    setDraft((d) => d.slice(0, at) + emoji + d.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      const pos = at + emoji.length;
      input?.setSelectionRange(pos, pos);
    });
  }

  // Подтверждение — в самом меню участника (см. MemberMenu).
  async function handleTransfer(m: Member) {
    await run(() => send({ type: "transfer_host", to: m.id }));
  }

  async function handleKick(m: Member) {
    await run(() => send({ type: "kick", id: m.id }));
  }

  // ----- Полный экран и панель чата -----

  async function applyFullscreen(next: boolean) {
    if (next && miniRef.current) await applyMini(false);
    try {
      await getCurrentWindow().setFullscreen(next);
    } catch (err) {
      setError(String(err));
      return;
    }
    setFullscreen(next);
    setChatOpen(!next);
  }

  /** Мини-окно: маленькое, поверх всех окон, в правом нижнем углу экрана. */
  async function applyMini(next: boolean) {
    const win = getCurrentWindow();
    try {
      if (next) {
        if (fullscreenRef.current) await applyFullscreen(false);
        const maximized = await win.isMaximized();
        miniRestore.current = {
          size: await win.innerSize(),
          position: await win.outerPosition(),
          maximized,
          chat: chatOpen,
        };
        if (maximized) await win.unmaximize();
        setChatOpen(false);
        setMini(true);
        await win.setSize(new LogicalSize(MINI_WIDTH, MINI_HEIGHT));
        await win.setAlwaysOnTop(true);
        const monitor = await currentMonitor();
        if (monitor) {
          const outer = await win.outerSize();
          const gap = Math.round(16 * monitor.scaleFactor);
          const area = monitor.workArea;
          await win.setPosition(
            new PhysicalPosition(
              area.position.x + area.size.width - outer.width - gap,
              area.position.y + area.size.height - outer.height - gap,
            ),
          );
        }
      } else {
        const restore = miniRestore.current;
        miniRestore.current = null;
        await win.setAlwaysOnTop(false);
        setMini(false);
        setChatOpen(restore?.chat ?? true);
        if (restore) {
          await win.setSize(restore.size);
          await win.setPosition(restore.position);
          if (restore.maximized) await win.maximize();
        }
      }
    } catch (err) {
      setError(String(err));
    }
  }

  const onKey = (key: PlayerKey) => {
    if (key === "fullscreen") applyFullscreen(!fullscreenRef.current);
    else if (key === "exit-fullscreen") {
      if (fullscreenRef.current) applyFullscreen(false);
      else if (miniRef.current) applyMini(false);
    } else if (key === "toggle-chat" && !miniRef.current) setChatOpen((open) => !open);
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

  // В полном экране и в мини-окне панель плеера лежит поверх видео и
  // прячется, если мышь не двигается (в мини-окне — и когда мышь ушла с окна).
  useEffect(() => {
    if (!fullscreen && !mini) {
      setControlsHidden(false);
      return;
    }
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (visible: boolean) => {
      setControlsHidden(!visible);
      emit("overlay-visible", visible).catch(() => {});
      invoke("overlay_interactive", { interactive: visible }).catch(() => {});
    };
    const poke = () => {
      show(true);
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (!overControlsRef.current) show(false);
        },
        mini ? 1800 : 3000,
      );
    };
    const onCursor = async ([x, y]: [number, number]) => {
      if (!mini) {
        poke();
        return;
      }
      try {
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        const inside =
          x >= pos.x && y >= pos.y && x < pos.x + size.width && y < pos.y + size.height;
        if (inside) poke();
        else if (!overControlsRef.current) {
          clearTimeout(timer);
          show(false);
        }
      } catch {
        poke();
      }
    };
    poke();
    invoke("watch_cursor", { enabled: true }).catch(() => {});
    let unlisten: (() => void) | undefined;
    let active = true;
    listen<[number, number]>("cursor-moved", (e) => onCursor(e.payload)).then((u) =>
      active ? (unlisten = u) : u(),
    );
    window.addEventListener("mousemove", poke);
    window.addEventListener("keydown", poke);
    return () => {
      active = false;
      clearTimeout(timer);
      unlisten?.();
      invoke("overlay_close").catch(() => {});
      invoke("watch_cursor", { enabled: false }).catch(() => {});
      window.removeEventListener("mousemove", poke);
      window.removeEventListener("keydown", poke);
    };
  }, [fullscreen, mini]);

  // Панель смайликов закрывается кликом мимо неё.
  useEffect(() => {
    if (!emojiOpen && !stickersOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".composer")) {
        setEmojiOpen(false);
        setStickersOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [emojiOpen, stickersOpen]);

  // Ошибки прячутся сами через несколько секунд.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), ERROR_HIDE_MS);
    return () => clearTimeout(t);
  }, [error]);

  // Остальные видят, выключен ли у меня микрофон или звук.
  useEffect(() => {
    if (!joinedRoom) return;
    const inVoice = voiceStatus === "connected";
    send({
      type: "voice_state",
      in_voice: inVoice,
      mic: inVoice && !deafened && (voiceMode === "ptt" || micOn),
      deaf: inVoice && deafened,
    }).catch(() => {});
  }, [joinedRoom, voiceStatus, micOn, deafened, voiceMode]);

  // Автозапуск: ведущий запускает новое видео, когда оно открылось у всех
  // в зале (но ждёт не дольше AUTOPLAY_WAIT_MS).
  useEffect(() => {
    const pending = autoplayRef.current;
    if (!isHost || me === null || !pending || !playback) return;
    if (playback.media !== pending.media || !playback.paused) return;
    if (loadedBy.get(me) !== pending.media) return; // у самого ещё не открылось
    const start = () => {
      if (autoplayRef.current !== pending) return;
      autoplayRef.current = null;
      control({ type: "play" }).catch((err) => setError(String(err)));
    };
    const everyone = members
      .filter((m) => m.online)
      .every((m) => loadedBy.get(m.id) === pending.media);
    const left = AUTOPLAY_WAIT_MS - (Date.now() - pending.since);
    if (everyone || left <= 0) {
      start();
      return;
    }
    const t = setTimeout(start, left);
    return () => clearTimeout(t);
  }, [isHost, me, playback, loadedBy, members]);

  // Рулетка: колесо крутится SPIN_MS и останавливается на выпавшем.
  // Потом тот, у кого пульт, сам включает выпавшее.
  useEffect(() => {
    if (!spin) return;
    const winner = spin.list[spin.winner];
    const done = setTimeout(() => {
      setSpinDone(true);
      setSpinIndex(spin.winner);
      addSystem(`Рулетка выбрала «${mediaTitle(winner.media)}»`, "roulette");
      if (isHostRef.current) {
        run(() => invoke("open_url", { url: winner.media }));
      }
    }, SPIN_MS + 200);
    const clear = setTimeout(() => {
      setSpin(null);
      setSpinIndex(null);
      setSpinDone(false);
    }, SPIN_MS + 3500);
    return () => {
      clearTimeout(done);
      clearTimeout(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin]);

  // Секретный пульт админа: Shift + \ + 1 одновременно. Позволяет
  // «подкрутить» шансы рулетки — их учитывает только тот, у кого пульт.
  useEffect(() => {
    const down = new Set<string>();
    const onDown = (e: KeyboardEvent) => {
      down.add(e.code);
      if (e.shiftKey && down.has("Backslash") && down.has("Digit1")) {
        e.preventDefault();
        down.clear();
        setAdminOpen((o) => !o);
        setChatOpen(true);
        setSideTab("suggest");
      }
    };
    const onUp = (e: KeyboardEvent) => down.delete(e.code);
    const onBlur = () => down.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Окно сузили — чат прячется сам, чтобы видео не стало крошечным.
  // Обратно его можно открыть кнопкой или Tab.
  useEffect(() => {
    if (!joinedRoom) return;
    let wasNarrow = window.innerWidth < NARROW_WIDTH;
    const onResize = () => {
      const narrow = window.innerWidth < NARROW_WIDTH;
      if (narrow && !wasNarrow && !miniRef.current) setChatOpen(false);
      wasNarrow = narrow;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [joinedRoom]);

  // Чужая трансляция экрана — в элемент <video> на месте плеера.
  useEffect(() => {
    const el = screenRef.current;
    if (!screenShare || !el) return;
    screenShare.track.attach(el);
    return () => {
      screenShare.track.detach(el);
    };
  }, [screenShare]);

  // Вышли из зала (или выгнали) в мини-окне — возвращаем обычное окно.
  useEffect(() => {
    if (!joinedRoom && miniRef.current) applyMini(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedRoom]);

  // Вышли из зала или голос отключился — показ экрана заканчивается.
  useEffect(() => {
    if (voiceStatus !== "connected") setScreenShare(null);
  }, [voiceStatus]);

  async function toggleScreenShare() {
    if (sharing) {
      await voice.stopScreenShare();
      return;
    }
    // Окно выбора экрана открывается под окном видео mpv — на время выбора
    // видео прячем, иначе выбора не видно.
    setPicking(true);
    await invoke("set_video_rect", { rect: null }).catch(() => {});
    try {
      await voice.startScreenShare();
    } finally {
      setPicking(false);
    }
  }

  // Качество ссылок: запоминается и применяется сразу, даже к открытому видео.
  useEffect(() => {
    invoke("set_quality", { height: quality ? Number(quality) : null }).catch(() => {});
  }, [quality]);

  function changeQuality(value: string) {
    setQuality(value);
    save("quality", value);
  }

  // Меню действий с участником закрывается кликом мимо него и клавишей Esc.
  useEffect(() => {
    if (memberMenu === null) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".member-menu") && !target.closest(".hall li.clickable")) {
        setMemberMenu(null);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMemberMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [memberMenu]);

  function toggleMemberMenu(m: Member, row: HTMLElement) {
    if (memberMenu?.id === m.id) {
      setMemberMenu(null);
      return;
    }
    const r = row.getBoundingClientRect();
    setMemberMenu({ id: m.id, top: r.top, bottom: r.bottom, left: r.left, width: r.width });
  }

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
    // Пока идёт трансляция экрана, окно mpv прячем — на его месте трансляция.
    const show =
      joinedRoom !== null &&
      player.running &&
      el !== null &&
      !screenShare &&
      !sharing &&
      !picking &&
      (playback?.media ?? null) !== null;
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
        // Углы — как у области видео в интерфейсе.
        radius: Math.round((fullscreen ? 0 : mini ? 10 : 14) * k),
      }).catch(() => {});
      // В полном экране и в мини-окне панель плеера — отдельное окно поверх низа видео.
      if (fullscreen || mini) {
        const h = Math.min(mini ? MINI_OVERLAY_HEIGHT : OVERLAY_HEIGHT, r.height);
        invoke("overlay_place", {
          rect: {
            x: Math.round(r.left * k),
            y: Math.round((r.bottom - h) * k),
            width: Math.round(r.width * k),
            height: Math.round(h * k),
          },
        }).catch((err) => setError(String(err)));
      }
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
  }, [joinedRoom, player.running, chatOpen, fullscreen, mini, screenShare, sharing, picking, playback?.media]);

  // ----- Связь с панелью поверх видео -----

  const overlayState: OverlayState = {
    mini,
    canControl: isHost && player.running && player.loaded === (playback?.media ?? null),
    controlHint: isHost ? "Сначала открой видео" : `Пульт у ${hostNameOf(members, host) ?? "другого"}`,
    title: playback?.media ? mediaTitle(playback.media) : "Ничего не выбрано",
    status: playbackStatus(playback, isHost, hostNameOf(members, host)),
    tracks,
    quality,
    qualityEnabled: playback?.media != null && isUrl(playback.media),
  };
  const overlayJson = JSON.stringify(overlayState);
  const overlayJsonRef = useRef(overlayJson);
  overlayJsonRef.current = overlayJson;

  useEffect(() => {
    if (fullscreen || mini) emit("overlay-state", JSON.parse(overlayJson)).catch(() => {});
  }, [overlayJson, fullscreen, mini]);

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];
    const keep = (u: () => void) => (active ? unlisteners.push(u) : u());
    listen("overlay-ready", () => {
      emit("overlay-state", JSON.parse(overlayJsonRef.current)).catch(() => {});
    }).then(keep);
    listen<boolean>("overlay-hover", (e) => (overControlsRef.current = e.payload)).then(keep);
    listen<PlayerKey>("overlay-key", (e) => onKeyRef.current(e.payload)).then(keep);
    listen<string>("overlay-quality", (e) => {
      setQuality(e.payload);
      save("quality", e.payload);
    }).then(keep);
    listen<string>("overlay-error", (e) => setError(e.payload)).then(keep);
    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
  }, []);

  if (!joinedRoom) {
    return (
      <main className="login">
        <LoginArt />

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
              <LogsButton />
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
      ? `Пульт у тебя, в зале ещё ${people(others)}`
      : "Пульт у тебя, в зале пока никого"
    : `Пульт у ${hostName ?? "кого-то"}, в зале ${people(members.length)}`;

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

  const roomClass = [
    "room",
    fullscreen && "fullscreen",
    mini && "mini",
    !chatOpen && "chat-hidden",
    fullscreen && controlsHidden && "controls-hidden",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={roomClass}>
      <section className="stage">
        {!fullscreen && !mini && (
          <header className="stage-header">
            <div className="room-title">
              <h1>{joinedRoom}</h1>
              <p>{roomStatus}</p>
            </div>
            <div className="header-actions">
              {isHost && media !== null && (
                <button
                  className="ghost close-media"
                  onClick={() => run(() => invoke("close_media"))}
                  title="Закрыть видео у всех"
                >
                  <Icon name="close" size={17} />
                  Закрыть видео
                </button>
              )}
              <button
                className={sharing ? "ghost sharing" : "ghost"}
                onClick={toggleScreenShare}
                disabled={voiceStatus !== "connected"}
                title={
                  voiceStatus === "connected"
                    ? sharing
                      ? "Остановить показ экрана"
                      : "Показать друзьям экран или окно со звуком"
                    : "Показ экрана работает, когда подключён голос"
                }
              >
                <Icon name="cast" size={17} />
                {sharing ? "Остановить показ" : "Показать экран"}
              </button>
              <button className="ghost" onClick={() => setChatOpen((o) => !o)} title="Tab">
                <Icon name="panel" size={17} />
                {chatOpen ? "Скрыть чат" : "Показать чат"}
              </button>
              <button className="ghost" onClick={handleLeave}>
                Выйти из зала
              </button>
            </div>
          </header>
        )}

        {reconnecting && (
          <div className="notice reconnecting" role="status">
            <span>Связь с сервером пропала. Переподключаюсь — видео пока идёт дальше.</span>
          </div>
        )}
        {!fullscreen && !mini && (
          <form className="source-bar" onSubmit={handleOpenUrl}>
            <label className="source-input">
              <Icon name="link" size={18} />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={
                  isHost
                    ? "Вставь ссылку на YouTube, VK Видео или Rutube"
                    : "Предложи, что посмотреть: ссылка на видео"
                }
                aria-label="Ссылка на видео"
              />
              {isHost && (
                <button
                  type="button"
                  className="ghost"
                  disabled={!url.trim()}
                  onClick={handleSuggest}
                  title="Добавить в список «Что посмотреть»"
                >
                  В список
                </button>
              )}
              <button type="submit" className="quiet" disabled={!url.trim()}>
                {isHost ? "Открыть" : "Предложить"}
              </button>
            </label>
          </form>
        )}
        {!fullscreen && !mini && needsFile && (
          <div className="notice">
            <span>
              {hostName ?? "Ведущий"} включил «{media}». Открой у себя этот же файл.
            </span>
            <button className="primary" onClick={handleOpenFile}>
              Выбрать файл
            </button>
          </div>
        )}
        {!fullscreen && !mini && needsReopen && (
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
          {screenShare && !sharing ? (
            <>
              <video ref={screenRef} className="screen-share" autoPlay playsInline muted />
              <span className="screen-badge">
                <Icon name="cast" size={14} />
                Экран показывает{" "}
                {members.find((m) => String(m.id) === screenShare.identity)?.name ?? "кто-то"}
              </span>
            </>
          ) : sharing ? (
            <div className="video-placeholder">
              <p>Ты показываешь экран — друзья видят его вместо плеера.</p>
              <button className="quiet" onClick={toggleScreenShare}>
                Остановить показ
              </button>
            </div>
          ) : (
          <div className="video-placeholder">
            {media
              ? player.running
                ? "Загружаю видео…"
                : `Сейчас смотрят «${mediaTitle(media)}»`
              : isHost
                ? "Вставь ссылку сверху — видео начнётся у всех одновременно"
                : `Ждём, пока ${hostName ?? "ведущий"} выберет, что смотрим`}
          </div>
          )}
        </div>

        {!mini && (
        <PlayerControls
          onHover={(over) => (overControlsRef.current = over)}
          info={info}
          canControl={isHost && player.running && player.loaded === media}
          controlHint={isHost ? "Сначала открой видео" : `Пульт у ${hostName ?? "другого"}`}
          title={media ? mediaTitle(media) : "Ничего не выбрано"}
          status={playbackStatus(playback, isHost, hostName)}
          scrub={scrub}
          onScrub={setScrub}
          tracks={tracks}
          quality={quality}
          qualityEnabled={media !== null && isUrl(media)}
          onQuality={changeQuality}
          onError={(err) => setError(err)}
          fullscreen={fullscreen}
          onFullscreen={() => applyFullscreen(!fullscreen)}
          onMini={() => applyMini(true)}
        />
        )}
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
            <ul onScroll={() => setMemberMenu(null)}>
              {members.map((m) => {
                const speaking = speakers.has(String(m.id));
                const manageable = isHost && m.id !== me;
                return (
                  <li
                    key={m.id}
                    className={[manageable && "clickable", memberMenu?.id === m.id && "open"]
                      .filter(Boolean)
                      .join(" ")}
                    role={manageable ? "button" : undefined}
                    tabIndex={manageable ? 0 : undefined}
                    title={manageable ? "Передать пульт или выгнать" : undefined}
                    aria-haspopup={manageable ? "menu" : undefined}
                    aria-expanded={manageable ? memberMenu?.id === m.id : undefined}
                    onClick={manageable ? (e) => toggleMemberMenu(m, e.currentTarget) : undefined}
                    onKeyDown={
                      manageable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleMemberMenu(m, e.currentTarget);
                            }
                          }
                        : undefined
                    }
                  >
                    <span
                      className={["seat", speaking && "speaking", !m.online && "offline"]
                        .filter(Boolean)
                        .join(" ")}
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
                      {!m.online ? (
                        <span className="seat-role">переподключается…</span>
                      ) : (
                        m.id === host && <span className="seat-role">держит пульт</span>
                      )}
                    </span>
                    {(m.deaf || (m.in_voice && !m.mic)) && (
                      <span className="seat-icons">
                        {m.in_voice && !m.mic && !m.deaf && (
                          <span title="Микрофон выключен">
                            <Icon name="mic-off" size={15} />
                          </span>
                        )}
                        {m.deaf && (
                          <span title="Выключил звук">
                            <Icon name="headphones-off" size={15} />
                          </span>
                        )}
                      </span>
                    )}
                    {manageable && (
                      <span className="seat-more" aria-hidden="true">
                        <Icon name="more" />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {memberMenu &&
              isHost &&
              (() => {
                const m = members.find((x) => x.id === memberMenu.id);
                return (
                  m && (
                    <MemberMenu
                      key={m.id}
                      member={m}
                      anchor={memberMenu}
                      onClose={() => setMemberMenu(null)}
                      onTransfer={() => handleTransfer(m)}
                      onKick={() => handleKick(m)}
                    />
                  )
                );
              })()}
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

              <div className="setting">
                <span className="setting-label">Если что-то не работает</span>
                <LogsButton />
              </div>

              <button className="primary" onClick={() => setVoiceSettings(false)}>
                Готово
              </button>
            </div>
          ) : (
            <>
            <div className="side-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={sideTab === "chat"}
                className={sideTab === "chat" ? "active" : ""}
                onClick={() => setSideTab("chat")}
              >
                Чат
              </button>
              <button
                role="tab"
                aria-selected={sideTab === "suggest"}
                className={sideTab === "suggest" ? "active" : ""}
                onClick={() => setSideTab("suggest")}
              >
                Что посмотреть
                {suggestions.length > 0 && <span className="count">{suggestions.length}</span>}
              </button>
            </div>
            {sideTab === "suggest" ? (
              <SuggestionsPanel
                list={spin ? spin.list : suggestions}
                me={me}
                isHost={isHost}
                highlight={spinIndex}
                spinning={spin !== null}
                done={spinDone}
                onPlay={(x) => run(() => invoke("open_url", { url: x.media }))}
                onRemove={(x) => run(() => send({ type: "remove_suggestion", id: x.id }))}
                onSpin={() =>
                  run(() =>
                    send({ type: "spin", weights: spinWeights(suggestions, weights) }),
                  )
                }
                wheel={
                  <RouletteWheel
                    list={spin ? spin.list : suggestions}
                    winner={spin ? spin.winner : null}
                    title={mediaTitle}
                  />
                }
                admin={
                  adminOpen ? (
                    <AdminPanel
                      list={suggestions}
                      weights={weights}
                      onChange={(id, percent) =>
                        setWeights((m) => {
                          const next = new Map(m);
                          if (percent === null) next.delete(id);
                          else next.set(id, percent);
                          return next;
                        })
                      }
                      onReset={() => setWeights(new Map())}
                      onClose={() => setAdminOpen(false)}
                      isHost={isHost}
                    />
                  ) : null
                }
              />
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
                    {(() => {
                      const sticker = stickerFromMessage(l.text);
                      return sticker ? (
                        <StickerArt sticker={sticker} size={112} />
                      ) : (
                        <RichText text={l.text} />
                      );
                    })()}
                  </div>
                ),
              )}
              <div ref={chatEndRef} />
            </div>
            )}
            </>
          )}

          {error && (
            <p className="error side-error" onClick={() => setError(null)} title="Скрыть">
              {error}
            </p>
          )}
          {!voiceSettings && (
            <form className="composer" onSubmit={handleSend}>
              {emojiOpen && (
                <div className="emoji-picker" role="dialog" aria-label="Смайлики">
                  <div className="emoji-grid">
                    {(emojiGroup === -1 ? recent : EMOJI_GROUPS[emojiGroup].list).map((e) => (
                      <button key={e} type="button" onClick={() => insertEmoji(e)} title={e}>
                        <EmojiGlyph emoji={e} />
                      </button>
                    ))}
                  </div>
                  <div className="emoji-tabs" role="tablist">
                    {recent.length > 0 && (
                      <button
                        type="button"
                        role="tab"
                        className={emojiGroup === -1 ? "active" : ""}
                        onClick={() => setEmojiGroup(-1)}
                        title="Недавние"
                      >
                        🕘
                      </button>
                    )}
                    {EMOJI_GROUPS.map((g, i) => (
                      <button
                        key={g.title}
                        type="button"
                        role="tab"
                        className={emojiGroup === i ? "active" : ""}
                        onClick={() => setEmojiGroup(i)}
                        title={g.title}
                      >
                        <EmojiGlyph emoji={g.icon} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {stickersOpen && (
                <div className="emoji-picker sticker-picker" role="dialog" aria-label="Стикеры">
                  {STICKERS.map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      title={st.title}
                      onClick={() => {
                        setStickersOpen(false);
                        run(() => send({ type: "chat", text: stickerMessage(st.id) }));
                      }}
                    >
                      <StickerArt sticker={st} size={64} />
                    </button>
                  ))}
                </div>
              )}
              <div className="composer-row">
                <input
                  ref={draftRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={() => setSideTab("chat")}
                  disabled={reconnecting}
                  placeholder={reconnecting ? "Ждём связь с сервером…" : "Написать в зал"}
                  aria-label="Сообщение"
                  maxLength={2000}
                />
                <button
                  type="button"
                  className={emojiOpen ? "icon active" : "icon"}
                  onClick={() => {
                    setStickersOpen(false);
                    setEmojiOpen((o) => !o);
                  }}
                  aria-label="Смайлики"
                  title="Смайлики"
                >
                  <Icon name="smile" size={18} />
                </button>
                <button
                  type="button"
                  className={stickersOpen ? "icon active" : "icon"}
                  onClick={() => {
                    setEmojiOpen(false);
                    setStickersOpen((o) => !o);
                  }}
                  aria-label="Стикеры"
                  title="Стикеры"
                >
                  <Icon name="sticker" size={18} />
                </button>
              </div>
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

/**
 * Секретный пульт админа: шанс каждого предложения в процентах.
 * Пустое поле — «как у всех»: остаток процентов делится поровну между ними.
 */
function AdminPanel({
  list,
  weights,
  onChange,
  onReset,
  onClose,
  isHost,
}: {
  list: Suggestion[];
  weights: Map<number, number>;
  onChange: (id: number, percent: number | null) => void;
  onReset: () => void;
  onClose: () => void;
  isHost: boolean;
}) {
  const fixed = list.filter((x) => weights.has(x.id));
  const fixedSum = fixed.reduce((sum, x) => sum + (weights.get(x.id) ?? 0), 0);
  const free = list.length - fixed.length;
  const share = free > 0 ? Math.max(0, 100 - fixedSum) / free : 0;
  const total = fixedSum + share * free;
  return (
    <div className="admin-panel" role="dialog" aria-label="Пульт админа">
      <div className="admin-head">
        <span>🤫 Пульт админа</span>
        <button className="icon" onClick={onClose} aria-label="Закрыть">
          <Icon name="close" />
        </button>
      </div>
      {list.length === 0 ? (
        <p className="suggestions-empty">Список пуст — подкручивать нечего.</p>
      ) : (
        <>
          {list.map((x) => (
            <label key={x.id} className="admin-row">
              <span className="suggestion-title">{mediaTitle(x.media)}</span>
              <input
                type="number"
                min={0}
                max={100}
                step="any"
                inputMode="decimal"
                placeholder={share.toFixed(share < 10 ? 2 : 1)}
                value={weights.has(x.id) ? String(weights.get(x.id)) : ""}
                onChange={(e) => {
                  const v = e.target.value.replace(",", ".").trim();
                  const n = Number(v);
                  onChange(x.id, v === "" || !Number.isFinite(n) ? null : Math.min(Math.max(n, 0), 100));
                }}
              />
              <span className="pct">%</span>
            </label>
          ))}
          <span className={Math.abs(total - 100) > 0.0001 ? "admin-total warn" : "admin-total"}>
            {Math.abs(total - 100) > 0.0001
              ? `В сумме ${+total.toFixed(4)}% — шансы посчитаются пропорционально.`
              : "В сумме 100%."}
          </span>
        </>
      )}
      <div className="admin-foot">
        <span className="suggestion-by">
          {isHost ? "Колесо об этом не узнает." : "Сработает, только когда пульт у тебя."}
        </span>
        <button className="quiet" onClick={onReset}>
          Честно
        </button>
      </div>
    </div>
  );
}

/** Шансы для сервера: у каждого предложения свой вес (проценты). */
function spinWeights(list: Suggestion[], percents: Map<number, number>): Array<[number, number]> {
  const fixed = list.filter((x) => percents.has(x.id));
  if (fixed.length === 0) return [];
  const fixedSum = fixed.reduce((sum, x) => sum + (percents.get(x.id) ?? 0), 0);
  const free = list.length - fixed.length;
  const share = free > 0 ? Math.max(0, 100 - fixedSum) / free : 0;
  return list.map((x) => [x.id, percents.get(x.id) ?? share]);
}

/** Список «Что посмотреть» и рулетка по нему. */
function SuggestionsPanel({
  list,
  me,
  isHost,
  highlight,
  spinning,
  done,
  onPlay,
  onRemove,
  onSpin,
  wheel,
  admin,
}: {
  wheel: ReactNode;
  admin: ReactNode;
  list: Suggestion[];
  me: MemberId | null;
  isHost: boolean;
  highlight: number | null;
  spinning: boolean;
  done: boolean;
  onPlay: (s: Suggestion) => void;
  onRemove: (s: Suggestion) => void;
  onSpin: () => void;
}) {
  return (
    <div className="suggestions">
      {admin}
      {list.length > 0 && wheel}
      {list.length === 0 ? (
        <p className="suggestions-empty">
          Пока пусто. Вставь ссылку в поле сверху и нажми «{isHost ? "В список" : "Предложить"}» —
          а тот, у кого пульт, включит или крутанёт рулетку.
        </p>
      ) : (
        <ul>
          {list.map((x, i) => (
            <li
              key={x.id}
              className={[
                highlight === i && "lit",
                highlight === i && done && "winner",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="suggestion-text">
                <span className="suggestion-title" title={x.media}>
                  {mediaTitle(x.media)}
                </span>
                <span className="suggestion-by">предложил(а) {x.name}</span>
              </span>
              {isHost && (
                <button
                  className="icon"
                  onClick={() => onPlay(x)}
                  disabled={spinning}
                  title="Включить сейчас"
                  aria-label="Включить"
                >
                  <Icon name="play" />
                </button>
              )}
              {(isHost || x.by === me) && (
                <button
                  className="icon"
                  onClick={() => onRemove(x)}
                  disabled={spinning}
                  title="Убрать из списка"
                  aria-label="Убрать"
                >
                  <Icon name="close" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {isHost && list.length > 0 && (
        <button className="primary roulette" onClick={onSpin} disabled={spinning}>
          <Icon name="dice" size={18} />
          {spinning ? "Крутится…" : "Крутить рулетку"}
        </button>
      )}
      {!isHost && spinning && <p className="suggestions-empty">Рулетка крутится…</p>}
    </div>
  );
}

/** Где открыть меню участника: строка, по которой кликнули. */
type MenuAnchor = { id: MemberId; top: number; bottom: number; left: number; width: number };

/**
 * Меню участника для ведущего: передать управление или выгнать из зала.
 * Действие подтверждается тут же, вторым нажатием, без системных окон.
 */
function MemberMenu({
  member,
  anchor,
  onClose,
  onTransfer,
  onKick,
}: {
  member: Member;
  anchor: MenuAnchor;
  onClose: () => void;
  onTransfer: () => void;
  onKick: () => void;
}) {
  const [confirm, setConfirm] = useState<"transfer" | "kick" | null>(null);
  // Под строкой, а если внизу не хватает места — над ней.
  const below = window.innerHeight - anchor.bottom > 190;
  const style: CSSProperties = {
    left: anchor.left,
    width: Math.max(anchor.width, 240),
    ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }),
  };

  return (
    <div className="member-menu" role="menu" style={style}>
      <div className="member-menu-head">
        <span className="seat small" style={{ background: SEAT_COLORS[colorIndex(member.name)] }}>
          {initial(member.name)}
        </span>
        <span className="member-menu-name">{member.name}</span>
      </div>

      {confirm === null ? (
        <>
          <button role="menuitem" autoFocus onClick={() => setConfirm("transfer")}>
            <Icon name="crown" />
            Передать пульт
          </button>
          <button role="menuitem" className="danger" onClick={() => setConfirm("kick")}>
            <Icon name="leave" />
            Выгнать из зала
          </button>
        </>
      ) : (
        <div className="member-menu-confirm">
          <p>
            {confirm === "kick"
              ? `Выгнать ${member.name}? Зайти обратно он сможет сам.`
              : `${member.name} будет ставить видео, паузу и перемотку за всех.`}
          </p>
          <div className="member-menu-actions">
            <button className="ghost" onClick={() => setConfirm(null)}>
              Отмена
            </button>
            <button
              className={confirm === "kick" ? "danger-solid" : "lamp"}
              autoFocus
              onClick={() => {
                onClose();
                if (confirm === "kick") onKick();
                else onTransfer();
              }}
            >
              {confirm === "kick" ? "Выгнать" : "Передать"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Панель плеера в отдельном прозрачном окне поверх видео (полный экран).
 * Состояние присылает главное окно, а управляет плеером панель напрямую.
 */
export function ControlsOverlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [visible, setVisible] = useState(true);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("overlay");
    let active = true;
    const unlisteners: Array<() => void> = [];
    const keep = (u: () => void) => (active ? unlisteners.push(u) : u());
    listen<OverlayState>("overlay-state", (e) => setState(e.payload)).then(keep);
    listen<boolean>("overlay-visible", (e) => setVisible(e.payload)).then(keep);
    emit("overlay-ready").catch(() => {});

    const poll = () =>
      invoke<PlaybackInfo>("player_info")
        .then((i) => active && setInfo(i))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 400);

    // Клавиши, пока фокус в панели: пауза и перемотка — сами,
    // полный экран и чат — главному окну.
    const onKey = (e: KeyboardEvent) => {
      const key: PlayerKey | null =
        e.key === "Escape"
          ? "exit-fullscreen"
          : e.code === "KeyF"
            ? "fullscreen"
            : e.key === "Tab"
              ? "toggle-chat"
              : null;
      if (key) {
        e.preventDefault();
        emit("overlay-key", key).catch(() => {});
      } else if (e.code === "Space" && (e.target as HTMLElement).tagName !== "BUTTON") {
        e.preventDefault();
        control({ type: "toggle_pause" }).catch(() => {});
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        e.preventDefault();
        control({ type: "seek_by", delta: e.key === "ArrowLeft" ? -5 : 5 }).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
      unlisteners.forEach((u) => u());
    };
  }, []);

  if (!state) return null;

  return (
    <div
      className={["overlay-panel", state.mini && "mini", !visible && "hidden"]
        .filter(Boolean)
        .join(" ")}
    >
      <PlayerControls
        onHover={(over) => emit("overlay-hover", over).catch(() => {})}
        info={info}
        canControl={state.canControl}
        controlHint={state.controlHint}
        title={state.title}
        status={state.status}
        scrub={scrub}
        onScrub={setScrub}
        tracks={state.tracks}
        quality={state.quality}
        qualityEnabled={state.qualityEnabled}
        onQuality={(value) => {
          invoke("set_quality", { height: value ? Number(value) : null }).catch(() => {});
          emit("overlay-quality", value).catch(() => {});
        }}
        onError={(message) => emit("overlay-error", message).catch(() => {})}
        fullscreen={!state.mini}
        onFullscreen={() => emit("overlay-key", "exit-fullscreen").catch(() => {})}
        mini={state.mini}
        onMini={
          state.mini ? () => emit("overlay-key", "exit-fullscreen").catch(() => {}) : undefined
        }
      />
    </div>
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
  suggest: "film",
  roulette: "dice",
};

function PlayerControls({
  onHover,
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
  mini = false,
  onMini,
  onClose,
}: {
  onHover: (over: boolean) => void;
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
  /** Мини-окно: без дорожек и качества, с кнопкой «развернуть». */
  mini?: boolean;
  /** Нет в панели поверх полноэкранного видео. */
  onMini?: () => void;
  /** Закрыть видео у всех (только у ведущего). */
  onClose?: () => void;
}) {
  const duration = info?.duration ?? 0;
  const position = scrub ?? info?.position ?? 0;
  const paused = info?.paused ?? true;
  // Пока тянешь ползунок громкости, он слушается только тебя, а не
  // значения, которое приходит из плеера раз в 0,4 секунды.
  const [volumeDrag, setVolumeDrag] = useState<number | null>(null);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const volume = volumeDrag ?? info?.volume ?? 100;
  const send = (c: Control) => control(c).catch((err) => onError(String(err)));

  const onVolume = (value: number) => {
    setVolumeDrag(value);
    send({ type: "volume", value });
    clearTimeout(volumeTimer.current);
    // Отдаём управление обратно плееру, когда mpv точно применил громкость.
    volumeTimer.current = setTimeout(() => setVolumeDrag(null), 800);
  };

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
    <div
      className="controls"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
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
            onChange={(e) => onVolume(Number(e.target.value))}
          />
        </label>
        {onClose && (
          <button
            className="ghost icon"
            onClick={onClose}
            title="Закрыть видео у всех"
            aria-label="Закрыть видео"
          >
            <Icon name="close" size={18} />
          </button>
        )}
        {onMini && !fullscreen && (
          <button
            className="ghost icon"
            onClick={onMini}
            title={mini ? "Развернуть окно: Esc" : "Мини-окно поверх всех окон"}
            aria-label={mini ? "Развернуть окно" : "Мини-окно"}
          >
            <Icon name={mini ? "pip-exit" : "pip"} size={20} />
          </button>
        )}
        {/* В правом нижнем углу, на одной линии с краем видео. */}
        <button
          className="ghost icon fullscreen-toggle"
          onClick={onFullscreen}
          title={fullscreen ? "Выйти из полного экрана: Esc" : "На весь экран: F"}
          aria-label={fullscreen ? "Выйти из полного экрана" : "На весь экран"}
        >
          <Icon name={fullscreen ? "exit-fullscreen" : "fullscreen"} size={20} />
        </button>
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
  | "pause-solid"
  | "pip"
  | "pip-exit"
  | "cast"
  | "smile"
  | "dice"
  | "sticker";

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
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4 4 0 0 0 7 0" />
      <line x1="9" y1="9.5" x2="9.01" y2="9.5" />
      <line x1="15" y1="9.5" x2="15.01" y2="9.5" />
    </>
  ),
  sticker: (
    <>
      <path d="M15 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h7l8-8V6a3 3 0 0 0-3-3z" />
      <path d="M13 21v-5a3 3 0 0 1 3-3h5" />
    </>
  ),
  dice: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <line x1="8" y1="8" x2="8.01" y2="8" />
      <line x1="16" y1="8" x2="16.01" y2="8" />
      <line x1="12" y1="12" x2="12.01" y2="12" />
      <line x1="8" y1="16" x2="8.01" y2="16" />
      <line x1="16" y1="16" x2="16.01" y2="16" />
    </>
  ),
  pip: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect x="12" y="12" width="7" height="5" rx="1" />
    </>
  ),
  "pip-exit": (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="9 9 15 9 15 15" />
      <line x1="15" y1="9" x2="8" y2="16" />
    </>
  ),
  cast: (
    <>
      <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <path d="M2 12a9 9 0 0 1 8 8" />
      <path d="M2 16a5 5 0 0 1 4 4" />
      <line x1="2" y1="20" x2="2.01" y2="20" />
    </>
  ),
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
