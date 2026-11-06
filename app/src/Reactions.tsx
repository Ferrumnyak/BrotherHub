// Реакции: летящие эмодзи поверх видео (отдельное прозрачное окно, см.
// src-tauri/src/reactions.rs) и кнопки для их отправки.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emoji3dSrc, isEmoji3d } from "./emoji";
import type { ServerMsg } from "./protocol";

/** Реакции в панели плеера. */
export const REACTIONS = ["😂", "😍", "🔥", "👍", "😱", "😭", "👏", "💀", "🍿", "🤯"];

/** Сколько летит одна реакция, мс. */
const FLIGHT_MS = 3200;
/** Больше одновременно — уже каша на экране. */
const MAX_FLYING = 40;

interface Flying {
  id: number;
  emoji: string;
  name: string;
  /** Откуда взлетает, % ширины. */
  x: number;
  /** Куда сносит в полёте, px. */
  drift: number;
}

/** Содержимое окна реакций: слушает сервер и запускает эмодзи. */
export function ReactionsLayer() {
  const [flying, setFlying] = useState<Flying[]>([]);
  const next = useRef(1);

  useEffect(() => {
    document.documentElement.classList.add("overlay");
    let active = true;
    let unlisten: (() => void) | undefined;
    listen<ServerMsg>("server-message", (e) => {
      const msg = e.payload;
      if (msg.type !== "reaction") return;
      const item: Flying = {
        id: next.current++,
        emoji: msg.emoji,
        name: msg.name,
        x: 8 + Math.random() * 84,
        drift: Math.round((Math.random() - 0.5) * 120),
      };
      setFlying((list) => [...list.slice(-(MAX_FLYING - 1)), item]);
      setTimeout(() => setFlying((list) => list.filter((f) => f.id !== item.id)), FLIGHT_MS);
    }).then((u) => (active ? (unlisten = u) : u()));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return (
    <div className="reactions-layer">
      {flying.map((f) => (
        <div
          key={f.id}
          className="reaction"
          style={{ left: `${f.x}%`, ["--drift" as string]: `${f.drift}px` }}
        >
          {isEmoji3d(f.emoji) ? (
            <img src={emoji3dSrc(f.emoji)} alt={f.emoji} draggable={false} />
          ) : (
            <span className="reaction-text">{f.emoji}</span>
          )}
          <span className="reaction-name">{f.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Ряд кнопок-реакций для панели плеера. */
export function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="reaction-picker" role="group" aria-label="Реакции">
      {REACTIONS.map((emoji) => (
        <button key={emoji} className="reaction-button" onClick={() => onPick(emoji)} title={emoji}>
          <img src={emoji3dSrc(emoji)} alt={emoji} draggable={false} />
        </button>
      ))}
    </div>
  );
}
