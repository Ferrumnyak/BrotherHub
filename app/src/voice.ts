// Голосовая связь через LiveKit.
//
// Звук идёт напрямую через сервер LiveKit; пропуск (token) выдаёт наш
// сервер при входе в комнату. Участник голосового канала опознаётся по
// id участника комнаты (строкой).

import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
} from "livekit-client";

export type VoiceStatus = "off" | "connecting" | "connected" | "error";

export interface VoiceCallbacks {
  onStatus(status: VoiceStatus, error?: string): void;
  /** Кто сейчас говорит (id участников строками). */
  onSpeakers(identities: Set<string>): void;
  /** Ошибка, не обрывающая соединение (например, нет доступа к микрофону). */
  onError(message: string): void;
}

export class VoiceClient {
  private room: Room | null = null;
  private volumes = new Map<string, number>();
  private deafened = false;
  private micOn = false;

  constructor(private cb: VoiceCallbacks) {}

  get connected(): boolean {
    return this.room !== null;
  }

  async connect(url: string, token: string, micDeviceId?: string) {
    await this.disconnect();

    const room = new Room({
      audioCaptureDefaults: {
        deviceId: micDeviceId || undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.room = room;
    this.micOn = false;

    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _publication: unknown, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.style.display = "none";
        document.body.appendChild(el);
        this.applyVolume(participant);
      },
    );
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
    });
    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => this.applyVolume(p));
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.cb.onSpeakers(new Set(speakers.map((p) => p.identity)));
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.room = null;
      this.cb.onSpeakers(new Set());
      this.cb.onStatus("off");
    });

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
    if (room) await room.disconnect();
  }

  /** Включить/выключить передачу своего голоса. */
  async setMic(on: boolean) {
    const room = this.room;
    if (!room || on === this.micOn) return;
    this.micOn = on;
    try {
      await room.localParticipant.setMicrophoneEnabled(on);
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
