// Реакции: летящие эмодзи поверх видео (отдельное прозрачное окно, см.
// src-tauri/src/reactions.rs) и кнопки для их отправки.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emoji3dSrc, isEmoji3d } from "./emoji";
import { STICKERS, StickerArt } from "./stickers";
import type { ServerMsg } from "./protocol";

/** Реакции в панели плеера: эмодзи и стикеры «+вайб» / «−вайб» (`sticker:<id>`). */
export const REACTIONS = [
  "sticker:plus-vibe",
  "sticker:minus-vibe",
  "😂",
  "🔥",
  "😍",
  "👍",
  "💩",
  "😱",
  "😭",
  "💀",
  "🍿",
  "🤯",
];

/** Пауза между своими реакциями, мс (сервер тоже не пропустит чаще). */
const COOLDOWN_MS = 1200;

/** Картинка реакции: стикер, объёмный эмодзи или просто символ. */
function ReactionArt({ emoji, size }: { emoji: string; size: number }) {
  if (emoji.startsWith("sticker:")) {
    const sticker = STICKERS.find((s) => `sticker:${s.id}` === emoji);
    if (sticker) return <StickerArt sticker={sticker} size={size} />;
  }
  if (isEmoji3d(emoji)) {
    return <img src={emoji3dSrc(emoji)} alt={emoji} width={size} height={size} draggable={false} />;
  }
  return (
    <span className="reaction-text" style={{ fontSize: size * 0.8 }}>
      {emoji}
    </span>
  );
}

function reactionTitle(emoji: string) {
  return emoji.startsWith("sticker:")
    ? (STICKERS.find((s) => `sticker:${s.id}` === emoji)?.title ?? emoji)
    : emoji;
}

/** Сколько летит одна реакция, мс. */
const FLIGHT_MS = 3200;
/** Больше одновременно — уже каша на экране. */
const MAX_FLYING = 24;

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
          <ReactionArt emoji={f.emoji} size={f.emoji.startsWith("sticker:") ? 84 : 60} />
          <span className="reaction-name">{f.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Ряд кнопок-реакций для панели плеера. */
export function ReactionPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [cooling, setCooling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = (emoji: string) => {
    if (cooling) return;
    onPick(emoji);
    setCooling(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCooling(false), COOLDOWN_MS);
  };
  return (
    <div
      className={cooling ? "reaction-picker cooling" : "reaction-picker"}
      role="group"
      aria-label="Реакции"
    >
      {REACTIONS.map((emoji) => (
        <button
          key={emoji}
          className="reaction-button"
          disabled={cooling}
          onClick={() => pick(emoji)}
          title={reactionTitle(emoji)}
        >
          <ReactionArt emoji={emoji} size={emoji.startsWith("sticker:") ? 32 : 26} />
        </button>
      ))}
    </div>
  );
}
