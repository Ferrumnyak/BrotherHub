import { ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoginArt } from "./App";

/** Что из плеера уже есть на компьютере (команда `player_tools`). */
type ToolsStatus = { mpv: boolean; ytdlp: boolean };

/** Ход установки (событие `player-setup` из tools.rs). */
type Progress = { stage: "mpv" | "yt-dlp" | "unpack"; done: number; total: number | null };

type State = "checking" | "ready" | "installing" | "failed";

const STAGE_NAMES: Record<Progress["stage"], string> = {
  mpv: "Скачиваю плеер mpv",
  "yt-dlp": "Скачиваю yt-dlp для видео по ссылкам",
  unpack: "Распаковываю плеер",
};

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

/**
 * Пока на компьютере нет mpv и yt-dlp (их нет в установщике, чтобы он был
 * маленьким), показывает экран «Готовлю плеер» и скачивает их. Потом —
 * обычный интерфейс.
 */
export default function PlayerSetup({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>("checking");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function install() {
    setState("installing");
    setError(null);
    setProgress(null);
    const unlisten = await listen<Progress>("player-setup", (e) => setProgress(e.payload));
    try {
      await invoke("player_setup");
      setState("ready");
    } catch (e) {
      setError(String(e));
      setState("failed");
    } finally {
      unlisten();
    }
  }

  useEffect(() => {
    // В режиме разработки React вызывает эффект дважды — проверяем один раз.
    if (started.current) return;
    started.current = true;
    invoke<ToolsStatus>("player_tools")
      .then((s) => (s.mpv && s.ytdlp ? setState("ready") : install()))
      .catch(() => install());
  }, []);

  if (state === "ready") return <>{children}</>;
  if (state === "checking") return null;

  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <main className="login">
      <LoginArt />
      <div className="login-side">
        <div className="login-form setup">
          <h1>Готовлю плеер</h1>
          <p className="muted">
            Первый запуск: скачиваю плеер mpv и yt-dlp, около 60 МБ. Это нужно один раз — дальше
            BrotherWatch будет открываться сразу.
          </p>

          {state === "installing" && (
            <div className="setup-progress">
              <div className="setup-stage">
                <span>{progress ? STAGE_NAMES[progress.stage] : "Подключаюсь…"}</span>
                {progress && progress.stage !== "unpack" && progress.done > 0 && (
                  <span className="muted">
                    {megabytes(progress.done)}
                    {progress.total ? ` из ${megabytes(progress.total)}` : ""} МБ
                  </span>
                )}
              </div>
              <div
                className={`setup-bar${percent === null ? " indeterminate" : ""}`}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
              >
                <span style={percent === null ? undefined : { width: `${percent}%` }} />
              </div>
            </div>
          )}

          {state === "failed" && (
            <>
              <p className="error">{error}</p>
              <button type="button" className="primary" onClick={install}>
                Повторить
              </button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
