// Темы оформления. Цвета — в styles.css (html[data-theme]).

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { IS_ANDROID } from "./platform";

export const THEMES = [
  { id: "popcorn", title: "Попкорн", swatch: ["#0f0d10", "#f2c879", "#c25a63"] },
  { id: "neon", title: "Неон-кино", swatch: ["#0e0b1a", "#ff5fa2", "#8b9dff"] },
  { id: "sunset", title: "Закат", swatch: ["#140c14", "#ff8a4c", "#ffb3c6"] },
  { id: "mint", title: "Мята", swatch: ["#0c1112", "#5eead4", "#ffb38a"] },
  { id: "city", title: "Ночной город", swatch: ["#0a0f1c", "#c4f04d", "#6fb1ff"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "theme";

export function savedTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY);
    if (THEMES.some((x) => x.id === t)) return t as ThemeId;
  } catch {
    // Нет хранилища — тема по умолчанию.
  }
  return "popcorn";
}

function apply(theme: ThemeId) {
  if (theme === "popcorn") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // На телефоне интерфейс прозрачный (под ним видео), фон «зала» рисует само окно.
  if (IS_ANDROID) {
    const color = THEMES.find((t) => t.id === theme)?.swatch[0] ?? "#0f0d10";
    invoke("mobile_background", { color }).catch(() => {});
  }
}

/** Поставить сохранённую тему и слушать смену из главного окна. */
export function initTheme() {
  apply(savedTheme());
  // Панель плеера поверх видео — отдельное окно; тема приходит событием.
  listen<ThemeId>("theme", (e) => apply(e.payload)).catch(() => {});
}

export function setTheme(theme: ThemeId) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Не запомнится — не страшно.
  }
  apply(theme);
  emit("theme", theme).catch(() => {});
}
