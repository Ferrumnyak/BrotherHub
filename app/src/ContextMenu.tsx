// Своё меню по правой кнопке вместо меню браузера («Назад», «Обновить»,
// «Печать»…): приложение не должно выглядеть как веб-страница.
// В полях ввода остаётся обычное меню Windows — вырезать, копировать, вставить.

import { useEffect, useState } from "react";

interface Item {
  label: string;
  run: () => void;
}

interface Menu {
  x: number;
  y: number;
  items: Item[];
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

function isEditable(el: Element | null) {
  return !!el?.closest("input, textarea, [contenteditable='true']");
}

/** Что можно сделать там, где нажали правую кнопку. */
function itemsFor(target: Element): Item[] {
  const items: Item[] = [];
  const selected = window.getSelection()?.toString() ?? "";
  if (selected.trim()) items.push({ label: "Копировать", run: () => copy(selected) });

  const link = target.closest("a[href]") as HTMLAnchorElement | null;
  if (link && /^https?:/i.test(link.href)) {
    items.push({ label: "Копировать ссылку", run: () => copy(link.href) });
  }

  const message = target.closest(".message") as HTMLElement | null;
  const key = Number(message?.dataset.key);
  if (message && Number.isFinite(key)) {
    items.unshift({
      label: "Ответить",
      run: () => window.dispatchEvent(new CustomEvent("bh-reply", { detail: key })),
    });
  }
  const text = message?.querySelector(".rich")?.textContent ?? "";
  if (message && text.trim() && !selected.trim()) {
    items.push({ label: "Копировать сообщение", run: () => copy(text) });
  }
  return items;
}

/** Убрать меню браузера во всех окнах приложения (без своего меню). */
export function blockBrowserMenu() {
  window.addEventListener("contextmenu", (e) => {
    if (!isEditable(e.target as Element)) e.preventDefault();
  });
  // Перезагрузка, печать и «исходный код» страницы — тоже от браузера.
  if (import.meta.env.PROD) {
    window.addEventListener(
      "keydown",
      (e) => {
        const key = e.key.toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;
        if (
          e.key === "F5" ||
          e.key === "F7" ||
          (ctrl && ["r", "p", "u", "j", "g", "f"].includes(key)) ||
          (ctrl && e.shiftKey && ["i", "c"].includes(key)) ||
          (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
        ) {
          e.preventDefault();
        }
      },
      true,
    );
  }
}

/** Своё меню по правой кнопке — для главного окна. */
export function AppContextMenu() {
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    const open = (e: MouseEvent) => {
      const target = e.target as Element;
      if (isEditable(target)) return;
      const items = itemsFor(target);
      setMenu(items.length ? { x: e.clientX, y: e.clientY, items } : null);
    };
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("contextmenu", open);
    const outside = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".context-menu")) close();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", esc);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("contextmenu", open);
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", esc);
      document.removeEventListener("scroll", close, true);
    };
  }, []);

  if (!menu) return null;
  // Не вылезать за край окна.
  const left = Math.min(menu.x, window.innerWidth - 200);
  const top = Math.min(menu.y, window.innerHeight - menu.items.length * 36 - 16);
  return (
    <div className="context-menu" role="menu" style={{ left, top }}>
      {menu.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onClick={() => {
            item.run();
            setMenu(null);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
