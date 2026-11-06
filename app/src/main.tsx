import React from "react";
import ReactDOM from "react-dom/client";
import App, { ControlsOverlay } from "./App";
import PlayerSetup from "./PlayerSetup";
import { ReactionsLayer } from "./Reactions";
// Шрифты лежат внутри приложения — работают и без интернета.
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/unbounded/500.css";
import "@fontsource/unbounded/700.css";
import "./styles.css";
import { initTheme } from "./theme";

initTheme();

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
      <PlayerSetup>
        <App />
      </PlayerSetup>
    )}
  </React.StrictMode>,
);
