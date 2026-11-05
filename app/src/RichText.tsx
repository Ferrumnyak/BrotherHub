// Текст сообщения: основные смайлики рисуются объёмными картинками.

import type { ReactNode } from "react";
import { EMOJI_3D_RE, emoji3dSrc } from "./emoji";

/** Только смайлики (1–3 штуки) — показываем крупно, как в Telegram. */
function onlyEmoji(text: string): boolean {
  const rest = text.replace(EMOJI_3D_RE, "").trim();
  const count = [...text.matchAll(EMOJI_3D_RE)].length;
  return rest === "" && count > 0 && count <= 3;
}

export function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(EMOJI_3D_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <img key={key++} className="emoji3d" src={emoji3dSrc(m[1])} alt={m[0]} draggable={false} />,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className={onlyEmoji(text) ? "rich jumbo" : "rich"}>{parts}</span>;
}

/** Один смайлик для кнопки в панели: картинкой, если она есть. */
export function EmojiGlyph({ emoji }: { emoji: string }) {
  const m = [...emoji.matchAll(EMOJI_3D_RE)];
  if (m.length === 1 && m[0][0].length === emoji.length) {
    return <img className="emoji3d" src={emoji3dSrc(emoji)} alt={emoji} draggable={false} />;
  }
  return <>{emoji}</>;
}
