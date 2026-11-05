import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Шрифты лежат внутри приложения — работают и без интернета.
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/unbounded/500.css";
import "@fontsource/unbounded/700.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
