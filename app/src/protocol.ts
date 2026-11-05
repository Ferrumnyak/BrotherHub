// Типы протокола — копия shared/src/lib.rs.
// Если меняешь протокол там, поменяй и здесь.

export type MemberId = number;

export interface Member {
  id: MemberId;
  name: string;
  /** false — связь пропала, ждём переподключения. */
  online: boolean;
}

/** Пропуск в голосовой канал LiveKit. */
export interface VoiceAccess {
  url: string;
  token: string;
}

export interface PlaybackState {
  media: string | null;
  paused: boolean;
  position: number;
}

export type PlaybackAction = "set_media" | "play" | "pause" | "seek";

export type ClientMsg =
  | {
      type: "join";
      room: string;
      name: string;
      password?: string | null;
      resume?: string | null;
    }
  | { type: "leave" }
  | { type: "chat"; text: string }
  | { type: "set_media"; media: string }
  | { type: "play"; position: number }
  | { type: "pause"; position: number }
  | { type: "seek"; position: number }
  | { type: "sync"; position: number; paused: boolean }
  | { type: "transfer_host"; to: MemberId }
  | { type: "kick"; id: MemberId };

export type ServerMsg =
  | {
      type: "welcome";
      you: MemberId;
      token: string;
      resumed: boolean;
      room: string;
      host: MemberId;
      members: Member[];
      playback: PlaybackState;
      voice: VoiceAccess | null;
    }
  | { type: "member_joined"; member: Member }
  | { type: "member_status"; id: MemberId; online: boolean }
  | { type: "member_left"; id: MemberId; kicked: boolean }
  | { type: "kicked"; by: string }
  | { type: "host_changed"; host: MemberId }
  | { type: "chat"; from: MemberId; name: string; text: string }
  | {
      type: "playback";
      playback: PlaybackState;
      action: PlaybackAction | null;
      by: string | null;
    }
  | { type: "error"; message: string };

/** Состояние плеера mpv (событие `player-status` от Rust-части). */
export interface PlayerStatus {
  running: boolean;
  loaded: string | null;
}

export function isUrl(media: string): boolean {
  const m = media.trimStart().toLowerCase();
  return m.startsWith("http://") || m.startsWith("https://");
}

/** Клавиши, нажатые в окне видео (событие `player-key`). */
export type PlayerKey = "fullscreen" | "exit-fullscreen" | "toggle-chat";

/** Позиция, длительность и громкость (команда `player_info`). */
export interface PlaybackInfo {
  position: number | null;
  duration: number | null;
  paused: boolean;
  volume: number | null;
}

/** Кнопки панели управления (команда `player_control`). */
export type Control =
  | { type: "toggle_pause" }
  | { type: "seek"; position: number }
  | { type: "seek_by"; delta: number }
  | { type: "volume"; value: number }
  | { type: "set_audio"; id: number | null }
  | { type: "set_subtitle"; id: number | null }
  | { type: "add_subtitle"; path: string };

/** Дорожка в плеере (событие `player-tracks`). */
export interface Track {
  id: number;
  kind: "audio" | "sub" | "video" | string;
  title: string | null;
  lang: string | null;
  codec: string | null;
  channels: number | null;
  external: boolean;
  selected: boolean;
}
