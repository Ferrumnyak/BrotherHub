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

// summary — заголовки раскрывашек («Сервер и пароль», «Темы»).
const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

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
  const ordered = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el === from || visible(el),
  );
  const all = ordered.filter((el) => el !== from);
  if (!from) return all[0] ?? null;
  const spatial = nearest(from, all, dir);
  if (spatial) return spatial;
  // В эту сторону по раскладке ничего нет — следующий (или предыдущий)
  // по порядку на странице: так можно дойти до любого элемента.
  const i = ordered.indexOf(from as HTMLElement);
  if (i < 0) return null;
  return (dir === "down" || dir === "right" ? ordered[i + 1] : ordered[i - 1]) ?? null;
}

function nearest(from: Element, all: HTMLElement[], dir: Dir): HTMLElement | null {
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

/** Поле для текста (на нём пульт открывает экранную клавиатуру). */
function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return (
    el instanceof HTMLInputElement &&
    ["text", "search", "password", "url", "email", "number", "tel", ""].includes(el.type)
  );
}

/** Поле, в котором сейчас печатают (клавиатуру открыли кнопкой «ОК»). */
let typing: Element | null = null;

/**
 * Не открывать клавиатуру, когда на поле просто перешли стрелками: на ТВ она
 * закрывает пол-экрана. `inputmode="none"` прячет её; прежнее значение
 * возвращаем, когда поле теряет фокус.
 */
function quiet(el: HTMLInputElement | HTMLTextAreaElement) {
  if (el === typing || el.dataset.tvQuiet) return;
  el.dataset.tvQuiet = el.getAttribute("inputmode") ?? "-";
  el.setAttribute("inputmode", "none");
}

function unquiet(el: HTMLInputElement | HTMLTextAreaElement) {
  const before = el.dataset.tvQuiet;
  if (before === undefined) return;
  delete el.dataset.tvQuiet;
  if (before === "-") el.removeAttribute("inputmode");
  else el.setAttribute("inputmode", before);
}

/** «ОК» на поле: открыть клавиатуру. */
function startTyping(el: HTMLInputElement | HTMLTextAreaElement) {
  typing = el;
  unquiet(el);
  // Клавиатура появляется при новом фокусе.
  el.blur();
  el.focus({ preventScroll: true });
  el.click();
}

/**
 * Элементы, которые браузер сам по «ОК» не нажимает: заголовки раскрывашек
 * и строки с tabindex. Кнопки, ссылки и поля он нажимает сам.
 */
const CLICK_ON_OK = 'summary, [tabindex]:not(button):not(a):not(input):not(select):not(textarea)';

/** Включить управление пультом, если это телевизор. */
export async function initTv() {
  let tv = false;
  try {
    tv = (await invoke<{ tv: boolean }>("mobile_info")).tv;
  } catch {
    return; // не Android
  }
  if (tv) {
    enable();
    return;
  }
  // Приставка не сказала, что она телевизор, но нажали стрелку пульта —
  // значит, всё-таки телевизор.
  const probe = (e: KeyboardEvent) => {
    if (!DIRS[e.key]) return;
    window.removeEventListener("keydown", probe, true);
    enable("по нажатию стрелки");
    onKey(e);
  };
  window.addEventListener("keydown", probe, true);
}

let enabled = false;

function enable(how = "по системе") {
  if (enabled) return;
  enabled = true;
  invoke("ui_log", { message: `пульт: режим ТВ включён ${how}` }).catch(() => {});
  // Видно в adb logcat (строки chromium … CONSOLE).
  console.info(`BrotherHub: пульт: режим ТВ включён ${how}`);
  document.documentElement.classList.add("tv");
  window.addEventListener("keydown", onKey, true);
  document.addEventListener(
    "focusin",
    (e) => {
      if (isTextField(e.target as Element)) quiet(e.target as HTMLInputElement);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      const el = e.target as Element;
      if (el === typing) typing = null;
      if (isTextField(el)) unquiet(el);
    },
    true,
  );
  // Поле с autoFocus уже в фокусе (и клавиатура могла открыться) — прячем.
  const active = document.activeElement;
  if (isTextField(active)) {
    quiet(active);
    active.blur();
    active.focus({ preventScroll: true });
  }
  // Сразу что-нибудь в фокусе — иначе первое нажатие «ничего не делает».
  setTimeout(() => {
    if (document.activeElement === document.body) next(null, "down")?.focus();
  }, 800);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    const el = document.activeElement;
    if (isTextField(el) && el !== typing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      startTyping(el);
    } else if (el instanceof HTMLElement && el.matches(CLICK_ON_OK)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      el.click();
    }
    return;
  }
  const dir = DIRS[e.key];
  if (!dir) return;
  const current = document.activeElement === document.body ? null : document.activeElement;
  if (arrowStaysInField(current, dir)) return;
  const target = next(current, dir);
  // Перехватываем стрелку, даже если идти некуда: иначе она перематывала бы видео.
  e.preventDefault();
  e.stopImmediatePropagation();
  if (target) {
    if (isTextField(target)) quiet(target);
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) {
      console.info(`BrotherHub: пульт: не выделяется ${target.tagName.toLowerCase()}.${target.className}`);
    }
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
