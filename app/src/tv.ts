// Android TV: управление пультом (D-pad).
//
// WebView сам не умеет переходить стрелками между кнопками, поэтому делаем
// это здесь: стрелка — фокус на ближайший элемент в эту сторону, «ОК» на
// пульте — это Enter, он нажимает кнопку сам.

import { invoke } from "@tauri-apps/api/core";

/** Это телевизор (класс `tv` у <html>)? */
export function isTv(): boolean {
  return document.documentElement.classList.contains("tv");
}

const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

type Dir = "up" | "down" | "left" | "right";

const DIRS: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

/** Ближайший элемент в направлении `dir` от `from`. */
function next(from: Element | null, dir: Dir): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el !== from && visible(el),
  );
  if (!from) return all[0] ?? null;
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    // Только то, что действительно в эту сторону.
    const ahead =
      dir === "up" ? b.bottom <= a.top + 4 :
      dir === "down" ? b.top >= a.bottom - 4 :
      dir === "left" ? b.right <= a.left + 4 :
      b.left >= a.right - 4;
    if (!ahead) continue;
    // Вдоль направления — расстояние, поперёк — штраф побольше.
    const along = dir === "up" || dir === "down" ? Math.abs(dy) : Math.abs(dx);
    const across = dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Стрелки внутри поля ввода двигают курсор, пока он не упёрся в край. */
function arrowStaysInField(el: Element | null, dir: Dir): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  if (el instanceof HTMLInputElement && !["text", "search", "password", "url", ""].includes(el.type))
    return dir === "left" || dir === "right"; // ползунки и т.п.
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (dir === "left") return start > 0;
  if (dir === "right") return end < el.value.length;
  return false;
}

/** Включить управление пультом, если это телевизор. */
export async function initTv() {
  let tv = false;
  try {
    tv = (await invoke<{ tv: boolean }>("mobile_info")).tv;
  } catch {
    return;
  }
  if (!tv) return;
  document.documentElement.classList.add("tv");

  window.addEventListener(
    "keydown",
    (e) => {
      const dir = DIRS[e.key];
      if (!dir) return;
      const current = document.activeElement === document.body ? null : document.activeElement;
      if (arrowStaysInField(current, dir)) return;
      const target = next(current, dir);
      // Перехватываем стрелку, даже если идти некуда: иначе она перематывала бы видео.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    },
    true,
  );

  // Сразу что-нибудь в фокусе — иначе первое нажатие «ничего не делает».
  setTimeout(() => {
    if (document.activeElement === document.body) next(null, "down")?.focus();
  }, 800);
}
