import { invoke } from "@tauri-apps/api/core";
// Голосовая связь через LiveKit.
//
// Звук идёт напрямую через сервер LiveKit; пропуск (token) выдаёт наш
// сервер при входе в комнату. Участник голосового канала опознаётся по
// id участника комнаты (строкой).

import {
  createAudioAnalyser,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteVideoTrack,
} from "livekit-client";
import { PROCESSOR_NAME, RnnoiseProcessor, type NoiseMode } from "./noise";
import { isTv } from "./tv";
import { prepareRemoteMic, remoteMicActive, remoteMicTrack } from "./remoteMic";

/** Чужая трансляция экрана. */
export type ScreenShare = { identity: string; track: RemoteVideoTrack };

// Кто говорит, определяем сами по громкости звука, а не по сообщениям
// сервера LiveKit: сервер сглаживает их и присылает с заметной задержкой.
/** Как часто проверять громкость, мс. */
const SPEAK_POLL_MS = 40;
/** Громкость (0..1), с которой считаем, что человек говорит. */
const SPEAK_ON = 0.04;
/** Сколько ждать после тишины, прежде чем погасить кольцо, мс (паузы между словами). */
const SPEAK_HOLD_MS = 350;

type Meter = { volume: () => number; cleanup: () => Promise<void>; loudAt: number };

export type VoiceStatus = "off" | "connecting" | "connected" | "error";

export interface VoiceCallbacks {
  onStatus(status: VoiceStatus, error?: string): void;
  /** Кто сейчас говорит (id участников строками). */
  onSpeakers(identities: Set<string>): void;
  /** Ошибка, не обрывающая соединение (например, нет доступа к микрофону). */
  onError(message: string): void;
  /** Чья трансляция экрана сейчас показывается (последняя начатая), или `null`. */
  onScreenShare(share: ScreenShare | null): void;
  /** Показываю ли я свой экран. */
  onLocalScreenShare(active: boolean): void;
}

export class VoiceClient {
  private room: Room | null = null;
  private volumes = new Map<string, number>();
  private deafened = false;
  private micOn = false;
  /** Измерители громкости по участникам (id строкой). */
  private meters = new Map<string, Meter>();
  /** Кто говорит по данным сервера — для тех, кого не удалось измерить самим. */
  private serverSpeakers = new Set<string>();
  private speaking = new Set<string>();
  private poll: number | null = null;
  /** Чужие трансляции по порядку начала (последняя — та, что на экране). */
  private shares: ScreenShare[] = [];
  /** Мои дорожки трансляции, пока показываю экран. */
  private myShare: MediaStreamTrack[] = [];

  /** Шумоподавление: обычное (браузера) или сильное (RNNoise). */
  private noise: NoiseMode = "strong";
  /** Аудиоконтекст для RNNoise: 48 кГц — частота, на которой она обучена. */
  private noiseCtx: AudioContext | null = null;

  /** ТВ: опубликованная дорожка микрофона пульта (remoteMic.ts). */
  private remotePub: LocalTrackPublication | null = null;

  constructor(private cb: VoiceCallbacks) {}

  /** Сменить шумоподавление (сразу, если микрофон уже включён). */
  async setNoise(mode: NoiseMode) {
    this.noise = mode;
    await this.applyNoise();
  }

  private async applyNoise() {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    // ТВ: звук пульта уже очищен самим пультом (как у голосового поиска).
    if (!track || isTv()) return;
    const active = track.getProcessor()?.name === PROCESSOR_NAME;
    try {
      if (this.noise === "strong" && !active) {
        this.noiseCtx ??= new AudioContext({ sampleRate: 48000 });
        await track.setAudioContext(this.noiseCtx);
        await track.setProcessor(new RnnoiseProcessor());
        await this.wakeNoise();
      } else if (this.noise !== "strong" && active) {
        await track.stopProcessor();
      }
    } catch (err) {
      // Не завелось — говорим с обычным шумоподавлением, но сообщаем.
      this.cb.onError(`Сильное шумоподавление не включилось: ${err}`);
    }
  }

  /**
   * Android WebView создаёт AudioContext «спящим», если не было нажатия, — и
   * через RNNoise тогда уходит тишина (микрофон пишет, друзья не слышат).
   * Будим сразу и при каждом нажатии, пока не проснётся.
   */
  private async wakeNoise() {
    const ctx = this.noiseCtx;
    if (!ctx) return;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {
        // без нажатия может не разрешить — разбудим по первому нажатию
      }
    }
    invoke("ui_log", { message: `голос: шумоподавление, звук ${ctx.state}` }).catch(() => {});
    if (ctx.state !== "running" && !this.wakeArmed) {
      this.wakeArmed = true;
      const wake = () => {
        ctx.resume().then(() => {
          if (ctx.state !== "running") return;
          this.wakeArmed = false;
          window.removeEventListener("keydown", wake, true);
          window.removeEventListener("pointerdown", wake, true);
          invoke("ui_log", { message: "голос: звук шумоподавления проснулся" }).catch(() => {});
        }).catch(() => {});
      };
      window.addEventListener("keydown", wake, true);
      window.addEventListener("pointerdown", wake, true);
    }
  }

  private wakeArmed = false;

  get connected(): boolean {
    return this.room !== null;
  }

  async connect(url: string, token: string, micDeviceId?: string) {
    await this.disconnect();

    const room = new Room({
      // ТВ: голоса друзей — через Web Audio. Иначе WebView играет их как
      // звонок, а звонок ТВ отдаёт только своим динамикам: с Bluetooth-
      // наушниками голосов не слышно.
      webAudioMix: isTv(),
      audioCaptureDefaults: {
        deviceId: micDeviceId || undefined,
        // ТВ: без обработки «для звонков» — с ней WebView переводит весь звук
        // приложения в звонок (см. выше).
        echoCancellation: !isTv(),
        noiseSuppression: !isTv(),
        autoGainControl: !isTv(),
      },
    });
    this.room = room;
    this.micOn = false;
    this.remotePub = null;
    // ТВ: микрофон — пульт; звук для него готовим заранее.
    if (isTv()) prepareRemoteMic().catch(() => {});

    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _publication: unknown, participant: RemoteParticipant) => {
        if (track.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
          this.shares = [
            ...this.shares.filter((s) => s.identity !== participant.identity),
            { identity: participant.identity, track: track as RemoteVideoTrack },
          ];
          this.emitShare();
          return;
        }
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        this.applyVolume(participant);
        if (track.source === Track.Source.Microphone) {
          this.addMeter(participant.identity, track as RemoteAudioTrack);
        }
      },
    );
    room.on(
      RoomEvent.TrackUnsubscribed,
      (track: RemoteTrack, _publication: unknown, participant: RemoteParticipant) => {
        if (track.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
          this.shares = this.shares.filter((s) => s.track !== track);
          this.emitShare();
          return;
        }
        track.detach().forEach((el) => el.remove());
        // Звук трансляции — не голос: кольцо «говорит» от него не зависит.
        if (track.kind === Track.Kind.Audio && track.source === Track.Source.Microphone) {
          this.removeMeter(participant.identity);
        }
      },
    );
    // Свой микрофон: кольцо загорается сразу, как начинаешь говорить.
    room.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.Microphone && pub.track) {
        this.addMeter(room.localParticipant.identity, pub.track as LocalAudioTrack);
        this.applyNoise();
      }
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.Microphone) {
        this.removeMeter(room.localParticipant.identity);
      }
    });
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => this.applyVolume(p));
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.serverSpeakers = new Set(speakers.map((p) => p.identity));
      this.updateSpeakers();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.room = null;
      this.remotePub = null;
      this.stopMeters();
      this.dropShares();
      this.cb.onStatus("off");
    });

    if (this.poll === null) {
      this.poll = window.setInterval(() => this.updateSpeakers(), SPEAK_POLL_MS);
    }

    this.cb.onStatus("connecting");
    try {
      await room.connect(url, token);
      await room.startAudio();
      if (this.room === room) this.cb.onStatus("connected");
    } catch (err) {
      if (this.room === room) this.room = null;
      this.cb.onStatus("error", `Не удалось подключиться к голосу: ${err}`);
    }
  }

  async disconnect() {
    const room = this.room;
    this.room = null;
    this.micOn = false;
    this.remotePub = null;
    this.stopMeters();
    this.dropShares();
    if (room) await room.disconnect();
  }

  // ----- Трансляция экрана -----

  /**
   * Показать свой экран или окно вместе со звуком. Windows покажет окно
   * выбора, что именно показывать.
   */
  async startScreenShare() {
    const room = this.room;
    if (!room || this.myShare.length > 0) return;
    let stream: MediaStream;
    try {
      // Нестандартные поля Chromium (WebView2 — это он): звук всей системы,
      // без звука самого BrotherHub — иначе друзья услышат себя.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          restrictOwnAudio: true,
          suppressLocalAudioPlayback: false,
        },
        systemAudio: "include",
        // Показываешь одно окно — берём звук только этого окна.
        windowAudio: "window",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
      } as DisplayMediaStreamOptions);
    } catch (err) {
      // Отмена в окне выбора — не ошибка.
      if (!String(err).includes("NotAllowed") && !String(err).includes("AbortError")) {
        this.cb.onError(`Не удалось показать экран: ${err}`);
      }
      return;
    }
    if (this.room !== room) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const [video] = stream.getVideoTracks();
    let audio: MediaStreamTrack | undefined = stream.getAudioTracks()[0];
    // Весь экран — это звук всей системы: туда попадают голоса друзей из
    // голосового чата и звук фильма из плеера, и друзья слышат сами себя.
    // Вычесть звук BrotherHub WebView2 пока не умеет, поэтому со всего
    // экрана звук не берём — только когда показывают отдельное окно.
    const surface = (video?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
    if (audio && surface === "monitor") {
      audio.stop();
      audio = undefined;
      this.cb.onError(
        "Показ всего экрана — без звука, иначе друзья слышат сами себя. Нужен звук — покажи отдельное окно.",
      );
    }
    this.myShare = stream.getTracks().filter((t) => t.readyState !== "ended");
    // «Прекратить показ» на панели Windows или закрытое окно — заканчиваем.
    video?.addEventListener("ended", () => this.stopScreenShare());
    if (video) video.contentHint = "motion";

    try {
      if (video) {
        await room.localParticipant.publishTrack(video, {
          source: Track.Source.ScreenShare,
          screenShareEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 },
          degradationPreference: "maintain-framerate",
          simulcast: false,
        });
      }
      if (audio) {
        await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          // Для фильмов и музыки: без «тишины» и в хорошем качестве.
          dtx: false,
          red: false,
          audioPreset: { maxBitrate: 128_000 },
        });
      } else {
        this.cb.onError("Экран показывается без звука: Windows не дал захватить звук.");
      }
      // Если браузер не умеет исключать собственный звук, в трансляцию
      // попадают и голоса из чата, и звук самой трансляции у соседних
      // окон — отсюда эхо.
      const supported = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>;
      if (audio && !supported.restrictOwnAudio) {
        this.cb.onError(
          "Звук трансляции может давать эхо: показывай одно окно, а не весь экран, или пусть друзья будут в наушниках.",
        );
      }
      this.cb.onLocalScreenShare(true);
    } catch (err) {
      this.cb.onError(`Не удалось показать экран: ${err}`);
      await this.stopScreenShare();
    }
  }

  async stopScreenShare() {
    const tracks = this.myShare;
    if (tracks.length === 0) return;
    this.myShare = [];
    const room = this.room;
    for (const t of tracks) {
      try {
        if (room) await room.localParticipant.unpublishTrack(t, true);
      } catch {
        // Уже снята — ничего страшного.
      }
      t.stop();
    }
    this.cb.onLocalScreenShare(false);
  }

  private emitShare() {
    this.cb.onScreenShare(this.shares[this.shares.length - 1] ?? null);
  }

  private dropShares() {
    this.myShare.forEach((t) => t.stop());
    if (this.myShare.length > 0) this.cb.onLocalScreenShare(false);
    this.myShare = [];
    this.shares = [];
    this.cb.onScreenShare(null);
  }

  // ----- Кто говорит -----

  private addMeter(identity: string, track: LocalAudioTrack | RemoteAudioTrack) {
    this.removeMeter(identity);
    try {
      const { calculateVolume, cleanup } = createAudioAnalyser(track, {
        fftSize: 512,
        smoothingTimeConstant: 0.2,
        // Тише −75 дБ — тишина и шум, громче −25 дБ — уже точно голос.
        minDecibels: -75,
        maxDecibels: -25,
      });
      this.meters.set(identity, { volume: calculateVolume, cleanup, loudAt: 0 });
    } catch {
      // Не получилось измерить — останутся данные сервера.
    }
  }

  private removeMeter(identity: string) {
    const meter = this.meters.get(identity);
    if (!meter) return;
    this.meters.delete(identity);
    meter.cleanup().catch(() => {});
  }

  private stopMeters() {
    [...this.meters.keys()].forEach((id) => this.removeMeter(id));
    if (this.poll !== null) {
      window.clearInterval(this.poll);
      this.poll = null;
    }
    this.serverSpeakers = new Set();
    this.speaking = new Set();
    this.cb.onSpeakers(new Set());
  }

  private updateSpeakers() {
    const now = performance.now();
    const next = new Set<string>();
    this.meters.forEach((meter, id) => {
      if (meter.volume() >= SPEAK_ON) meter.loudAt = now;
      if (now - meter.loudAt < SPEAK_HOLD_MS) next.add(id);
    });
    this.serverSpeakers.forEach((id) => {
      if (!this.meters.has(id)) next.add(id);
    });
    // Свой микрофон выключен — не светимся, даже если трек ещё не остановился.
    const me = this.room?.localParticipant.identity;
    if (me && !this.micOn) next.delete(me);

    if (next.size === this.speaking.size && [...next].every((id) => this.speaking.has(id))) return;
    this.speaking = next;
    this.cb.onSpeakers(new Set(next));
  }

  /** Включить/выключить передачу своего голоса. */
  async setMic(on: boolean) {
    // ТВ: говорить можно, только пока пульт передаёт звук.
    if (isTv() && on && !remoteMicActive()) on = false;
    const room = this.room;
    if (!room || on === this.micOn) return;
    this.micOn = on;
    if (isTv()) {
      await this.setRemoteMic(room, on);
      return;
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(on);
      if (on) await this.wakeNoise();
    } catch (err) {
      this.micOn = false;
      const text = String(err);
      this.cb.onError(
        text.includes("NotAllowed") || text.includes("Permission")
          ? "Нет доступа к микрофону — разреши его приложению в настройках Windows"
          : text.includes("NotFound")
            ? "Микрофон не найден"
            : `Микрофон: ${text}`,
      );
    }
  }

  /**
   * ТВ: вместо микрофона (у ТВ его нет) — звук пульта. Дорожка публикуется
   * один раз и дальше только включается/выключается: так начало фразы не
   * теряется на переподключении.
   */
  private async setRemoteMic(room: Room, on: boolean) {
    try {
      let pub = this.remotePub;
      if (pub && pub.track?.mediaStreamTrack.readyState !== "live") {
        pub = this.remotePub = null;
      }
      if (on && !pub) {
        const track = await remoteMicTrack();
        if (this.room !== room || !this.micOn) return;
        this.remotePub = await room.localParticipant.publishTrack(track, {
          source: Track.Source.Microphone,
        });
        // Пока публиковали, микрофон успели выключить.
        if (!this.micOn) await this.remotePub.mute();
      } else if (on && pub) {
        await pub.unmute();
      } else if (pub) {
        await pub.mute();
      }
    } catch (err) {
      this.micOn = false;
      this.cb.onError(`Микрофон пульта: ${err}`);
    }
  }

  /** Выключить звук от всех (и свой микрофон выключается снаружи). */
  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    this.room?.remoteParticipants.forEach((p) => this.applyVolume(p));
  }

  /** Громкость участника, 0..1. */
  setVolume(identity: string, volume: number) {
    this.volumes.set(identity, volume);
    const p = this.room?.remoteParticipants.get(identity);
    if (p) this.applyVolume(p);
  }

  async switchMic(deviceId: string) {
    try {
      await this.room?.switchActiveDevice("audioinput", deviceId);
    } catch (err) {
      this.cb.onError(`Не удалось переключить микрофон: ${err}`);
    }
  }

  private applyVolume(p: RemoteParticipant) {
    p.setVolume(this.deafened ? 0 : (this.volumes.get(p.identity) ?? 1));
  }
}

/** Список микрофонов (с запросом разрешения, чтобы были видны названия). */
export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  try {
    return await Room.getLocalDevices("audioinput", true);
  } catch {
    return [];
  }
}

// ----- Название кнопки «нажми и говори» -----

const MOUSE = 0x1_0000;

const KEY_NAMES: Record<number, string> = {
  0x08: "Backspace",
  0x09: "Tab",
  0x0d: "Enter",
  0x10: "Shift",
  0x11: "Ctrl",
  0x12: "Alt",
  0x13: "Pause",
  0x14: "Caps Lock",
  0x1b: "Esc",
  0x20: "Пробел",
  0x21: "Page Up",
  0x22: "Page Down",
  0x23: "End",
  0x24: "Home",
  0x25: "←",
  0x26: "↑",
  0x27: "→",
  0x28: "↓",
  0x2d: "Insert",
  0x2e: "Delete",
  0x5b: "Win",
  0x5c: "Win (правый)",
  0xa0: "Левый Shift",
  0xa1: "Правый Shift",
  0xa2: "Левый Ctrl",
  0xa3: "Правый Ctrl",
  0xa4: "Левый Alt",
  0xa5: "Правый Alt",
  0xc0: "` (Ё)",
  0xdb: "[ (Х)",
  0xdd: "] (Ъ)",
  0xba: "; (Ж)",
  0xde: "' (Э)",
  0xbc: ", (Б)",
  0xbe: ". (Ю)",
  0xbf: "/",
  0xdc: "\\",
};

export function keyName(code: number): string {
  if (code === (MOUSE | 3)) return "Колёсико мыши";
  if (code === (MOUSE | 4)) return "Боковая кнопка мыши 1";
  if (code === (MOUSE | 5)) return "Боковая кнопка мыши 2";
  if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) {
    return String.fromCharCode(code);
  }
  if (code >= 0x60 && code <= 0x69) return `Num ${code - 0x60}`;
  if (code >= 0x70 && code <= 0x87) return `F${code - 0x6f}`;
  return KEY_NAMES[code] ?? `Клавиша ${code}`;
}
