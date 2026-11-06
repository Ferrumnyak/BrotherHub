import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Своя полоса заголовка вместо стандартной виндовой: логотип, название
 *  и кнопки «свернуть / развернуть / закрыть» в цветах темы.
 *  Тянуть окно можно за любое пустое место полосы, двойной щелчок —
 *  развернуть. В полном экране полоса прячется (см. html.is-fullscreen). */
export function TitleBar() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = () =>
      win
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => {});
    check();
    const off = win.onResized(check);
    return () => {
      alive = false;
      off.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-label">
        <img src="/logo.svg" alt="" />
        <span>BrotherHub</span>
      </div>
      <div className="titlebar-buttons">
        <button
          className="titlebar-btn"
          onClick={() => win.minimize().catch(() => {})}
          aria-label="Свернуть"
          title="Свернуть"
          tabIndex={-1}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 6.5h8" />
          </svg>
        </button>
        <button
          className="titlebar-btn"
          onClick={() => win.toggleMaximize().catch(() => {})}
          aria-label={maximized ? "Вернуть размер" : "Развернуть"}
          title={maximized ? "Вернуть размер" : "Развернуть"}
          tabIndex={-1}
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3.5 3.5V2h6.5v6.5H8.5" />
              <rect x="2" y="3.5" width="6.5" height="6.5" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1.2" />
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn close"
          onClick={() => win.close().catch(() => {})}
          aria-label="Закрыть"
          title="Закрыть"
          tabIndex={-1}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
    </header>
  );
}
