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

export type ClientMsg =
  | { type: "join"; room: string; name: string }
  | { type: "chat"; text: string }
  | { type: "set_media"; media: string }
  | { type: "play"; position: number }
  | { type: "pause"; position: number }
  | { type: "seek"; position: number };

export type ServerMsg =
  | {
      type: "welcome";
      you: MemberId;
      room: string;
      members: Member[];
      playback: PlaybackState;
    }
  | { type: "member_joined"; member: Member }
  | { type: "member_left"; id: MemberId }
  | { type: "chat"; from: MemberId; name: string; text: string }
  | { type: "playback"; playback: PlaybackState; by: string }
  | { type: "error"; message: string };
