// Обновление приложения по кнопке (см. src-tauri/src/update.rs).

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

export interface UpdateState {
  /** Есть версия новее. */
  available: UpdateInfo | null;
  /** Идёт проверка по кнопке. */
  checking: boolean;
  /** Проверили по кнопке, и новее нет. */
  upToDate: boolean;
  /** Идёт установка: сколько скачано (0..1, null — неизвестно). */
  installing: number | null | undefined;
  error: string | null;
}

let state: UpdateState = {
  available: null,
  checking: false,
  upToDate: false,
  installing: undefined,
  error: null,
};
const subscribers = new Set<(s: UpdateState) => void>();
let checkedOnStart = false;

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  for (const fn of subscribers) fn(state);
}

/** Проверить, нет ли новой версии. `manual` — по кнопке (показываем итог). */
export async function checkForUpdate(manual = false) {
  if (manual) set({ checking: true, upToDate: false, error: null });
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    set({ available: info, checking: false, upToDate: manual && !info });
  } catch (err) {
    // Тихая проверка при запуске не должна пугать ошибками (нет сети и т.п.).
    set({ checking: false, error: manual ? String(err) : null });
  }
}

/** Что сделать перед установкой (запомнить комнату, чтобы вернуться в неё). */
let beforeUpdate: (() => Promise<void>) | null = null;
export function setBeforeUpdate(fn: (() => Promise<void>) | null) {
  beforeUpdate = fn;
}

export async function installUpdate() {
  set({ installing: null, error: null });
  try {
    await beforeUpdate?.().catch(() => {});
    await invoke("update_install");
  } catch (err) {
    set({ installing: undefined, error: String(err) });
  }
}

/** Состояние обновления; первая подписка запускает тихую проверку. */
export function useUpdate(): UpdateState {
  const [s, setS] = useState(state);
  useEffect(() => {
    subscribers.add(setS);
    if (!checkedOnStart) {
      checkedOnStart = true;
      setTimeout(() => checkForUpdate(false), 3000);
    }
    return () => {
      subscribers.delete(setS);
    };
  }, []);
  return s;
}

listen<{ downloaded: number; total: number | null }>("update-progress", (e) => {
  const { downloaded, total } = e.payload;
  set({ installing: total ? Math.min(1, downloaded / total) : null });
}).catch(() => {});

/** Версия приложения для настроек. */
export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  return version;
}
