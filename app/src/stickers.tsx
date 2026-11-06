// Стикеры BrotherHub: свои анимированные картинки в стиле «Кинозала».
// В чат уходит текст `[[sticker:<id>]]`, а рисует стикер каждый у себя —
// поэтому они ничего не весят в сети. Анимации — в styles.css (`st-*`).

import type { ReactElement } from "react";

export interface Sticker {
  id: string;
  title: string;
  art: ReactElement;
}

const font = "Unbounded, Manrope, sans-serif";

export const STICKERS: Sticker[] = [
  {
    id: "popcorn",
    title: "Попкорн",
    art: (
      <>
        <g className="st-pop" style={{ transformOrigin: "60px 100px" }}>
          <path d="M34 52h52l-8 56H42z" fill="#c25a63" />
          <path d="M48 52l3 56M60 52v56M72 52l-3 56" stroke="#efe6dc" strokeWidth="5" />
          <g fill="#f7dca6">
            <circle cx="40" cy="48" r="10" />
            <circle cx="55" cy="40" r="12" />
            <circle cx="71" cy="42" r="11" />
            <circle cx="82" cy="50" r="9" />
            <circle cx="62" cy="52" r="9" />
          </g>
        </g>
        <g fill="#f7dca6" className="st-pop st-delay">
          <circle cx="30" cy="22" r="5" />
          <circle cx="92" cy="18" r="6" />
        </g>
      </>
    ),
  },
  {
    id: "minus-vibe",
    title: "−вайб",
    art: (
      <g className="st-stamp" style={{ transformOrigin: "60px 60px" }}>
        <rect x="12" y="38" width="96" height="44" rx="6" fill="none" stroke="#c25a63" strokeWidth="5" />
        <text x="60" y="69" textAnchor="middle" fontSize="23" fontWeight="700" fill="#c25a63" fontFamily={font}>
          −ВАЙБ
        </text>
      </g>
    ),
  },
  {
    id: "plus-vibe",
    title: "+вайб",
    art: (
      <>
        <g className="st-stamp" style={{ transformOrigin: "60px 60px" }}>
          <rect x="12" y="38" width="96" height="44" rx="6" fill="none" stroke="#9fd0a8" strokeWidth="5" />
          <text x="60" y="69" textAnchor="middle" fontSize="23" fontWeight="700" fill="#9fd0a8" fontFamily={font}>
            +ВАЙБ
          </text>
        </g>
        <g fill="#f2c879" className="st-twinkle">
          <path d="M20 22l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" />
          <path d="M98 88l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" />
        </g>
      </>
    ),
  },
  {
    id: "asleep",
    title: "Уснул на фильме",
    art: (
      <>
        <rect x="26" y="70" width="68" height="36" rx="10" fill="#6e4a3a" />
        <g className="st-nod" style={{ transformOrigin: "60px 78px" }}>
          <circle cx="60" cy="56" r="22" fill="#e0a07c" />
          <path d="M48 54q4 4 8 0M64 54q4 4 8 0" stroke="#2a1d12" strokeWidth="3" fill="none" strokeLinecap="round" />
          <ellipse cx="60" cy="66" rx="4" ry="3" fill="#2a1d12" />
        </g>
        <g fontFamily={font} fontWeight="700" fill="#8fb3c8">
          <text x="82" y="34" fontSize="14" className="st-zz">
            z
          </text>
          <text x="88" y="26" fontSize="18" className="st-zz st-delay">
            Z
          </text>
        </g>
      </>
    ),
  },
  {
    id: "toilet",
    title: "Пауза, я в туалет",
    art: (
      <>
        {/* Дверь с табличкой WC */}
        <rect x="70" y="20" width="38" height="86" rx="3" fill="#5b3f5c" />
        <circle cx="76" cy="66" r="2.5" fill="#f2c879" />
        <rect x="78" y="30" width="22" height="14" rx="3" fill="#f2c879" />
        <text x="89" y="41" textAnchor="middle" fontSize="10" fontWeight="700" fill="#2a1d12" fontFamily={font}>
          WC
        </text>
        {/* Бегущий человечек */}
        <g className="st-run">
          <circle cx="36" cy="40" r="8" fill="#e0a07c" />
          <path d="M36 48l-4 22" stroke="#e0a07c" strokeWidth="6" strokeLinecap="round" />
          <path d="M34 56l12 6M34 56l-10 -4" stroke="#e0a07c" strokeWidth="5" strokeLinecap="round" />
          <g className="st-legs" style={{ transformOrigin: "32px 70px" }}>
            <path d="M32 70l10 14M32 70l-10 12" stroke="#e0a07c" strokeWidth="5" strokeLinecap="round" />
          </g>
        </g>
        <path d="M10 46h10M6 56h12M10 66h8" stroke="#a3958c" strokeWidth="3" strokeLinecap="round" className="st-blink" />
        {/* Значок паузы */}
        <g fill="#efe6dc" className="st-blink">
          <rect x="14" y="88" width="6" height="18" rx="1.5" />
          <rect x="24" y="88" width="6" height="18" rx="1.5" />
        </g>
      </>
    ),
  },
  {
    id: "ticket",
    title: "Я ушёл",
    art: (
      <>
        <g className="st-tear-left" style={{ transformOrigin: "58px 90px" }}>
          <path d="M14 40h44l-4 8 4 8-4 8 4 8-4 8H14v-12a8 8 0 0 0 0-16z" fill="#f2c879" />
          <text x="34" y="66" textAnchor="middle" fontSize="14" fontWeight="700" fill="#2a1d12" fontFamily={font}>
            Я
          </text>
        </g>
        <g className="st-tear-right" style={{ transformOrigin: "62px 90px" }}>
          <path d="M62 40h44v12a8 8 0 0 0 0 16v12H62l4-8-4-8 4-8-4-8 4-8z" fill="#f2c879" />
          <text x="86" y="65" textAnchor="middle" fontSize="11" fontWeight="700" fill="#2a1d12" fontFamily={font}>
            ушёл
          </text>
        </g>
      </>
    ),
  },
  {
    id: "clapper",
    title: "Мотор!",
    art: (
      <>
        <rect x="22" y="56" width="76" height="46" rx="4" fill="#2a2024" />
        <path d="M30 64h60M30 76h60M30 88h40" stroke="#5e3a40" strokeWidth="4" />
        <g className="st-clap" style={{ transformOrigin: "22px 56px" }}>
          <rect x="22" y="42" width="76" height="14" rx="3" fill="#efe6dc" />
          <path d="M34 42l8 14M52 42l8 14M70 42l8 14M88 42l8 14" stroke="#2a2024" strokeWidth="6" />
        </g>
      </>
    ),
  },
  {
    id: "eyes",
    title: "Чё происходит",
    art: (
      <>
        <ellipse cx="40" cy="60" rx="20" ry="24" fill="#efe6dc" />
        <ellipse cx="80" cy="60" rx="20" ry="24" fill="#efe6dc" />
        <g className="st-look">
          <circle cx="42" cy="64" r="9" fill="#2a1d12" />
          <circle cx="82" cy="64" r="9" fill="#2a1d12" />
        </g>
        <path d="M20 34l38 10M100 34l-38 10" stroke="#a3958c" strokeWidth="5" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: "spoiler",
    title: "Не спойлери!",
    art: (
      <g className="st-shake">
        <rect x="10" y="34" width="100" height="52" rx="8" fill="#c25a63" />
        <text x="60" y="66" textAnchor="middle" fontSize="15" fontWeight="700" fill="#efe6dc" fontFamily={font}>
          СПОЙЛЕР
        </text>
      </g>
    ),
  },
];

const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));
const STICKER_RE = /^\[\[sticker:([a-z0-9-]+)\]\]$/;

/** Текст сообщения для стикера. */
export function stickerMessage(id: string): string {
  return `[[sticker:${id}]]`;
}

/** Стикер из сообщения, если это стикер. */
export function stickerFromMessage(text: string): Sticker | null {
  const m = STICKER_RE.exec(text.trim());
  return (m && BY_ID.get(m[1])) || null;
}

export function StickerArt({ sticker, size = 96 }: { sticker: Sticker; size?: number }) {
  return (
    <svg
      className="sticker"
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="img"
      aria-label={sticker.title}
    >
      {sticker.art}
    </svg>
  );
}
