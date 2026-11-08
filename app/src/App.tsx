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
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
  UserAttentionType,
} from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isUrl,
  type ChatReply,
  type ClientMsg,
  type Control,
  type Cover,
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
import { pageTitle, SITES, siteOf, videoLink, type Site } from "./browse";
import { EMOJI_GROUPS, recentEmoji, rememberEmoji } from "./emoji";
import { savedTheme, setTheme, THEMES, type ThemeId } from "./theme";
import { IS_ANDROID } from "./platform";
import { isTv } from "./tv";
import { checkForUpdate, installUpdate, setBeforeUpdate, useAppVersion, useUpdate } from "./update";
import { knownTitle, rememberTitle, requestTitle, useTitles } from "./titles";
import { EmojiGlyph, RichText } from "./RichText";
import { RouletteWheel, SPIN_MS } from "./Roulette";
import { STICKERS, StickerArt, stickerFromMessage, stickerMessage } from "./stickers";
import { ReactionPicker, ReactionsLayer } from "./Reactions";
import { setSoundsEnabled, sound, soundsEnabled } from "./sounds";
import { keyName, listMicrophones, VoiceClient, type ScreenShare, type VoiceStatus } from "./voice";

type VoiceMode = "open" | "ptt";

/** Значок у события в чате. */
type EventIcon = "enter" | "leave" | "play" | "pause" | "seek" | "media" | "host" | "suggest" | "roulette";

type ChatLine =
  | {
      key: number;
      kind: "chat";
      name: string;
      text: string;
      mine: boolean;
      /** Ответ на сообщение: кто и что написал. */
      reply?: ChatReply | null;
      /** Обратились ко мне: @имя или ответ на моё сообщение. */
      mention?: boolean;
    }
  | {
      key: number;
      kind: "system";
      /** `{title}` в тексте заменяется названием `media`, когда оно станет известно. */
      text: string;
      icon: EventIcon;
      media?: string;
    };

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
  canShareSubtitles: boolean;
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

/** Название видео с сайта, а пока оно не пришло — коротко ссылка. */
function mediaTitle(media: string): string {
  const known = knownTitle(media);
  if (known) return known;
  if (!isUrl(media)) return media;
  requestTitle(media);
  return shortLink(media);
}

/** Ссылку показываем коротко: сайт и начало пути. */
function shortLink(media: string): string {
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
/** Страничка приглашения (папка site/ репозитория на GitHub Pages). */
const INVITE_PAGE = "https://ferrumnyak.github.io/BrotherHub/";

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

/** Постоянный случайный номер этого устройства: по нему сервер узнаёт
 *  того, кто создал комнату, и возвращает ему пульт. */
function deviceId(): string {
  let id = load("device", "");
  if (!/^[0-9a-f]{32}$/.test(id)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    save("device", id);
  }
  return id;
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

/** Выбор темы оформления. */
export function ThemePicker() {
  const [theme, setThemeState] = useState<ThemeId>(savedTheme);
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Тема">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={theme === t.id}
          className={theme === t.id ? "theme-chip active" : "theme-chip"}
          onClick={() => {
            setTheme(t.id);
            setThemeState(t.id);
          }}
          title={t.title}
        >
          <span className="theme-swatch">
            {t.swatch.map((c) => (
              <i key={c} style={{ background: c }} />
            ))}
          </span>
          {t.title}
        </button>
      ))}
    </div>
  );
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

/** Подпись к кнопке обновления: «Обновить» или ход установки. */
function updateLabel(installing: number | null | undefined, version: string) {
  if (installing === undefined) return `Обновить до ${version}`;
  if (installing === null || installing >= 1) return "Устанавливаю…";
  return `Скачиваю ${Math.round(installing * 100)}%`;
}

/** Кнопка в шапке зала, когда вышла новая версия. */
function UpdatePill() {
  const u = useUpdate();
  if (!u.available) return null;
  return (
    <button
      className="ghost update-pill"
      disabled={u.installing !== undefined}
      onClick={installUpdate}
      title={u.error ?? u.available.notes ?? "Скачать и поставить новую версию — приложение перезапустится"}
    >
      {updateLabel(u.installing, u.available.version)}
    </button>
  );
}

/** Карточка на экране входа, когда вышла новая версия. */
function UpdateCard() {
  const u = useUpdate();
  if (!u.available) return null;
  return (
    <div className="update-card">
      <div>
        <strong>Вышла версия {u.available.version}</strong>
        <span>{u.error ?? u.available.notes ?? "Обновится и перезапустится само"}</span>
      </div>
      <button
        type="button"
        className="primary"
        disabled={u.installing !== undefined}
        onClick={installUpdate}
      >
        {u.installing === undefined ? "Обновить" : updateLabel(u.installing, u.available.version)}
      </button>
    </div>
  );
}

/** Версия и «Проверить обновления» внизу экрана входа. */
function LoginVersion() {
  const version = useAppVersion();
  const u = useUpdate();
  return (
    <div className="login-version">
      <span>BrotherHub {version ?? ""}</span>
      {!u.available && (
        <button
          type="button"
          className="link-button"
          disabled={u.checking}
          onClick={() => checkForUpdate(true)}
        >
          {u.checking ? "Проверяю…" : u.upToDate ? "Это последняя версия" : "Проверить обновления"}
        </button>
      )}
      {u.error && <span className="error-text">{u.error}</span>}
    </div>
  );
}

/** Версия и ручная проверка обновлений — в настройках. */
function AppVersion() {
  const version = useAppVersion();
  const u = useUpdate();
  return (
    <div className="setting">
      <span className="setting-label">BrotherHub {version ?? ""}</span>
      {u.available ? (
        <button className="quiet" disabled={u.installing !== undefined} onClick={installUpdate}>
          {updateLabel(u.installing, u.available.version)}
        </button>
      ) : (
        <button className="quiet" disabled={u.checking} onClick={() => checkForUpdate(true)}>
          {u.checking ? "Проверяю…" : u.upToDate ? "Это последняя версия" : "Проверить обновления"}
        </button>
      )}
      {u.error && <span className="setting-hint error-text">{u.error}</span>}
    </div>
  );
}

/** Обложка вместо видео, когда играет музыка без картинки. */
function CoverView({ cover, paused }: { cover: Cover; paused: boolean }) {
  return (
    <div className="cover-view">
      {cover.image && (
        <div className="cover-backdrop" style={{ backgroundImage: `url("${cover.image}")` }} />
      )}
      <div className={paused ? "cover-art" : "cover-art playing"}>
        {cover.image ? (
          <img src={cover.image} alt="" draggable={false} />
        ) : (
          <span className="cover-note" aria-hidden="true">♪</span>
        )}
      </div>
      <div className="cover-text">
        {cover.title && <strong>{cover.title}</strong>}
        {cover.artist && <span>{cover.artist}</span>}
      </div>
    </div>
  );
}

/** Плитки площадок для выбора видео. */
function SitePicker({ onPick, isHost }: { onPick: (site: Site) => void; isHost: boolean }) {
  return (
    <div className="site-picker">
      <p className="site-picker-lead">
        {isHost
          ? "Выбери площадку, найди видео и включи его для всех"
          : "Выбери площадку и найди, что предложить"}
      </p>
      <div className="site-tiles">
        {SITES.map((site) => (
          <button key={site.id} className="site-tile" onClick={() => onPick(site)}>
            <span className="site-mark big" style={{ background: site.color }}>
              {site.mark}
            </span>
            <span className="site-name">{site.title}</span>
            <span className="site-hint">{site.hint}</span>
          </button>
        ))}
      </div>
    </div>
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
        <img className="login-logo" src="/logo.svg" alt="" />
        <span className="wordmark">BrotherHub</span>
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
  const [showThemes, setShowThemes] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [joinedRoom, setJoinedRoom] = useState<string | null>(null);
  const [me, setMe] = useState<MemberId | null>(null);
  const [host, setHost] = useState<MemberId | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [player, setPlayer] = useState<PlayerStatus>({ running: false, loaded: null });
  // Плеер запустился — возвращаем громкость, которая была в прошлый раз.
  useEffect(() => {
    if (!player.running) return;
    const v = Number(load("playerVolume", ""));
    if (load("playerVolume", "") !== "" && Number.isFinite(v)) {
      control({ type: "volume", value: Math.min(Math.max(v, 0), 130) }).catch(() => {});
    }
  }, [player.running]);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const [draft, setDraft] = useState("");
  // Ответ на сообщение, который сейчас пишем.
  const [replyTo, setReplyTo] = useState<ChatReply | null>(null);
  // Кто печатает: id → до какого времени показывать.
  const [typing, setTyping] = useState<Map<MemberId, number>>(new Map());
  const typingSentRef = useRef(0);
  // Мой статус («отошёл») и аватарка.
  const [myStatus, setMyStatus] = useState<string | null>(null);
  const [myAvatar, setMyAvatar] = useState<string | null>(() => load("avatar", "") || null);
  const oldServerWarnedRef = useRef(false);
  const [url, setUrl] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // Мини-окно поверх всех окон: только видео и короткая панель.
  const [mini, setMini] = useState(false);
  // Полоса заголовка (TitleBar) прячется в полном экране и сжимается в мини-окне.
  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("is-fullscreen", fullscreen);
    html.classList.toggle("is-mini", mini);
  }, [fullscreen, mini]);
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
  // Выбор видео на площадках: плитки площадок или открытый сайт.
  const [browsing, setBrowsing] = useState<"pick" | "site" | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browseNote, setBrowseNote] = useState<string | null>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  // Что посмотреть: общий список, рулетка и вкладка справа.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const suggestionsRef = useRef<Suggestion[]>([]);
  suggestionsRef.current = suggestions;
  const [sideTab, setSideTab] = useState<"chat" | "suggest" | "history">("chat");
  // Пришли новые названия видео — перерисовать чат, списки и рулетку.
  useTitles();
  // Обложка трека без картинки (музыка с SoundCloud и т.п.).
  const [cover, setCover] = useState<Cover | null>(null);
  // Что смотрели в этой комнате (хранится у каждого своё).
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Доиграло — включить следующее из «Что посмотреть» (решает тот, у кого пульт).
  const [autoNext, setAutoNext] = useState(() => load("autoNext", "1") === "1");
  const autoplayedRef = useRef<string | null>(null);
  // Рулетку запустили: когда закрутится и кто запустил.
  const [roulettePending, setRoulettePending] = useState<{ at: number; by: string } | null>(null);
  const [spin, setSpin] = useState<{ list: Suggestion[]; winner: number; by: string } | null>(
    null,
  );
  const [spinIndex, setSpinIndex] = useState<number | null>(null);
  const [spinDone, setSpinDone] = useState(false);
  // Секретный пульт админа и «подкрученные» шансы (id предложения → вес).
  const [adminOpen, setAdminOpen] = useState(false);
  const [weights, setWeights] = useState<Map<number, number>>(new Map());
  const [panelKey, setPanelKey] = useState(() => load("panelKey", ""));
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
    !IS_ANDROID && load("voiceMode", "open") === "ptt" ? "ptt" : "open",
  );
  const [micOn, setMicOn] = useState(true);
  const [sounds, setSounds] = useState(soundsEnabled);
  const [closeToTray, setCloseToTray] = useState(() => load("closeToTray", "0") === "1");
  useEffect(() => {
    invoke("tray_close_to_tray", { enabled: closeToTray }).catch(() => {});
  }, [closeToTray]);
  // Окно вернулось из трея — окна поверх видео заново встают на места.
  const [shownTick, setShownTick] = useState(0);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    listen("app-shown", () => setShownTick((t) => t + 1)).then((u) =>
      active ? (unlisten = u) : u(),
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  const [noise, setNoise] = useState<"standard" | "strong">(() =>
    load("noise", "strong") === "standard" ? "standard" : "strong",
  );
  // Щелчок при включении и выключении микрофона (не при входе в голос).
  const micSoundRef = useRef<boolean | null>(null);
  const [deafened, setDeafened] = useState(false);
  const [pttKey, setPttKey] = useState<number | null>(() => {
    const v = Number(load("pttKey", ""));
    return v > 0 ? v : null;
  });
  const [pttPressed, setPttPressed] = useState(false);
  const [capturing, setCapturing] = useState(false);
  // Клавиша «вкл/выкл микрофон» для режима «всегда включён».
  const [muteKey, setMuteKey] = useState<number | null>(() => {
    const v = Number(load("muteKey", ""));
    return load("muteKey", "") !== "" && Number.isFinite(v) ? v : null;
  });
  const [capturingMute, setCapturingMute] = useState(false);
  const capturingMuteRef = useRef(false);
  capturingMuteRef.current = capturingMute;
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
  // «СДВГ-режим»: сбоку от фильма без звука крутится второй ролик
  // (Subway Surfers, мыло, ковры…). У каждого свой, друзьям не уходит.
  const [adhd, setAdhd] = useState(() => load("adhd", "") === "1");
  const fullscreenRef = useRef(false);
  fullscreenRef.current = fullscreen;
  const miniRef = useRef(false);
  const overlaySession = useRef(0);
  miniRef.current = mini;

  const isHost = me !== null && me === host;
  const isHostRef = useRef(false);
  isHostRef.current = isHost;

  const addSystem = (text: string, icon: EventIcon, media?: string) =>
    setLines((l) => [...l, { key: ++keyRef.current, kind: "system", text, icon, media }]);

  // Подписка на события от Rust-части приложения.
  useEffect(() => {
    const nextKey = () => ++keyRef.current;
    const system = (text: string, icon: EventIcon, media?: string) =>
      setLines((l) => [...l, { key: nextKey(), kind: "system", text, icon, media }]);
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
          if (!msg.resumed) setMyStatus(null);
          setRoulettePending(
            msg.roulette ? { at: Date.now() + msg.roulette.seconds * 1000, by: msg.roulette.by } : null,
          );
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
          sound.join();
          break;
        case "member_left":
          sound.leave();
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
        case "chat": {
          const mine = msg.from === meRef.current;
          const myName = membersRef.current.find((m) => m.id === meRef.current)?.name ?? "";
          const mention =
            !mine &&
            myName !== "" &&
            (msg.text.toLowerCase().includes(`@${myName.toLowerCase()}`) ||
              msg.reply?.name === myName);
          setLines((l) => [
            ...l,
            {
              key: nextKey(),
              kind: "chat",
              name: msg.name,
              text: msg.text,
              mine,
              reply: msg.reply ?? null,
              mention,
            },
          ]);
          setTyping((t) => {
            if (!t.has(msg.from)) return t;
            const next = new Map(t);
            next.delete(msg.from);
            return next;
          });
          if (mention) {
            sound.mention();
            getCurrentWindow()
              .isFocused()
              .then((focused) => {
                if (!focused) getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
              })
              .catch(() => {});
          }
          break;
        }
        case "typing":
          setTyping((t) => new Map(t).set(msg.id, Date.now() + 5000));
          break;
        case "member_profile":
          setMembers((m) =>
            m.map((x) => (x.id === msg.id ? { ...x, status: msg.status, avatar: msg.avatar } : x)),
          );
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
            if (autoplayRef.current) {
              invoke("ui_log", { message: `автозапуск отменён: ${msg.action} от ${by}` }).catch(() => {});
            }
            autoplayRef.current = null;
          }
          switch (msg.action) {
            case "set_media":
              system(
                msg.playback.media ? `${by} включил «{title}»` : `${by} закрыл видео`,
                "media",
                msg.playback.media ?? undefined,
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
          // Старый сервер не знает новых сообщений — говорим об этом один раз.
          if (msg.message.includes("unknown variant")) {
            if (!oldServerWarnedRef.current) {
              oldServerWarnedRef.current = true;
              setError("Сервер старой версии — часть новых функций заработает после его обновления");
            }
            break;
          }
          setError(msg.message);
          break;
        case "suggestions": {
          const known = new Set(suggestionsRef.current.map((x) => x.id));
          for (const x of msg.list) {
            if (!known.has(x.id)) system(`${x.name} предлагает «{title}»`, "suggest", x.media);
          }
          suggestionsRef.current = msg.list;
          setSuggestions(msg.list);
          break;
        }
        case "roulette_countdown":
          setRoulettePending({ at: Date.now() + msg.seconds * 1000, by: msg.by });
          system(`${msg.by} запустил рулетку — закрутится через минуту, накидывайте, что посмотреть`, "roulette");
          setSideTab("suggest");
          break;
        case "roulette_cancelled":
          setRoulettePending(null);
          system(msg.by ? `${msg.by} отменил рулетку` : "Рулетка отменилась: список опустел", "roulette");
          break;
        case "roulette": {
          setRoulettePending(null);
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
      if (capturingMuteRef.current) {
        setMuteKey(e.payload);
        save("muteKey", String(e.payload));
        setCapturingMute(false);
        return;
      }
      setPttKey(e.payload);
      save("pttKey", String(e.payload));
      setCapturing(false);
    }).then(keep);
    listen("mute-toggle", () => setMicOn((on) => !on)).then(keep);
    listen<Track[]>("player-tracks", (e) => setTracks(e.payload)).then(keep);
    listen<Cover | null>("player-cover", (e) => setCover(e.payload)).then(keep);
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

  // Новое сообщение — листаем вниз только сам чат. scrollIntoView листал бы
  // и всю страницу: на телефоне она прокручивается, и ссылка с видео
  // каждый раз уезжали за верх экрана.
  useEffect(() => {
    const list = chatEndRef.current?.parentElement;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
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
    await connectTo(server, room);
  }

  // Обновление из зала: запомнить комнату и пропуск, после перезапуска
  // вернуться на своё место (тот же участник — без «двойника» в списке).
  useEffect(() => {
    setBeforeUpdate(async () => {
      if (!joinedRoom) return;
      const token = await invoke<string | null>("connection_token").catch(() => null);
      save("rejoin", JSON.stringify({ server, room: joinedRoom, token, at: Date.now() }));
    });
    return () => setBeforeUpdate(null);
  }, [joinedRoom, server]);

  useEffect(() => {
    let saved: { server: string; room: string; token: string | null; at: number } | null = null;
    try {
      saved = JSON.parse(load("rejoin", "null"));
    } catch {
      saved = null;
    }
    save("rejoin", "null");
    // Только сразу после обновления — через 10 минут это уже не «вернуться».
    if (!saved || Date.now() - saved.at > 10 * 60_000 || !name.trim()) return;
    setServer(saved.server);
    setRoom(saved.room);
    connectTo(saved.server, saved.room, saved.token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectTo(server: string, room: string, resume: string | null = null) {
    setError(null);
    setConnecting(true);
    save("server", server);
    save("name", name);
    save("room", room);
    save("password", password);
    try {
      await invoke("connect", {
        server,
        room,
        name,
        password: password || null,
        avatar: myAvatar,
        resume,
        device: deviceId(),
      });
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
    const reply = replyTo;
    setDraft("");
    setReplyTo(null);
    setEmojiOpen(false);
    typingSentRef.current = 0;
    await run(() => send({ type: "chat", text, reply }));
  }

  /** Пишу сообщение — раз в 3 секунды сообщаем остальным «печатает». */
  function onDraftChange(value: string) {
    setDraft(value);
    const now = Date.now();
    if (value.trim() && now - typingSentRef.current > 3000) {
      typingSentRef.current = now;
      send({ type: "typing" }).catch(() => {});
    }
  }

  /** Ответить на сообщение из чата. */
  function startReply(line: { name: string; text: string }) {
    const sticker = stickerFromMessage(line.text);
    const text = sticker ? `Стикер «${sticker.title}»` : line.text;
    setReplyTo({ name: line.name, text: text.length > 120 ? `${text.slice(0, 120)}…` : text });
    setSideTab("chat");
    requestAnimationFrame(() => draftRef.current?.focus());
  }

  // Упоминание: пишешь «@» — список людей, Tab или клик вставляет имя.
  const mentionQuery = (() => {
    const input = draftRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const m = /(^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
    return m ? m[2].toLowerCase() : null;
  })();
  const mentionOptions =
    mentionQuery === null
      ? []
      : members
          .filter((m) => m.id !== me && m.name.toLowerCase().startsWith(mentionQuery))
          .slice(0, 6);

  function insertMention(name: string) {
    const input = draftRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([^\s@]*)$/, `@${name} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(before.length, before.length);
    });
  }

  // Строчка «… печатает» гаснет сама, если человек перестал печатать.
  useEffect(() => {
    if (typing.size === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((map) => {
        const next = new Map([...map].filter(([, until]) => until > now));
        return next.size === map.size ? map : next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typing.size]);

  // «Ответить» из меню правой кнопки.
  useEffect(() => {
    const onReply = (e: Event) => {
      const key = (e as CustomEvent<number>).detail;
      const line = linesRef.current.find((l) => l.key === key);
      if (line && line.kind === "chat") startReply(line);
    };
    window.addEventListener("bh-reply", onReply);
    return () => window.removeEventListener("bh-reply", onReply);
  }, []);

  // Статус и аватарка — всем в зале.
  function changeProfile(status: string | null, avatar: string | null) {
    setMyStatus(status);
    setMyAvatar(avatar);
    save("avatar", avatar ?? "");
    if (joinedRoom) run(() => send({ type: "profile", status, avatar }));
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
    if (await offerPlaylist(link, "watch")) return;
    await run(() => invoke("open_url", { url: link }));
    setUrl("");
  }

  // ----- Плейлист или сезон сериала по ссылке -----

  const [playlistOffer, setPlaylistOffer] = useState<{
    link: string;
    mode: "watch" | "suggest";
    entries: { url: string; title: string | null }[];
  } | null>(null);
  const [playlistLoading, setPlaylistLoading] = useState(false);

  /** Ссылка на плейлист — предложить взять все серии. `true` — предложили. */
  async function offerPlaylist(link: string, mode: "watch" | "suggest"): Promise<boolean> {
    if (!looksLikePlaylist(link)) return false;
    setPlaylistLoading(true);
    try {
      const entries = await invoke<{ url: string; title: string | null }[]>("playlist_entries", {
        url: link,
      });
      if (entries.length < 2) return false;
      for (const e of entries) rememberTitle(e.url, e.title);
      setPlaylistOffer({ link, mode, entries });
      setUrl("");
      return true;
    } catch {
      return false; // не вышло — просто как одно видео
    } finally {
      setPlaylistLoading(false);
    }
  }

  async function acceptPlaylist(all: boolean) {
    const offer = playlistOffer;
    if (!offer) return;
    setPlaylistOffer(null);
    const [first, ...rest] = offer.entries;
    if (!all) {
      // Только одно видео: то, что в ссылке, или первая серия.
      const single = /[?&]v=/.test(offer.link) ? offer.link : first.url;
      if (offer.mode === "watch") await run(() => invoke("open_url", { url: single }));
      else await run(() => send({ type: "suggest", media: single }));
      return;
    }
    if (offer.mode === "watch") {
      await run(() => invoke("open_url", { url: first.url }));
      if (rest.length > 0) await run(() => send({ type: "suggest_many", media: rest.map((e) => e.url) }));
    } else {
      await run(() => send({ type: "suggest_many", media: offer.entries.map((e) => e.url) }));
    }
    setSideTab("suggest");
    if (!mini) setChatOpen(true);
  }

  // «Позвать»: приглашение для друга в буфер обмена (без пароля).
  // Ссылка ведёт на страничку, которая открывает BrotherHub сразу в этой
  // комнате, а если приложения нет — предлагает скачать.
  const [invited, setInvited] = useState(false);
  async function copyInvite() {
    const params = new URLSearchParams({ room: joinedRoom ?? "" });
    if (server !== DEFAULT_SERVER) params.set("server", server);
    const text = `Заходи смотреть в BrotherHub, комната «${joinedRoom}»: ${INVITE_PAGE}?${params}`;
    try {
      await navigator.clipboard.writeText(text);
      setInvited(true);
      setTimeout(() => setInvited(false), 2000);
    } catch {
      setError("Не удалось скопировать приглашение");
    }
  }

  async function handleSuggest() {
    const link = url.trim();
    if (!link) return;
    if (!isUrl(link)) {
      setError("Ссылка должна начинаться с http:// или https://");
      return;
    }
    if (await offerPlaylist(link, "suggest")) return;
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
    invoke("ui_log", { message: next ? "полный экран: вход" : "полный экран: выход" }).catch(() => {});
    if (IS_ANDROID) {
      // Телефон: альбомная ориентация без системных панелей, панель плеера —
      // поверх видео в том же интерфейсе.
      // Страница могла быть прокручена к чату — видео должно встать сверху.
      document.body.scrollTop = 0;
      window.scrollTo(0, 0);
      await invoke("mobile_fullscreen", { on: next }).catch(() => {});
      setFullscreen(next);
      setChatOpen(!next);
      return;
    }
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
        // Мини-окно развернули на весь экран — сначала вернуть обычное
        // состояние: размер у развёрнутого окна Windows меняет неправильно,
        // и интерфейс переставал реагировать на клики.
        const grown = await win.isMaximized();
        if (grown) await win.unmaximize();
        setMini(false);
        setChatOpen(restore?.chat ?? true);
        if (restore) {
          await win.setSize(restore.size);
          await win.setPosition(restore.position);
        }
        if (grown || restore?.maximized) await win.maximize();
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
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !typing && !isTv()) {
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
    // Новый сеанс панели поверх видео (см. overlay.rs).
    const session = ++overlaySession.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (visible: boolean) => {
      setControlsHidden(!visible);
      if (IS_ANDROID) return;
      emit("overlay-visible", visible).catch(() => {});
      // В полном экране панель накрывает всё видео и всегда ловит мышь:
      // только так можно спрятать курсор (над mpv он не прячется).
      // В мини-окне спрятанная панель пропускает клики к окну.
      invoke("overlay_interactive", { interactive: mini ? visible : true }).catch(() => {});
      // В полном экране вместе с панелью прячем и курсор.
      if (!mini) invoke("player_cursor", { hidden: !visible }).catch(() => {});
    };
    const poke = () => {
      show(true);
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          // На телефоне «мышь над панелью» после касания так и остаётся —
          // там прячем всегда, следующее касание покажет снова.
          if (!overControlsRef.current || IS_ANDROID) show(false);
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
    window.addEventListener("pointerdown", poke);
    return () => {
      window.removeEventListener("pointerdown", poke);
      active = false;
      clearTimeout(timer);
      unlisten?.();
      invoke("overlay_close", { session }).catch(() => {});
      invoke("player_cursor", { hidden: false }).catch(() => {});
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
      invoke("ui_log", { message: "автозапуск: запускаю" }).catch(() => {});
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
      addSystem("Рулетка выбрала «{title}»", "roulette", winner.media);
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

  // Шансы уходят на сервер, как только меняются они или список.
  // Крутит колесо тот, у кого пульт, но сервер возьмёт эти шансы.
  const rigSent = useRef(false);
  useEffect(() => {
    if (!joinedRoom) {
      rigSent.current = false;
      return;
    }
    const w = spinWeights(suggestions, weights);
    if (w.length === 0 && !rigSent.current) return;
    const t = setTimeout(() => {
      rigSent.current = w.length > 0;
      send({ type: "rig", weights: w, key: panelKey || null }).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [joinedRoom, suggestions, weights, panelKey]);

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

  // Ссылка-приглашение brotherhub://join?room=…: сразу в эту комнату.
  const inviteRef = useRef<(link: string) => void>(() => {});
  inviteRef.current = (link: string) => {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      return;
    }
    const nextRoom = url.searchParams.get("room")?.trim();
    if (!nextRoom) return;
    const nextServer = url.searchParams.get("server")?.trim() || server;
    if (joinedRoom === nextRoom && nextServer === server) return;
    setRoom(nextRoom);
    setServer(nextServer);
    (async () => {
      if (joinedRoom !== null) await handleLeave();
      // Без имени не войти — оставляем экран входа с заполненной комнатой.
      if (name.trim()) await connectTo(nextServer, nextRoom);
    })();
  };
  useEffect(() => {
    const take = () =>
      invoke<string | null>("deep_link_take")
        .then((link) => link && inviteRef.current(link))
        .catch(() => {});
    take();
    let unlisten: (() => void) | undefined;
    let active = true;
    listen("deep-link", take).then((u) => (active ? (unlisten = u) : u()));
    // На телефоне ссылку ловит Android: проверяем, когда приложение снова на экране.
    const onVisible = () => {
      if (document.visibilityState === "visible") take();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      unlisten?.();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Шумоподавление — при каждом подключении к голосу и при смене в настройках.
  useEffect(() => {
    if (voiceStatus === "connected") voice.setNoise(noise);
  }, [noise, voiceStatus, voice]);

  useEffect(() => {
    const connected = voiceStatus === "connected" && voiceMode === "open";
    if (!connected) {
      micSoundRef.current = null;
      return;
    }
    if (micSoundRef.current !== null && micSoundRef.current !== micOn) {
      if (micOn) sound.micOn();
      else sound.micOff();
    }
    micSoundRef.current = micOn;
  }, [micOn, voiceStatus, voiceMode]);

  // Глобальная кнопка «нажми и говори» работает, только пока мы в комнате.
  useEffect(() => {
    const active = joinedRoom !== null && voiceMode === "ptt" && pttKey !== null;
    invoke("ptt_set_key", { key: active ? pttKey : null }).catch(() => {});
    if (!active) setPttPressed(false);
  }, [joinedRoom, voiceMode, pttKey]);

  useEffect(() => {
    invoke("ptt_capture", { enabled: capturing || capturingMute }).catch(() => {});
  }, [capturing, capturingMute]);

  // Клавиша «вкл/выкл микрофон» — тоже глобальная, тоже только в комнате.
  useEffect(() => {
    const active = joinedRoom !== null && voiceMode === "open" && muteKey !== null;
    invoke("mute_set_key", { key: active ? muteKey : null }).catch(() => {});
  }, [joinedRoom, voiceMode, muteKey]);

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

  // Телефон: пока ты в зале, приложение работает и свёрнутым (фильм и голос
  // не обрываются) — Android показывает об этом уведомление.
  useEffect(() => {
    if (!IS_ANDROID) return;
    invoke("mobile_keep_alive", {
      room: joinedRoom,
      mic: voiceStatus === "connected",
    }).catch(() => {});
  }, [joinedRoom, voiceStatus]);

  // Второй плеер для СДВГ-режима живёт, пока режим включён и мы в зале.
  useEffect(() => {
    if (!adhd || joinedRoom === null) return;
    invoke("adhd_start").catch((err) => {
      setError(String(err));
      setAdhd(false);
    });
    return () => {
      invoke("adhd_stop").catch(() => {});
      invoke("set_side_rect", { rect: null }).catch(() => {});
    };
  }, [adhd, joinedRoom]);

  function toggleAdhd() {
    setAdhd((on) => {
      save("adhd", on ? "" : "1");
      return !on;
    });
  }

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
      browsing === null &&
      cover === null &&
      (playback?.media ?? null) !== null;
    const update = () => {
      if (!show || !el) {
        invoke("set_video_rect", { rect: null }).catch(() => {});
        invoke("set_side_rect", { rect: null }).catch(() => {});
        return;
      }
      const r = el.getBoundingClientRect();
      const k = window.devicePixelRatio || 1;
      // Углы — как у области видео в интерфейсе.
      const radius = Math.round((fullscreen ? 0 : mini ? 10 : 16) * k);
      // СДВГ-режим: фильм слева, ролик справа (ролики чаще вертикальные).
      const split = adhd && !mini;
      const gap = split ? 8 : 0;
      // Высокая область (телефон вертикально) — ролик снизу, как в тиктоке;
      // широкая — справа (ролики чаще вертикальные).
      const below = split && r.height > r.width * 0.7;
      // Фильм — ровно 16:9 по высоте (без чёрных полос), ролику — остаток.
      const mainWidth =
        split && !below ? Math.min(Math.round(r.height * (16 / 9)), Math.round(r.width * 0.75)) : r.width;
      const mainHeight = below ? Math.round(r.width * (9 / 16)) : r.height;
      invoke("set_video_rect", {
        rect: {
          x: Math.round(r.left * k),
          y: Math.round(r.top * k),
          width: Math.round((mainWidth - (split && !below ? gap / 2 : 0)) * k),
          height: Math.round((mainHeight - (below ? gap / 2 : 0)) * k),
        },
        radius,
      }).catch(() => {});
      invoke("set_side_rect", {
        rect: !split
          ? null
          : below
            ? {
                x: Math.round(r.left * k),
                y: Math.round((r.top + mainHeight + gap / 2) * k),
                width: Math.round(r.width * k),
                height: Math.round((r.height - mainHeight - gap / 2) * k),
              }
            : {
                x: Math.round((r.left + mainWidth + gap / 2) * k),
                y: Math.round(r.top * k),
                width: Math.round((r.width - mainWidth - gap / 2) * k),
                height: Math.round(r.height * k),
              },
        radius,
      }).catch(() => {});
    };
    update();
    if (!show || !el) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    // На телефоне страница прокручивается — видео под ней едет следом.
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      invoke("set_video_rect", { rect: null }).catch(() => {});
      invoke("set_side_rect", { rect: null }).catch(() => {});
    };
  }, [joinedRoom, player.running, chatOpen, fullscreen, mini, screenShare, sharing, picking, browsing, cover, playback?.media, adhd]);

  // Вернулись из трея с открытым «Обзором» — показать сайт обратно.
  useEffect(() => {
    if (shownTick === 0 || browsing !== "site") return;
    const rect = videoArea();
    if (rect) invoke("browser_place", { rect }).catch(() => {});
  }, [shownTick]);

  // Видео закрыли — обложка прошлого трека не нужна.
  useEffect(() => {
    if ((playback?.media ?? null) === null) setCover(null);
  }, [playback?.media]);

  // Окно реакций лежит над областью видео всё время, пока мы в зале
  // (кроме «Обзора»: там поверх видео сайт).
  useEffect(() => {
    const el = videoRef.current;
    if (joinedRoom === null || browsing !== null || !el) {
      invoke("reactions_place", { rect: null }).catch(() => {});
      return;
    }
    const place = () => {
      const r = el.getBoundingClientRect();
      const k = window.devicePixelRatio || 1;
      invoke("reactions_place", {
        rect: {
          x: Math.round(r.left * k),
          y: Math.round(r.top * k),
          width: Math.round(r.width * k),
          height: Math.round(r.height * k),
        },
      }).catch(() => {});
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [joinedRoom, browsing, chatOpen, fullscreen, mini, shownTick]);

  // История: при входе в комнату — её список, при открытии видео — запись.
  useEffect(() => {
    setHistory(joinedRoom ? loadHistory(joinedRoom) : []);
  }, [joinedRoom]);
  useEffect(() => {
    const media = playback?.media ?? null;
    if (!joinedRoom || !media || player.loaded !== media || !info?.title) return;
    rememberTitle(media, info.title);
    setHistory((list) => {
      if (list[0]?.media === media && list[0].title === info.title) return list;
      const next = [
        { media, title: info.title ?? mediaTitle(media), at: Date.now() },
        ...list.filter((h) => h.media !== media),
      ].slice(0, HISTORY_SIZE);
      saveHistory(joinedRoom, next);
      return next;
    });
  }, [joinedRoom, playback?.media, player.loaded, info?.title]);

  // ----- Продолжить с места -----
  // Где остановились в длинных видео (у каждого своё; по ссылке).
  const [resumeOffer, setResumeOffer] = useState<{ media: string; at: number } | null>(null);
  const resumeAskedRef = useRef<string | null>(null);
  const resumeSavedRef = useRef(0);
  useEffect(() => {
    const media = playback?.media ?? null;
    const pos = info?.position ?? null;
    const dur = info?.duration ?? null;
    if (!media || !isUrl(media) || player.loaded !== media || pos === null || !dur) return;
    // Предложить продолжить — тому, у кого пульт, в самом начале видео.
    if (isHost && resumeAskedRef.current !== media && pos < 10) {
      resumeAskedRef.current = media;
      const at = loadResume(media);
      setResumeOffer(at !== null && at > 60 && at < dur - 60 ? { media, at } : null);
    }
    if (resumeOffer && resumeOffer.media !== media) setResumeOffer(null);
    if (resumeOffer && pos > resumeOffer.at - 5) setResumeOffer(null);
    // Запоминаем место раз в 5 секунд, только в длинных видео.
    if (dur < 600 || Math.abs(pos - resumeSavedRef.current) < 5) return;
    resumeSavedRef.current = pos;
    saveResume(media, info?.ended || pos > dur - 60 ? null : pos > 30 ? pos : null);
  }, [playback?.media, player.loaded, info?.position, info?.duration, info?.ended, isHost, resumeOffer]);

  // За ~25 секунд до конца заранее готовим следующее из очереди — у всех,
  // чтобы оно открылось сразу, без нескольких секунд чёрного экрана.
  const prefetchedRef = useRef<string | null>(null);
  useEffect(() => {
    const next = suggestions[0]?.media;
    const dur = info?.duration ?? 0;
    const pos = info?.position ?? 0;
    if (!next || !isUrl(next) || !playback?.media || player.loaded !== playback.media) return;
    if (dur < 30 || dur - pos > 25 || prefetchedRef.current === next) return;
    prefetchedRef.current = next;
    invoke("prefetch_media", { url: next }).catch(() => {});
  }, [suggestions, info?.duration, info?.position, playback?.media, player.loaded]);

  // Доиграло до конца — у того, у кого пульт, включается следующее из списка.
  // «Доиграло» считаем, только если это видео при нас уже шло (не было в
  // конце): сразу после переключения плеер ещё полсекунды сообщает «конец»
  // про прошлое видео — и раньше из-за этого пропускалось следующее в очереди.
  const playingRef = useRef<string | null>(null);
  useEffect(() => {
    const media = playback?.media ?? null;
    if (media && player.loaded === media && info && !info.ended && (info.position ?? 0) > 0.5) {
      playingRef.current = media;
    }
  }, [playback?.media, player.loaded, info]);
  useEffect(() => {
    const media = playback?.media ?? null;
    if (!isHost || !autoNext || !info?.ended || !media || player.loaded !== media) return;
    if (playingRef.current !== media) return;
    if (autoplayedRef.current === media || suggestions.length === 0 || spin !== null) return;
    autoplayedRef.current = media;
    const next = suggestions[0];
    invoke("ui_log", { message: `очередь: следующее — ${next.media}` }).catch(() => {});
    run(async () => {
      await invoke("open_url", { url: next.media });
      // Запустится само, когда откроется у всех (эффект автозапуска).
      if (!autoplayRef.current || autoplayRef.current.media !== next.media) {
        autoplayRef.current = { media: next.media, since: Date.now() };
      }
    });
  }, [info?.ended, isHost, autoNext, playback?.media, player.loaded, suggestions, spin]);

  // В полном экране и в мини-окне панель плеера — отдельное окно поверх низа
  // области видео. Ставим его всегда в этих режимах — и над фильмом, и над
  // трансляцией экрана. Номер сеанса запоминаем: команды от уже закрытого
  // режима (окно меняет размер при выходе) панель заново не откроют.
  useEffect(() => {
    if (IS_ANDROID || (!fullscreen && !mini)) return;
    const el = videoRef.current;
    if (!el) return;
    const session = overlaySession.current;
    const place = () => {
      const r = el.getBoundingClientRect();
      const k = window.devicePixelRatio || 1;
      // Полный экран — панель на всё видео (чтобы прятать курсор),
      // мини-окно — только полоса снизу.
      const h = mini ? Math.min(MINI_OVERLAY_HEIGHT, r.height) : r.height;
      invoke("overlay_place", {
        session,
        rect: {
          x: Math.round(r.left * k),
          y: Math.round((r.bottom - h) * k),
          width: Math.round(r.width * k),
          height: Math.round(h * k),
        },
      }).catch((err) => setError(String(err)));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [fullscreen, mini, chatOpen, shownTick]);

  // Вне полного экрана и мини-окна панели быть не должно — на всякий случай
  // закрываем ещё раз, если что-то её оставило.
  useEffect(() => {
    if (fullscreen || mini) return;
    invoke("overlay_close", { session: overlaySession.current }).catch(() => {});
  }, [fullscreen, mini]);

  // ----- Встроенный браузер: сайт лежит поверх области .video -----

  function videoArea() {
    const el = videoRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const k = window.devicePixelRatio || 1;
    return {
      x: Math.round(r.left * k),
      y: Math.round(r.top * k),
      width: Math.round(r.width * k),
      height: Math.round(r.height * k),
      // Сайты рассчитаны на широкое окно: в узкой области уменьшаем страницу,
      // чтобы она помещалась по ширине (как будто окно шириной ~1280).
      zoom: Math.round(Math.min(1, Math.max(0.6, r.width / 1280)) * 100) / 100,
    };
  }

  async function openSite(site: Site) {
    const rect = videoArea();
    if (!rect) return;
    setBrowseNote(null);
    setBrowserUrl(site.home);
    setBrowsing("site");
    try {
      await invoke("browser_open", { url: site.home, rect });
    } catch (err) {
      setError(String(err));
      setBrowsing("pick");
    }
  }

  function closeBrowser() {
    setBrowsing(null);
    setBrowseNote(null);
  }

  /** «Обзор» — туда же, где был в прошлый раз: спрятанная страница
   *  возвращается как есть, а после перезапуска открывается последний адрес. */
  async function reopenBrowser() {
    const rect = videoArea();
    if (!rect) return;
    setBrowseNote(null);
    try {
      if (await invoke<boolean>("browser_show", { rect })) {
        setBrowsing("site");
        return;
      }
    } catch {
      // Не вышло — откроем заново.
    }
    const last = load("browseUrl", "");
    if (last && siteOf(last)) {
      setBrowserUrl(last);
      setBrowsing("site");
      try {
        await invoke("browser_open", { url: last, rect });
        return;
      } catch {
        save("browseUrl", "");
      }
    }
    setBrowsing("pick");
  }

  // В полном экране, мини-окне и вне зала браузер не нужен.
  useEffect(() => {
    if (fullscreen || mini || joinedRoom === null) setBrowsing(null);
  }, [fullscreen, mini, joinedRoom]);

  // Из полного экрана вышли не нашей кнопкой (Win+↓, перетащили окно, Windows
  // сама) — приложение должно это заметить. Иначе оно продолжало считать
  // себя в полном экране: панель-окно оставалась поверх кнопок.
  useEffect(() => {
    // На телефоне полный экран — не окно, а поворот и скрытые панели.
    if (!fullscreen || IS_ANDROID) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let active = true;
    win
      .onResized(async () => {
        if (fullscreenRef.current && !(await win.isFullscreen())) {
          invoke("ui_log", { message: "полный экран: окно вышло само" }).catch(() => {});
          setFullscreen(false);
          setChatOpen(true);
        }
      })
      .then((u) => (active ? (unlisten = u) : u()));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [fullscreen]);

  // Мини-окно развернули на весь экран — значит, мини-режим больше не нужен.
  useEffect(() => {
    if (!mini) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let active = true;
    win
      .onResized(async () => {
        if (miniRef.current && (await win.isMaximized())) applyMini(false);
      })
      .then((u) => (active ? (unlisten = u) : u()));
    return () => {
      active = false;
      unlisten?.();
    };
  }, [mini]);

  useEffect(() => {
    if (browsing !== "site") return;
    const el = videoRef.current;
    const update = () => {
      const rect = videoArea();
      if (rect) invoke("browser_place", { rect }).catch(() => {});
    };
    const observer = new ResizeObserver(update);
    if (el) observer.observe(el);
    window.addEventListener("resize", update);
    // На телефоне страница прокручивается — сайт едет следом.
    window.addEventListener("scroll", update, true);
    const poll = setInterval(() => {
      invoke<string | null>("browser_url")
        .then((u) => {
          setBrowserUrl(u);
          // Запоминаем, где остановились, — вернёмся сюда же.
          if (u && siteOf(u)) save("browseUrl", u);
        })
        .catch(() => {});
    }, 600);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      clearInterval(poll);
      // Не закрываем, а прячем: в следующий раз вернёмся на ту же страницу.
      invoke("browser_hide").catch(() => {});
      setBrowserUrl(null);
    };
  }, [browsing]);

  // Вышли из зала — страницу закрываем совсем (адрес всё равно запомнен).
  useEffect(() => {
    if (joinedRoom === null) invoke("browser_close").catch(() => {});
  }, [joinedRoom]);

  const pageVideo = browsing === "site" ? videoLink(browserUrl) : null;
  // Название того, что включим (SoundCloud и Яндекс сообщают его со страницы).
  const pageVideoTitle = pageVideo ? (pageTitle(browserUrl) ?? knownTitle(pageVideo) ?? null) : null;
  useEffect(() => {
    if (pageVideo && pageVideoTitle) rememberTitle(pageVideo, pageVideoTitle);
  }, [pageVideo, pageVideoTitle]);

  async function watchFromBrowser() {
    if (!pageVideo) return;
    if (!isHost) {
      await suggestFromBrowser();
      return;
    }
    closeBrowser();
    await run(() => invoke("open_url", { url: pageVideo }));
  }

  async function suggestFromBrowser() {
    if (!pageVideo) return;
    await run(() => send({ type: "suggest", media: pageVideo }));
    setBrowseNote("Добавлено в «Что посмотреть»");
    setTimeout(() => setBrowseNote(null), 2500);
  }

  // ----- Связь с панелью поверх видео -----

  // Название — как его отдал сайт (YouTube, SoundCloud…), а пока не
  // открылось — из ссылки.
  const nowMedia = playback?.media ?? null;
  const nowTitle = nowMedia
    ? info?.title && player.loaded === nowMedia
      ? info.title
      : mediaTitle(nowMedia)
    : "Ничего не выбрано";

  const overlayState: OverlayState = {
    mini,
    canControl: isHost && player.running && player.loaded === (playback?.media ?? null),
    controlHint: isHost ? "Сначала открой видео" : `Пульт у ${hostNameOf(members, host) ?? "другого"}`,
    title: nowTitle,
    status: playbackStatus(playback, isHost, hostNameOf(members, host)),
    tracks,
    quality,
    qualityEnabled: playback?.media != null && isUrl(playback.media),
    canShareSubtitles: isHost && (playback?.media ?? null) !== null,
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
            <UpdateCard />
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
              <div className="server-fields">
              <label>
                Адрес сервера
                <input value={server} onChange={(e) => setServer(e.target.value)} required />
              </label>
              <label>
                Пароль сервера
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Если сервер с паролем"
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="link-button"
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? "Скрыть пароль" : "Показать пароль"}
              </button>
              <LogsButton />
              </div>
            </details>
            <LoginVersion />

            <details className="server-settings" open={showThemes}>
              <summary
                onClick={(e) => {
                  e.preventDefault();
                  setShowThemes((s) => !s);
                }}
              >
                <Icon name="chevron" size={14} />
                Темы
              </summary>
              <ThemePicker />
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
    browsing !== null && "browsing",
    adhd && "adhd",
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
              <UpdatePill />
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
                className={adhd ? "ghost adhd-toggle on" : "ghost adhd-toggle"}
                onClick={toggleAdhd}
                title={
                  adhd
                    ? "Выключить СДВГ-режим"
                    : "СДВГ-режим: сбоку без звука идёт Subway Surfers, мыло, ковры… (только у тебя)"
                }
              >
                <span aria-hidden="true">🧠</span>
                {adhd ? "СДВГ: вкл" : "СДВГ"}
              </button>
              {!IS_ANDROID && (
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
                {sharing ? "Остановить показ" : "Экран"}
              </button>
              )}
              <button
                className={invited ? "ghost done" : "ghost"}
                onClick={copyInvite}
                title="Скопировать приглашение для друга"
              >
                <Icon name="enter" size={17} />
                {invited ? "Скопировано" : "Позвать"}
              </button>
              <button
                className="ghost icon-only"
                onClick={() => setChatOpen((o) => !o)}
                title={chatOpen ? "Скрыть чат (Tab)" : "Показать чат (Tab)"}
                aria-label={chatOpen ? "Скрыть чат" : "Показать чат"}
              >
                <Icon name="panel" size={18} />
              </button>
              <button
                className="ghost icon-only"
                onClick={handleLeave}
                title="Выйти из зала"
                aria-label="Выйти из зала"
              >
                <Icon name="leave" size={18} />
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
            <button
              type="button"
              className={browsing ? "browse-open active" : "browse-open"}
              onClick={() => (browsing ? closeBrowser() : reopenBrowser())}
              title="Найти видео на YouTube, VK Видео, Rutube и «Ю»"
            >
              <Icon name="grid" size={18} />
              Обзор
            </button>
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
              {isHost && (!IS_ANDROID || url.trim() !== "") && (
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
              {(!IS_ANDROID || url.trim() !== "") && (
                <button type="submit" className="go" disabled={!url.trim()}>
                  {isHost ? "Смотреть" : "Предложить"}
                </button>
              )}
            </label>
          </form>
        )}
        {!fullscreen && !mini && playlistLoading && (
          <div className="notice" role="status">
            <span>Смотрю, что в плейлисте…</span>
          </div>
        )}
        {!fullscreen && !mini && playlistOffer && (
          <div className="notice playlist-offer">
            <span>
              В плейлисте {playlistOffer.entries.length} видео
              {playlistOffer.entries[0].title ? ` — начиная с «${playlistOffer.entries[0].title}»` : ""}.{" "}
              {playlistOffer.mode === "watch"
                ? "Включить первое, а остальные поставить в очередь?"
                : "Добавить все в «Что посмотреть»?"}
            </span>
            <button className="primary" onClick={() => acceptPlaylist(true)}>
              {playlistOffer.mode === "watch" ? "Да, по порядку" : `Добавить все (${playlistOffer.entries.length})`}
            </button>
            <button className="ghost" onClick={() => acceptPlaylist(false)}>
              Только одно
            </button>
            <button
              className="ghost icon-only"
              onClick={() => setPlaylistOffer(null)}
              aria-label="Отмена"
              title="Отмена"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {!fullscreen && !mini && resumeOffer && (
          <div className="notice">
            <span>Ты остановился на {formatTime(resumeOffer.at)}.</span>
            <button
              className="primary"
              onClick={() => {
                control({ type: "seek", position: resumeOffer.at }).catch((err) => setError(String(err)));
                setResumeOffer(null);
              }}
            >
              Продолжить
            </button>
            <button className="ghost" onClick={() => setResumeOffer(null)}>
              С начала
            </button>
          </div>
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

        {!fullscreen && !mini && browsing !== null && (
          <div className="browser-bar">
            {browsing === "site" ? (
              <>
                <button
                  className="ghost icon-only"
                  onClick={() => invoke("browser_back").catch(() => {})}
                  title="Назад"
                  aria-label="Назад"
                >
                  <Icon name="back" size={18} />
                </button>
                <div className="site-chips" role="tablist" aria-label="Площадки">
                  {SITES.map((site) => (
                    <button
                      key={site.id}
                      role="tab"
                      aria-selected={siteOf(browserUrl) === site.id}
                      className={siteOf(browserUrl) === site.id ? "site-chip active" : "site-chip"}
                      onClick={() => openSite(site)}
                    >
                      <span className="site-mark" style={{ background: site.color }}>
                        {site.mark}
                      </span>
                      {site.title}
                    </button>
                  ))}
                </div>
                <span className="browser-hint">
                  {browseNote ??
                    (pageVideo
                      ? pageVideoTitle
                        ? `Включим: «${pageVideoTitle}»`
                        : ""
                      : siteOf(browserUrl) === "yandex" && /\/video\/preview/.test(browserUrl ?? "")
                        ? "Не нашёл, с какого сайта это видео: у Яндекса оно может быть только в его плеере"
                        : "Открой видео — и его можно включить в зале")}
                </span>
                {isHost && (
                  <button className="ghost" disabled={!pageVideo} onClick={suggestFromBrowser}>
                    В список
                  </button>
                )}
                <button className="go" disabled={!pageVideo} onClick={watchFromBrowser}>
                  {isHost ? "Смотреть в зале" : "Предложить"}
                </button>
              </>
            ) : (
              <span className="browser-title">Где ищем, что посмотреть?</span>
            )}
            <button
              className="ghost icon-only"
              onClick={closeBrowser}
              title="Закрыть обзор"
              aria-label="Закрыть обзор"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        )}

        <div className="video" ref={videoRef}>
          {IS_ANDROID && <ReactionsLayer inline />}
          {browsing === "site" ? (
            <div className="video-placeholder">Открываю сайт…</div>
          ) : browsing === "pick" ? (
            <SitePicker onPick={openSite} isHost={isHost} />
          ) : screenShare && !sharing ? (
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
          ) : cover && media ? (
            <CoverView cover={cover} paused={info?.paused ?? true} />
          ) : IS_ANDROID && media && player.running && info?.duration != null ? null : (
          <div className="video-placeholder">
            {media
              ? player.running
                ? "Загружаю видео…"
                : `Сейчас смотрят «${mediaTitle(media)}»`
              : isHost
                ? "Нажми «Обзор» или вставь ссылку сверху — видео начнётся у всех одновременно"
                : `Ждём, пока ${hostName ?? "ведущий"} выберет, что смотрим. А пока можно предложить своё через «Обзор»`}
          </div>
          )}
        </div>

        {!mini && (
        <PlayerControls
          onHover={(over) => (overControlsRef.current = over)}
          info={info}
          canControl={isHost && player.running && player.loaded === media}
          controlHint={isHost ? "Сначала открой видео" : `Пульт у ${hostName ?? "другого"}`}
          title={nowTitle}
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
          onMini={
            IS_ANDROID
              ? () => invoke("mobile_pip").catch(() => {})
              : () => applyMini(true)
          }
          onReact={(emoji) => run(() => send({ type: "react", emoji }))}
          canShareSubtitles={isHost && media !== null}
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
                // По любому — меню: у себя статус и аватарка, у других громкость,
                // а у кого пульт — ещё и управление.
                const manageable = true;
                return (
                  <li
                    key={m.id}
                    className={[manageable && "clickable", memberMenu?.id === m.id && "open"]
                      .filter(Boolean)
                      .join(" ")}
                    role={manageable ? "button" : undefined}
                    tabIndex={manageable ? 0 : undefined}
                    title={
                      m.id === me
                        ? "Статус и аватарка"
                        : isHost
                          ? "Громкость, передать пульт или выгнать"
                          : "Громкость этого человека — только у тебя"
                    }
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
                    <SeatBadge member={m} speaking={speaking} offline={!m.online} />
                    <span className="seat-name">
                      <span>
                        {m.name}
                        {m.id === me && <span className="muted"> (ты)</span>}
                      </span>
                      {!m.online ? (
                        <span className="seat-role">переподключается…</span>
                      ) : (
                        (m.id === host || m.status) && (
                          <span className="seat-role">
                            {[m.id === host && "держит пульт", m.status].filter(Boolean).join(" · ")}
                          </span>
                        )
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
              (() => {
                const m = members.find((x) => x.id === memberMenu.id);
                if (m && m.id === me) {
                  return (
                    <ProfileMenu
                      key={m.id}
                      member={m}
                      anchor={memberMenu}
                      status={myStatus}
                      avatar={myAvatar}
                      onChange={changeProfile}
                    />
                  );
                }
                return (
                  m && (
                    <MemberMenu
                      key={m.id}
                      member={m}
                      anchor={memberMenu}
                      isHost={isHost}
                      volume={volumes[m.name] ?? 1}
                      onVolume={(v) => changeVolume(m.name, v)}
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
              <h2>Настройки</h2>
              <div className="setting">
                <span className="setting-label">Тема</span>
                <ThemePicker />
              </div>
              <AppVersion />
              <label className="setting-check">
                <input
                  type="checkbox"
                  checked={sounds}
                  onChange={(e) => {
                    setSounds(e.target.checked);
                    setSoundsEnabled(e.target.checked);
                    if (e.target.checked) sound.join();
                  }}
                />
                Звуки: микрофон, вход и выход людей, упоминания
              </label>
              {!IS_ANDROID && (
              <label className="setting-check">
                <input
                  type="checkbox"
                  checked={closeToTray}
                  onChange={(e) => {
                    setCloseToTray(e.target.checked);
                    save("closeToTray", e.target.checked ? "1" : "0");
                  }}
                />
                Крестик сворачивает в трей (значок у часов), а не закрывает
              </label>
              )}
              <h3 className="settings-sub">Голос</h3>
              {!IS_ANDROID && (
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
              )}

              {voiceMode === "open" && !IS_ANDROID && (
                <div className="setting">
                  <span className="setting-label">
                    Клавиша вкл/выкл микрофона — работает и в других окнах
                  </span>
                  <button className="quiet" onClick={() => setCapturingMute((c) => !c)}>
                    {capturingMute
                      ? "Нажми клавишу или кнопку мыши…"
                      : muteKey !== null
                        ? `${keyName(muteKey)}, изменить`
                        : "Назначить клавишу"}
                  </button>
                  {muteKey !== null && !capturingMute && (
                    <button
                      className="link-button"
                      onClick={() => {
                        setMuteKey(null);
                        save("muteKey", "");
                      }}
                    >
                      Убрать клавишу
                    </button>
                  )}
                </div>
              )}

              {voiceMode === "ptt" && !IS_ANDROID && (
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
                <span className="setting-label">Шумоподавление</span>
                <select
                  value={noise}
                  onChange={(e) => {
                    const mode = e.target.value === "standard" ? "standard" : "strong";
                    setNoise(mode);
                    save("noise", mode);
                  }}
                >
                  <option value="strong">Сильное — глушит клавиатуру и фон</option>
                  <option value="standard">Обычное</option>
                </select>
              </label>

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
              <button
                role="tab"
                aria-selected={sideTab === "history"}
                className={sideTab === "history" ? "active" : ""}
                onClick={() => setSideTab("history")}
              >
                История
              </button>
            </div>
            {sideTab === "history" ? (
              <HistoryPanel
                list={history}
                isHost={isHost}
                current={playback?.media ?? null}
                onPlay={(h) => run(() => invoke("open_url", { url: h.media }))}
                onSuggest={(h) =>
                  run(async () => {
                    await send({ type: "suggest", media: h.media });
                    setSideTab("suggest");
                  })
                }
                onClear={() => {
                  if (!joinedRoom) return;
                  saveHistory(joinedRoom, []);
                  setHistory([]);
                }}
              />
            ) : sideTab === "suggest" ? (
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
                    send({ type: "spin" }),
                  )
                }
                pending={roulettePending}
                canCancel={
                  roulettePending !== null &&
                  (isHost || roulettePending.by === members.find((m) => m.id === me)?.name)
                }
                onCancel={() => run(() => send({ type: "cancel_roulette" }))}
                autoNext={autoNext}
                onAutoNext={(on) => {
                  setAutoNext(on);
                  save("autoNext", on ? "1" : "0");
                }}
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
                      panelKey={panelKey}
                      onKey={(k) => {
                        setPanelKey(k);
                        save("panelKey", k);
                      }}
                      onClose={() => setAdminOpen(false)}
                      onSpinNow={() =>
                        send({
                          type: "spin",
                          now: true,
                          weights: spinWeights(suggestions, weights),
                          key: panelKey || null,
                        }).catch(() => {})
                      }
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
                    <span>{l.media ? l.text.replace("{title}", mediaTitle(l.media)) : l.text}</span>
                  </div>
                ) : (
                  <div
                    key={l.key}
                    data-key={l.key}
                    className={["message", l.mine && "mine", l.mention && "mention"]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <span className="author" style={{ color: NAME_COLORS[colorIndex(l.name)] }}>
                      {l.name}
                    </span>
                    {l.reply && (
                      <span className="reply-quote">
                        <strong>{l.reply.name}</strong>
                        <span>{l.reply.text}</span>
                      </span>
                    )}
                    {(() => {
                      const sticker = stickerFromMessage(l.text);
                      return sticker ? (
                        <StickerArt sticker={sticker} size={112} />
                      ) : (
                        <RichText text={l.text} />
                      );
                    })()}
                    <button
                      type="button"
                      className="reply-button"
                      onClick={() => startReply(l)}
                      title="Ответить"
                      aria-label="Ответить"
                    >
                      <Icon name="reply" size={14} />
                    </button>
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
              {typing.size > 0 && (
                <div className="typing-line" aria-live="polite">
                  <span className="typing-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {(() => {
                    const names = [...typing.keys()]
                      .map((id) => members.find((m) => m.id === id)?.name)
                      .filter(Boolean) as string[];
                    if (names.length === 1) return `${names[0]} печатает…`;
                    if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
                    return "Несколько человек печатают…";
                  })()}
                </div>
              )}
              {replyTo && (
                <div className="reply-bar">
                  <Icon name="reply" size={14} />
                  <span className="reply-bar-text">
                    Ответ <strong>{replyTo.name}</strong>: {replyTo.text}
                  </span>
                  <button
                    type="button"
                    className="icon"
                    onClick={() => setReplyTo(null)}
                    aria-label="Не отвечать"
                    title="Не отвечать (Esc)"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              )}
              {mentionOptions.length > 0 && (
                <div className="mention-list" role="listbox" aria-label="Кого упомянуть">
                  {mentionOptions.map((m, i) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={i === 0}
                      className={i === 0 ? "active" : ""}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(m.name);
                      }}
                    >
                      <SeatBadge member={m} small />
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="composer-row">
                <input
                  ref={draftRef}
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === "Tab" || e.key === "Enter") && mentionOptions.length > 0) {
                      e.preventDefault();
                      insertMention(mentionOptions[0].name);
                    } else if (e.key === "Escape" && replyTo) {
                      e.stopPropagation();
                      setReplyTo(null);
                    }
                  }}
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
                <button
                  type="submit"
                  className="send"
                  disabled={!draft.trim() || reconnecting}
                  aria-label="Отправить"
                  title="Отправить: Enter"
                >
                  <Icon name="send" size={16} />
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
                title={
                  (micOn ? "Выключить микрофон" : "Включить микрофон") +
                  (muteKey !== null && voiceMode === "open" ? ` (${keyName(muteKey)})` : "")
                }
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
  panelKey,
  onKey,
  onSpinNow,
}: {
  list: Suggestion[];
  weights: Map<number, number>;
  onChange: (id: number, percent: number | null) => void;
  onReset: () => void;
  onClose: () => void;
  panelKey: string;
  onKey: (key: string) => void;
  onSpinNow: () => void;
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
      <input
        type="password"
        className="admin-key"
        placeholder="Слово"
        value={panelKey}
        onChange={(e) => onKey(e.target.value.trim())}
        autoComplete="off"
        aria-label="Слово"
      />
      <div className="admin-foot">
        <span className="suggestion-by">
          Колесо и тот, кто крутит, об этом не узнают.
        </span>
        <button className="quiet" onClick={onReset}>
          Честно
        </button>
        <button className="quiet" onClick={onSpinNow} disabled={list.length === 0}>
          Крутить сейчас
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
// ---------- Где остановились ----------

const RESUME_KEY = "resume";

function loadResumeMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function loadResume(media: string): number | null {
  const at = loadResumeMap()[media];
  return typeof at === "number" ? at : null;
}

/** `null` — досмотрели, место больше не нужно. Храним последние 50 видео. */
function saveResume(media: string, at: number | null) {
  try {
    const map = loadResumeMap();
    delete map[media];
    if (at !== null) map[media] = Math.round(at);
    const entries = Object.entries(map).slice(-50);
    localStorage.setItem(RESUME_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Не сохранилось — не страшно.
  }
}

// ---------- История просмотров ----------

interface HistoryEntry {
  media: string;
  title: string;
  at: number;
}

const HISTORY_SIZE = 50;

function loadHistory(room: string): HistoryEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(`history:${room}`) ?? "[]");
    return Array.isArray(list) ? list.filter((h) => h && typeof h.media === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(room: string, list: HistoryEntry[]) {
  try {
    localStorage.setItem(`history:${room}`, JSON.stringify(list));
  } catch {
    // Нет места или хранилище недоступно — история просто не сохранится.
  }
}

/** «Вчера в 21:40», «Сегодня в 18:05», «3 нояб.». */
function whenWatched(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (diff === 0) return `Сегодня в ${time}`;
  if (diff === 1) return `Вчера в ${time}`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function HistoryPanel({
  list,
  isHost,
  current,
  onPlay,
  onSuggest,
  onClear,
}: {
  list: HistoryEntry[];
  isHost: boolean;
  current: string | null;
  onPlay: (h: HistoryEntry) => void;
  onSuggest: (h: HistoryEntry) => void;
  onClear: () => void;
}) {
  if (list.length === 0) {
    return (
      <div className="suggestions">
        <p className="suggestions-empty">
          Здесь появится всё, что смотрели в этой комнате, — чтобы быстро вернуться.
        </p>
      </div>
    );
  }
  return (
    <div className="suggestions">
      <ul>
        {list.map((h) => (
          <li key={h.media} className={h.media === current ? "lit" : ""}>
            <span className="suggestion-text">
              <span className="suggestion-title" title={h.media}>
                {h.title}
              </span>
              <span className="suggestion-by">
                {h.media === current ? "Смотрим сейчас" : whenWatched(h.at)}
              </span>
            </span>
            {h.media !== current &&
              (isHost ? (
                <button className="icon" onClick={() => onPlay(h)} title="Включить снова" aria-label="Включить">
                  <Icon name="play" />
                </button>
              ) : (
                <button className="icon" onClick={() => onSuggest(h)} title="Предложить снова" aria-label="Предложить">
                  <Icon name="film" />
                </button>
              ))}
          </li>
        ))}
      </ul>
      <button className="link-button history-clear" onClick={onClear}>
        Очистить историю
      </button>
    </div>
  );
}

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
  autoNext,
  onAutoNext,
  pending,
  canCancel,
  onCancel,
}: {
  pending: { at: number; by: string } | null;
  canCancel: boolean;
  onCancel: () => void;
  autoNext: boolean;
  onAutoNext: (on: boolean) => void;
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
      {isHost && (
        <label className="auto-next" title="Когда видео доиграет, включится первое из списка">
          <input type="checkbox" checked={autoNext} onChange={(e) => onAutoNext(e.target.checked)} />
          Доиграло — включать следующее из списка
        </label>
      )}
      {list.length > 0 && wheel}
      {list.length === 0 ? (
        <p className="suggestions-empty">
          Пока пусто. Вставь ссылку в поле сверху и нажми «{isHost ? "В список" : "Предложить"}» —
          а тот, у кого пульт, включит. Рулетку может запустить любой.
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
      {pending && !spinning ? (
        <RouletteTimer pending={pending} canCancel={canCancel} onCancel={onCancel} />
      ) : (
        list.length > 0 && (
          <button
            className="primary roulette"
            onClick={onSpin}
            disabled={spinning}
            title="Закрутится через минуту — все успеют добавить своё"
          >
            <Icon name="dice" size={18} />
            {spinning ? "Крутится…" : "Запустить рулетку"}
          </button>
        )
      )}
    </div>
  );
}

/** Отсчёт до кручения рулетки. */
function RouletteTimer({
  pending,
  canCancel,
  onCancel,
}: {
  pending: { at: number; by: string };
  canCancel: boolean;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((pending.at - now) / 1000));
  const progress = Math.min(1, Math.max(0, 1 - (pending.at - now) / 60_000));
  return (
    <div className="roulette-timer">
      <div className="roulette-timer-row">
        <Icon name="dice" size={18} />
        <span>
          Рулетка через <strong>{formatTime(left)}</strong>
          <span className="roulette-timer-by"> · запустил(а) {pending.by}</span>
        </span>
        {canCancel && (
          <button className="link-button" onClick={onCancel}>
            Отменить
          </button>
        )}
      </div>
      <div className="roulette-timer-bar">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

/** Где открыть меню участника: строка, по которой кликнули. */
type MenuAnchor = { id: MemberId; top: number; bottom: number; left: number; width: number };

/**
 * Меню участника для ведущего: передать управление или выгнать из зала.
 * Действие подтверждается тут же, вторым нажатием, без системных окон.
 */
/** Похоже на плейлист или сезон: YouTube `list=`, VK и Rutube — плейлисты. */
function looksLikePlaylist(link: string): boolean {
  try {
    const u = new URL(link);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    const list = u.searchParams.get("list");
    // Миксы YouTube (RD…) бесконечные — это не сезон.
    if ((host === "youtube.com" || host === "youtu.be") && list && !list.startsWith("RD")) return true;
    if (host.endsWith("vkvideo.ru") || host.endsWith("vk.com")) {
      return /\/playlist\//.test(u.pathname) || /playlist/.test(u.searchParams.get("section") ?? "");
    }
    if (host.endsWith("rutube.ru")) return /^\/plst\//.test(u.pathname);
    return false;
  } catch {
    return false;
  }
}

/** Кружок участника: аватарка-эмодзи, свой цвет или буква на цветном круге. */
function SeatBadge({
  member,
  small = false,
  speaking = false,
  offline = false,
}: {
  member: { name: string; avatar?: string | null };
  small?: boolean;
  speaking?: boolean;
  offline?: boolean;
}) {
  const avatar = member.avatar ?? "";
  const emoji = avatar.startsWith("emoji:") ? avatar.slice(6) : null;
  const color = avatar.startsWith("color:") ? Number(avatar.slice(6)) : NaN;
  const background = emoji
    ? "var(--raised-2)"
    : SEAT_COLORS[(Number.isFinite(color) ? color : colorIndex(member.name)) % SEAT_COLORS.length];
  return (
    <span
      className={["seat", small && "small", speaking && "speaking", offline && "offline", emoji && "emoji"]
        .filter(Boolean)
        .join(" ")}
      style={{ background }}
      title={speaking ? "Говорит" : undefined}
    >
      {emoji ? <EmojiGlyph emoji={emoji} /> : initial(member.name)}
    </span>
  );
}

/** Готовые статусы — одним кликом. */
const STATUSES = ["🚶 Отошёл", "👀 Смотрю краем глаза", "🍕 Ем", "📱 В телефоне", "😴 Засыпаю"];
/** Аватарки-эмодзи — из объёмных смайликов. */
const AVATAR_EMOJI = ["🍿", "😎", "🤡", "👻", "💀", "🗿", "🥶", "🤪", "😴", "🫡", "🤯", "🥳", "🔥", "👀", "💩", "🎬"];

/** Своё меню: статус и аватарка (видят все в зале). */
function ProfileMenu({
  member,
  anchor,
  status,
  avatar,
  onChange,
}: {
  member: Member;
  anchor: MenuAnchor;
  status: string | null;
  avatar: string | null;
  onChange: (status: string | null, avatar: string | null) => void;
}) {
  const [custom, setCustom] = useState(
    status && !STATUSES.includes(status) ? status : "",
  );
  const below = window.innerHeight - anchor.bottom > 380;
  const style: CSSProperties = {
    left: anchor.left,
    width: Math.max(anchor.width, 280),
    ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }),
  };
  return (
    <div className="member-menu profile-menu" role="menu" style={style}>
      <div className="member-menu-head">
        <SeatBadge member={{ name: member.name, avatar }} small />
        <span className="member-menu-name">{member.name}</span>
      </div>
      <span className="profile-label">Статус</span>
      <div className="status-chips">
        <button className={status === null ? "status-chip active" : "status-chip"} onClick={() => onChange(null, avatar)}>
          Без статуса
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            className={status === s ? "status-chip active" : "status-chip"}
            onClick={() => onChange(s, avatar)}
          >
            {s}
          </button>
        ))}
      </div>
      <form
        className="status-custom"
        onSubmit={(e) => {
          e.preventDefault();
          onChange(custom.trim() || null, avatar);
        }}
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          maxLength={40}
          placeholder="Свой статус"
          aria-label="Свой статус"
        />
        <button type="submit" className="ghost" disabled={!custom.trim()}>
          Ок
        </button>
      </form>
      <span className="profile-label">Аватарка</span>
      <div className="avatar-grid">
        <button
          className={avatar === null ? "avatar-choice active" : "avatar-choice"}
          onClick={() => onChange(status, null)}
          title="Буква"
        >
          <SeatBadge member={{ name: member.name }} small />
        </button>
        {SEAT_COLORS.map((_, i) => (
          <button
            key={`c${i}`}
            className={avatar === `color:${i}` ? "avatar-choice active" : "avatar-choice"}
            onClick={() => onChange(status, `color:${i}`)}
            title="Цвет"
          >
            <SeatBadge member={{ name: member.name, avatar: `color:${i}` }} small />
          </button>
        ))}
        {AVATAR_EMOJI.map((e) => (
          <button
            key={e}
            className={avatar === `emoji:${e}` ? "avatar-choice active" : "avatar-choice"}
            onClick={() => onChange(status, `emoji:${e}`)}
            title={e}
          >
            <SeatBadge member={{ name: member.name, avatar: `emoji:${e}` }} small />
          </button>
        ))}
      </div>
    </div>
  );
}

function MemberMenu({
  member,
  anchor,
  isHost,
  volume,
  onVolume,
  onClose,
  onTransfer,
  onKick,
}: {
  member: Member;
  anchor: MenuAnchor;
  isHost: boolean;
  /** Громкость этого человека у меня, 0…1. */
  volume: number;
  onVolume: (value: number) => void;
  onClose: () => void;
  onTransfer: () => void;
  onKick: () => void;
}) {
  const [confirm, setConfirm] = useState<"transfer" | "kick" | null>(null);
  // Громкость до «Выключить звук» — чтобы вернуть как было.
  const [beforeMute, setBeforeMute] = useState(volume > 0 ? volume : 1);
  // Под строкой, а если внизу не хватает места — над ней.
  const below = window.innerHeight - anchor.bottom > (isHost ? 260 : 150);
  const style: CSSProperties = {
    left: anchor.left,
    width: Math.max(anchor.width, 240),
    ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }),
  };

  return (
    <div className="member-menu" role="menu" style={style}>
      <div className="member-menu-head">
        <SeatBadge member={member} small />
        <span className="member-menu-name">{member.name}</span>
      </div>

      {confirm === null ? (
        <>
          <div className="member-volume" title="Громкость у каждого своя — другие её не слышат">
            <button
              className="icon"
              onClick={() => {
                if (volume > 0) {
                  setBeforeMute(volume);
                  onVolume(0);
                } else onVolume(beforeMute);
              }}
              title={volume > 0 ? "Выключить его звук у себя" : "Вернуть звук"}
              aria-label={volume > 0 ? "Выключить звук" : "Вернуть звук"}
            >
              <Icon name={volume > 0 ? "volume" : "mute"} size={18} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              autoFocus
              style={{ "--progress": `${volume * 100}%` } as CSSProperties}
              onChange={(e) => onVolume(Number(e.target.value))}
              aria-label={`Громкость ${member.name}`}
            />
            <span className="pct">{Math.round(volume * 100)}%</span>
          </div>
          {isHost && (
            <>
              <button role="menuitem" onClick={() => setConfirm("transfer")}>
                <Icon name="crown" />
                Передать пульт
              </button>
              <button role="menuitem" className="danger" onClick={() => setConfirm("kick")}>
                <Icon name="leave" />
                Выгнать из зала
              </button>
            </>
          )}
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

  // Панель спряталась — прячем и курсор (в полном экране окно панели
  // накрывает всё видео).
  useEffect(() => {
    document.documentElement.classList.toggle("cursor-hidden", !visible && !state?.mini);
  }, [visible, state?.mini]);

  if (!state) return null;

  return (
    <div
      className={["overlay-panel", state.mini && "mini", !visible && "hidden"]
        .filter(Boolean)
        .join(" ")}
      onDoubleClick={(e) => {
        // Двойной щелчок по картинке (не по кнопкам) — выйти из полного экрана.
        if (!state.mini && !(e.target as HTMLElement).closest(".controls")) {
          emit("overlay-key", "exit-fullscreen").catch(() => {});
        }
      }}
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
        onReact={(emoji) => send({ type: "react", emoji }).catch(() => {})}
        canShareSubtitles={state.canShareSubtitles}
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
  onReact,
  canShareSubtitles = false,
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
  /** Отправить реакцию (нет в мини-окне — там тесно). */
  onReact?: (emoji: string) => void;
  /** Можно раздать субтитры всем (у того, кто держит пульт). */
  canShareSubtitles?: boolean;
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
    save("playerVolume", String(value));
    clearTimeout(volumeTimer.current);
    // Отдаём управление обратно плееру, когда mpv точно применил громкость.
    volumeTimer.current = setTimeout(() => setVolumeDrag(null), 800);
  };

  const [tracksOpen, setTracksOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  /** Ссылка на субтитры для всех (`null` — поле не открыто). */
  const [subsLink, setSubsLink] = useState<string | null>(null);
  const shareSubs = (args: { path?: string; url?: string }) =>
    invoke<string>("subtitles_share", args).catch((err) => onError(String(err)));
  const audioTracks = tracks.filter((t) => t.kind === "audio");
  const subTracks = tracks.filter((t) => t.kind === "sub");
  const audioValue = String(audioTracks.find((t) => t.selected)?.id ?? "off");
  const subValue = String(subTracks.find((t) => t.selected)?.id ?? "off");

  const onAudio = (value: string) =>
    send({ type: "set_audio", id: value === "off" ? null : Number(value) });

  const onSubtitle = async (value: string) => {
    if (value === "share-file") {
      const path = await pickSubtitleFile();
      if (path) await shareSubs({ path });
      return;
    }
    if (value === "share-link") {
      setSubsLink("");
      return;
    }
    if (value === "share-off") {
      invoke("subtitles_clear").catch((err) => onError(String(err)));
      return;
    }
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
        {reactOpen && !tracksOpen && onReact && <ReactionPicker onPick={onReact} />}
        {!tracksOpen && !reactOpen && (
          <div className="now">
            <span className="now-title">{title}</span>
            <span className="now-status">{status}</span>
          </div>
        )}

        {onReact && !mini && !tracksOpen && (
          <button
            className={reactOpen ? "tracks-toggle icon-toggle active" : "tracks-toggle icon-toggle"}
            onClick={() => setReactOpen((o) => !o)}
            title={reactOpen ? "Спрятать реакции" : "Реакции — пролетят поверх видео у всех"}
            aria-label="Реакции"
          >
            <Icon name={reactOpen ? "close" : "smile"} size={16} />
          </button>
        )}

        {/* «Звук и субтитры»: дорожки и качество — вместо названия, по кнопке. */}
        <button
          className={tracksOpen ? "tracks-toggle active" : "tracks-toggle"}
          onClick={() => {
            setTracksOpen((o) => !o);
            setReactOpen(false);
            setSubsLink(null);
          }}
          title="Озвучка, субтитры и качество — у каждого свои"
        >
          <Icon name={tracksOpen ? "close" : "sliders"} size={16} />
          {tracksOpen ? "Готово" : "Звук и субтитры"}
        </button>

        {tracksOpen && subsLink !== null && (
          <form
            className="tracks subs-link"
            onSubmit={async (e) => {
              e.preventDefault();
              const url = subsLink.trim();
              if (!url) return;
              await shareSubs({ url });
              setSubsLink(null);
            }}
          >
            <input
              autoFocus
              value={subsLink}
              onChange={(e) => setSubsLink(e.target.value)}
              placeholder="Прямая ссылка на .srt, .vtt или .ass"
              aria-label="Ссылка на субтитры"
            />
            <button type="submit" className="go" disabled={!subsLink.trim()}>
              Для всех
            </button>
            <button type="button" className="ghost" onClick={() => setSubsLink(null)}>
              Отмена
            </button>
          </form>
        )}
        {tracksOpen && subsLink === null && (
        <div className="tracks">
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
            <option value="file">Себе: из файла…</option>
            {canShareSubtitles && (
              <>
                <option value="share-file">Для всех: из файла…</option>
                <option value="share-link">Для всех: по ссылке…</option>
                <option value="share-off">Убрать у всех</option>
              </>
            )}
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

        </div>
        )}

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
  | "grid"
  | "back"
  | "reply"
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
  reply: (
    <>
      <polyline points="9 7 4 12 9 17" />
      <path d="M4 12h10a6 6 0 0 1 6 6v1" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <rect x="13" y="13" width="7" height="7" rx="2" />
    </>
  ),
  back: (
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="11 6 5 12 11 18" />
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
