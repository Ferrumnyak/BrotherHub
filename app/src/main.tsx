import React from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactDOM from "react-dom/client";
import App, { ControlsOverlay } from "./App";
import PlayerSetup from "./PlayerSetup";
import { ReactionsLayer } from "./Reactions";
import { AppContextMenu, blockBrowserMenu } from "./ContextMenu";
import { TitleBar } from "./TitleBar";
import { IS_ANDROID } from "./platform";
import { initTv } from "./tv";
// Шрифты лежат внутри приложения — работают и без интернета.
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/unbounded/500.css";
import "@fontsource/unbounded/700.css";
import "./styles.css";
import { initTheme } from "./theme";

if (IS_ANDROID) {
  document.documentElement.classList.add("android");
  initTv();
  // Отступы под вырез камеры и полоску жестов — от Android, на каждый
  // поворот экрана и полный экран заново.
  const insets = () =>
    invoke<{ top: number; bottom: number; left: number; right: number }>("mobile_insets")
      .then((i) => {
        const root = document.documentElement.style;
        for (const side of ["top", "bottom", "left", "right"] as const) {
          root.setProperty(`--inset-${side}`, `${i[side]}px`);
        }
      })
      .catch(() => {});
  insets();
  window.addEventListener("resize", () => setTimeout(insets, 150));
}
initTheme();
blockBrowserMenu();

// Медиаклавиши и автопауза наушников не должны трогать голосовой чат
// (звук друзей играет через <audio> в окне приложения).
try {
  for (const action of ["play", "pause", "stop", "seekbackward", "seekforward", "previoustrack", "nexttrack"] as const) {
    navigator.mediaSession?.setActionHandler(action, () => {});
  }
} catch {
  // Не поддерживается — не страшно.
}

// Окно панели плеера поверх видео (полный экран) открывается тем же
// интерфейсом с пометкой __BW_VIEW = "controls".
declare global {
  interface Window {
    __BW_VIEW?: string;
  }
}
// Окно реакций поверх видео — с пометкой __BW_VIEW = "reactions".
const view = window.__BW_VIEW;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "controls" ? (
      <ControlsOverlay />
    ) : view === "reactions" ? (
      <ReactionsLayer />
    ) : (
      <div className="app-shell">
        {!IS_ANDROID && <TitleBar />}
        <div className="app-body">
          <PlayerSetup>
            <App />
          </PlayerSetup>
        </div>
        <AppContextMenu />
      </div>
    )}
  </React.StrictMode>,
);
