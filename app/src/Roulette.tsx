// Рулетка «Что посмотреть»: настоящее колесо с секторами.
// Какой сектор выпадет, решает сервер; колесо только красиво туда докручивается.

import { useEffect, useRef, useState } from "react";
import type { Suggestion } from "./protocol";

/** Сколько крутится колесо, мс (совпадает с transition в стилях). */
export const SPIN_MS = 5200;

const COLORS = ["#6E4A3A", "#3F5260", "#4E5A3C", "#5B3F5C", "#6A5130", "#3E4E4A", "#5E3A40", "#46466A"];
const SIZE = 220;
const R = 100;
const C = SIZE / 2;

function point(angle: number, radius: number): [number, number] {
  // 0° — вверх, по часовой стрелке.
  const a = ((angle - 90) * Math.PI) / 180;
  return [C + radius * Math.cos(a), C + radius * Math.sin(a)];
}

function label(media: string, title: (m: string) => string): string {
  const t = title(media);
  return t.length > 14 ? `${t.slice(0, 13)}…` : t;
}

export function RouletteWheel({
  list,
  winner,
  title,
}: {
  list: Suggestion[];
  /** Номер выпавшего в `list`, пока колесо крутится; иначе `null`. */
  winner: number | null;
  title: (media: string) => string;
}) {
  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(0);
  const n = Math.max(list.length, 1);
  const seg = 360 / n;

  useEffect(() => {
    if (winner === null) return;
    // Небольшой сдвиг внутри сектора, одинаковый у всех (по id выпавшего).
    const id = list[winner]?.id ?? 0;
    const jitter = ((((id * 9301 + 49297) % 233280) / 233280) - 0.5) * seg * 0.6;
    const target = 360 - (winner + 0.5) * seg + jitter;
    const current = rotationRef.current;
    const base = current - (((current % 360) + 360) % 360);
    const next = base + 360 * 6 + target;
    rotationRef.current = next;
    setRotation(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winner]);

  return (
    <div className="wheel" role="img" aria-label="Рулетка">
      {/* Крутится весь слой целиком (видеокартой), а не отдельные фигуры SVG —
          так колесо идёт плавно. */}
      <div
        className={winner === null ? "wheel-disk" : "wheel-disk spinning"}
        style={{ transform: `rotate(${rotation}deg)` }}
      >
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
        <g>
          {list.length <= 1 ? (
            <circle cx={C} cy={C} r={R} fill={COLORS[0]} />
          ) : (
            list.map((s, i) => {
              const [x1, y1] = point(i * seg, R);
              const [x2, y2] = point((i + 1) * seg, R);
              const large = seg > 180 ? 1 : 0;
              return (
                <path
                  key={s.id}
                  d={`M${C} ${C}L${x1} ${y1}A${R} ${R} 0 ${large} 1 ${x2} ${y2}Z`}
                  fill={COLORS[i % COLORS.length]}
                  stroke="#191416"
                  strokeWidth="2"
                />
              );
            })
          )}
          {list.map((s, i) => {
            const mid = (i + 0.5) * seg;
            const [x, y] = point(mid, R * 0.58);
            return (
              <text
                key={s.id}
                x={x}
                y={y}
                transform={`rotate(${mid - 90} ${x} ${y})`}
                textAnchor="middle"
                dominantBaseline="middle"
                className="wheel-label"
              >
                {label(s.media, title)}
              </text>
            );
          })}
          <circle cx={C} cy={C} r="14" fill="#191416" stroke="#f2c879" strokeWidth="3" />
        </g>
      </svg>
      </div>
      {/* Стрелка сверху — отдельно, она не крутится */}
      <svg className="wheel-pointer" viewBox="0 0 24 24" width="24" height="24">
        <path d="M2 2L22 2L12 22Z" fill="#f2c879" stroke="#191416" strokeWidth="2" />
      </svg>
    </div>
  );
}
