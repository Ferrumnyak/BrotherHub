// Типы протокола — копия shared/src/lib.rs.
// Если меняешь протокол там, поменяй и здесь.

export type MemberId = number;

export interface Member {
  id: MemberId;
  name: string;
  /** false — связь пропала, ждём переподключения. */
  online: boolean;
  /** Подключён к голосу. */
  in_voice?: boolean;
  /** Микрофон включён. */
  mic?: boolean;
  /** Выключил себе звук от всех. */
  deaf?: boolean;
}

/** Предложение, что посмотреть. */
export interface Suggestion {
  id: number;
  media: string;
  by: MemberId;
  name: string;
}

/** Пропуск в голосовой канал LiveKit. */
export interface VoiceAccess {
  url: string;
  token: string;
}

/** Файл субтитров, который ведущий раздаёт всем. */
export interface SubtitleFile {
  name: string;
  text: string;
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
  | { type: "suggest"; media: string }
  | { type: "remove_suggestion"; id: number }
  | { type: "loaded"; media: string }
  | { type: "voice_state"; in_voice: boolean; mic: boolean; deaf: boolean }
  | { type: "react"; emoji: string }
  | { type: "rig"; weights: Array<[number, number]>; key?: string | null }
  | { type: "set_media"; media: string }
  | { type: "play"; position: number }
  | { type: "pause"; position: number }
  | { type: "seek"; position: number }
  | { type: "sync"; position: number; paused: boolean }
  | { type: "transfer_host"; to: MemberId }
  | { type: "kick"; id: MemberId }
  | { type: "spin"; weights?: Array<[number, number]> }
  | { type: "clear_media" }
  | { type: "set_subtitles"; subtitles: SubtitleFile | null };

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
      suggestions?: Suggestion[];
      subtitles?: SubtitleFile | null;
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
  | { type: "error"; message: string }
  | { type: "suggestions"; list: Suggestion[] }
  | { type: "roulette"; winner: number; by: string }
  | { type: "member_loaded"; id: MemberId; media: string }
  | { type: "member_voice"; id: MemberId; in_voice: boolean; mic: boolean; deaf: boolean }
  | { type: "reaction"; from: MemberId; name: string; emoji: string }
  | { type: "subtitles"; subtitles: SubtitleFile | null };

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
  /** Название видео или трека (как его отдал сайт). */
  title?: string | null;
  /** Видео доиграло до конца. */
  ended?: boolean;
}

/** Обложка трека без картинки (SoundCloud и т.п.), событие `player-cover`. */
export interface Cover {
  image: string | null;
  title: string | null;
  artist: string | null;
}

/** Кнопки панели управления (команда `player_control`). */
export type Control =
  | { type: "toggle_pause" }
  | { type: "play" }
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
