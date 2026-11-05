// Типы протокола — копия shared/src/lib.rs.
// Если меняешь протокол там, поменяй и здесь.

export type MemberId = number;

export interface Member {
  id: MemberId;
  name: string;
}

export interface PlaybackState {
  media: string | null;
  paused: boolean;
  position: number;
}

export type PlaybackAction = "set_media" | "play" | "pause" | "seek";

export type ClientMsg =
  | { type: "join"; room: string; name: string }
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
      room: string;
      host: MemberId;
      members: Member[];
      playback: PlaybackState;
    }
  | { type: "member_joined"; member: Member }
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
