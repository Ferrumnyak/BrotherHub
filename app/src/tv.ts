// Android TV: управление пультом (D-pad).
//
// WebView сам не умеет переходить стрелками между кнопками, поэтому делаем
// это здесь: стрелка — фокус на ближайший элемент в эту сторону, «ОК» на
// пульте — это Enter, он нажимает кнопку сам.

import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID } from "./platform";

/** Это телевизор (класс `tv` у <html>)? */
export function isTv(): boolean {
  return document.documentElement.classList.contains("tv");
}

// summary — заголовки раскрывашек («Сервер и пароль», «Темы»).
/** Запись в журнал (на Android видна в adb logcat с тегом BrotherHub). */
function say(message: string) {
  invoke("ui_log", { message }).catch(() => {});
}

const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

type Dir = "up" | "down" | "left" | "right";

const DIRS: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Коды клавиш: некоторые ТВ присылают стрелки без имени клавиши. */
const DIR_CODES: Record<number, Dir> = { 37: "left", 38: "up", 39: "right", 40: "down" };

function dirOf(e: KeyboardEvent): Dir | undefined {
  return DIRS[e.key] ?? DIR_CODES[e.keyCode];
}

/** «ОК» на пульте (Enter; 23 — DPAD_CENTER, если его не перевели в Enter). */
function isOk(e: KeyboardEvent): boolean {
  return e.key === "Enter" || e.keyCode === 13 || e.keyCode === 23;
}

function visible(el: Element): boolean {
  // Содержимое закрытой раскрывашки не видно, хотя размеры у него есть
  // (иначе стрелка всё время целилась в скрытые поля «Сервер и пароль»).
  const details = el.closest("details");
  if (details && !details.open && el.tagName !== "SUMMARY") return false;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
    return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

/** Ближайший предок с прокруткой по вертикали. */
function scroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return null;
}

/** Элемент спрятан за краем своей прокручиваемой панели. */
function clippedOut(el: Element): boolean {
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.overflowY === "visible" && style.overflowX === "visible") continue;
    const b = p.getBoundingClientRect();
    if (r.bottom <= b.top + 2 || r.top >= b.bottom - 2 || r.right <= b.left + 2 || r.left >= b.right - 2) {
      return true;
    }
  }
  return false;
}

/** Последний выделенный элемент (куда вернуться, если фокус потерялся). */
let lastFocused: HTMLElement | null = null;

/** Элементы, которые не удалось выделить при этом нажатии. */
const skip = new Set<Element>();

/** Ближайший элемент в направлении `dir` от `from`. */
function next(from: Element | null, dir: Dir): HTMLElement | null {
  const ordered = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el === from || visible(el),
  );
  const all = ordered.filter((el) => el !== from && !skip.has(el));
  if (!from) return all.find((el) => !clippedOut(el)) ?? all[0] ?? null;
  // Сначала — внутри той же прокручиваемой панели (настройки, чат), даже то,
  // что пока за её краем: панель прокрутится. Иначе «вниз» из середины
  // настроек прыгало на кнопки голоса под ними.
  const box = scroller(from);
  if (box) {
    const inside = nearest(from, all.filter((el) => box.contains(el)), dir);
    if (inside) return inside;
  }
  // Дальше — только то, что сейчас видно в своих панелях.
  const spatial = nearest(from, all.filter((el) => !clippedOut(el)), dir);
  if (spatial) return spatial;
  // В эту сторону по раскладке ничего нет — следующий (или предыдущий)
  // по порядку на странице: так можно дойти до любого элемента.
  const i = ordered.indexOf(from as HTMLElement);
  if (i < 0) return null;
  return (dir === "down" || dir === "right" ? ordered[i + 1] : ordered[i - 1]) ?? null;
}

function nearest(from: Element, all: HTMLElement[], dir: Dir): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const vertical = dir === "up" || dir === "down";
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    const b = el.getBoundingClientRect();
    // Только то, что действительно в эту сторону.
    const ahead =
      dir === "up" ? b.bottom <= a.top + 4 :
      dir === "down" ? b.top >= a.bottom - 4 :
      dir === "left" ? b.right <= a.left + 4 :
      b.left >= a.right - 4;
    if (!ahead) continue;
    // Расстояния считаем между краями, а не центрами: узкий заголовок прямо
    // над кнопкой ближе, чем широкая кнопка, у которой центр по пути.
    const along = Math.max(
      0,
      dir === "up" ? a.top - b.bottom :
      dir === "down" ? b.top - a.bottom :
      dir === "left" ? a.left - b.right :
      b.left - a.right,
    );
    const across = vertical
      ? Math.max(0, b.left - a.right, a.left - b.right)
      : Math.max(0, b.top - a.bottom, a.top - b.bottom);
    const score = along + across * 3;
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
  // Клавиатура появляется при новом фокусе. Сначала убираем фокус (это
  // сбрасывает `typing`), потом отмечаем поле и фокусируем снова.
  el.blur();
  typing = el;
  unquiet(el);
  el.focus({ preventScroll: true });
  el.click();
  // WebView на ТВ сам клавиатуру не показывает — просим систему.
  setTimeout(() => invoke("mobile_keyboard").catch(() => {}), 50);
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
  } catch (e) {
    if (!IS_ANDROID) return; // компьютер
    say(`пульт: не узнал, ТВ ли это: ${e}`);
  }
  say(`пульт: это ТВ? ${tv}; экран ${innerWidth}×${innerHeight}, масштаб ${devicePixelRatio}`);
  hideVideoPoster();
  let seen = 0;
  window.addEventListener(
    "keydown",
    (e) => {
      if (seen++ < 3) say(`пульт: клавиша key=${e.key} code=${e.keyCode}`);
    },
    true,
  );
  if (tv) {
    enable();
    return;
  }
  // Приставка не сказала, что она телевизор, но нажали стрелку пульта —
  // значит, всё-таки телевизор.
  const probe = (e: KeyboardEvent) => {
    if (!dirOf(e)) return;
    window.removeEventListener("keydown", probe, true);
    enable("по нажатию стрелки");
    onKey(e);
  };
  window.addEventListener("keydown", probe, true);
}

let enabled = false;

/**
 * «ОК» с пульта (вызывает Kotlin, см. PlayerPlugin.routeKey): поле — открыть
 * клавиатуру, остальное — нажать.
 */
function okFromRemote() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return;
  say(`пульт: ОК → ${describe(el)}`);
  if (isTextField(el)) {
    if (el !== typing) startTyping(el);
    return;
  }
  el.click();
}

function enable(how = "по системе") {
  if (enabled) return;
  enabled = true;
  (window as unknown as { __bhOk?: () => void }).__bhOk = okFromRemote;
  say(`пульт: режим ТВ включён ${how}`);
  document.documentElement.classList.add("tv");
  window.addEventListener("keydown", onKey, true);
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target as Element;
      if (el instanceof HTMLElement && el.matches(FOCUSABLE)) lastFocused = el;
      if (isTextField(el)) quiet(el);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      const el = e.target as Element;
      // Фокус ушёл из всего окна (а не на другой элемент) — поле осталось
      // выделенным, ничего не сбрасываем.
      if (document.activeElement === el) return;
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
  if (isOk(e)) {
    const el = document.activeElement;
    if (isTextField(el) && el === typing) {
      // Enter на клавиатуре — отправили: прячем клавиатуру, поле остаётся
      // выделенным для пульта.
      setTimeout(() => {
        typing = null;
        el.blur();
        quiet(el);
        el.focus({ preventScroll: true });
      }, 0);
      return;
    }
    if (isTextField(el) && el !== typing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      startTyping(el);
    } else if (el instanceof HTMLElement && el.matches(CLICK_ON_OK)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      say(`пульт: ОК → ${describe(el)}`);
      el.click();
    }
    return;
  }
  const dir = dirOf(e);
  if (!dir) return;
  let current = document.activeElement === document.body ? null : document.activeElement;
  // Фокус не на кнопке/поле (например, пульт вернулся из окна сайта) —
  // возвращаемся туда, где было выделение.
  if (current && !current.matches(FOCUSABLE)) {
    if (lastFocused?.isConnected && visible(lastFocused)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      lastFocused.focus({ preventScroll: true });
      say(`пульт: ${dir} → ${describe(lastFocused)} (вернулся)`);
      return;
    }
    current = null;
  }
  if (arrowStaysInField(current, dir)) return;
  // Площадки «Обзора» — нижний ряд над окном сайта: «вниз» — в сайт.
  if (dir === "down" && current?.closest(".site-chips") && document.querySelector(".room.browsing")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    say("пульт: down → окно сайта");
    invoke("mobile_browser_focus").catch(() => {});
    return;
  }
  let target = next(current, dir);
  // Перехватываем стрелку, даже если идти некуда: иначе она перематывала бы видео.
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!target) {
    say(`пульт: ${dir} — некуда (с ${describe(current)})`);
  }
  // Не выделился — пробуем следующий в ту же сторону (не больше 5 раз).
  for (let tries = 0; target && tries < 5; tries++) {
    if (isTextField(target)) quiet(target);
    target.focus({ preventScroll: true });
    if (document.activeElement === target) break;
    say(`пульт: не выделяется ${describe(target)}`);
    skip.add(target);
    target = next(current, dir);
  }
  skip.clear();
  if (target && document.activeElement === target) {
    say(`пульт: ${dir} → ${describe(target)}`);
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function describe(el: Element | null): string {
  if (!el) return "ничего";
  const text = (el.textContent ?? "").trim().slice(0, 30);
  return `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} «${text}»`;
}

/**
 * WebView на Android рисует в пустом <video> свою заглушку — зелёного
 * робота. Ставим всем видео прозрачную обложку.
 */
function hideVideoPoster() {
  const blank = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const fix = (root: ParentNode) =>
    root.querySelectorAll("video:not([poster])").forEach((v) => v.setAttribute("poster", blank));
  fix(document);
  new MutationObserver(() => fix(document)).observe(document.body, { childList: true, subtree: true });
}
