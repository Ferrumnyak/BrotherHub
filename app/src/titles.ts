// Настоящие названия видео и треков по ссылке (см. src-tauri/src/titles.rs).
// Пока название не пришло, показываем коротко ссылку; как только пришло —
// всё, что подписано на useTitles(), перерисовывается.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "titles";
const MAX_SAVED = 300;

function loadSaved(): Map<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Map(Array.isArray(raw) ? raw.filter((e) => Array.isArray(e) && e.length === 2) : []);
  } catch {
    return new Map();
  }
}

const titles = loadSaved();
const asked = new Set<string>();
const subscribers = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function changed() {
  for (const fn of subscribers) fn();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const entries = [...titles.entries()].slice(-MAX_SAVED);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Хранилище недоступно — названия просто не переживут перезапуск.
    }
  }, 500);
}

/** Уже известное название ссылки. */
export function knownTitle(url: string): string | undefined {
  return titles.get(url);
}

/** Запомнить название (из плеера, со страницы сайта). */
export function rememberTitle(url: string, title: string | null | undefined) {
  const t = title?.trim();
  if (!t || titles.get(url) === t) return;
  titles.delete(url); // свежие — в конец, чтобы старые вытеснялись первыми
  titles.set(url, t);
  changed();
}

/** Узнать название в фоне (один раз на ссылку). */
export function requestTitle(url: string) {
  if (titles.has(url) || asked.has(url) || !/^https?:\/\//i.test(url.trim())) return;
  asked.add(url);
  invoke<string | null>("media_title", { url })
    .then((title) => rememberTitle(url, title))
    .catch(() => {});
}

/** Перерисовать компонент, когда стали известны новые названия. */
export function useTitles() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const fn = () => setVersion((v) => v + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);
}
