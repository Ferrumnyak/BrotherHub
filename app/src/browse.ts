// Площадки для встроенного браузера и разбор адресов страниц с видео.

export type SiteId = "youtube" | "vk" | "rutube" | "smotrim" | "dzen" | "ok" | "yandex" | "utv";

export interface Site {
  id: SiteId;
  title: string;
  hint: string;
  home: string;
  /** Буква на плитке и цвет плитки. */
  mark: string;
  color: string;
}

export const SITES: Site[] = [
  { id: "youtube", title: "YouTube", hint: "Ролики, клипы, трансляции", home: "https://www.youtube.com/", mark: "Y", color: "#e5484d" },
  { id: "vk", title: "VK Видео", hint: "Сериалы, шоу и фильмы", home: "https://vkvideo.ru/", mark: "VK", color: "#3b82f6" },
  { id: "rutube", title: "Rutube", hint: "Шоу, ТВ и блогеры", home: "https://rutube.ru/", mark: "R", color: "#14b8a6" },
  { id: "smotrim", title: "Смотрим", hint: "Сериалы и фильмы «России»", home: "https://smotrim.ru/", mark: "С", color: "#8b5cf6" },
  { id: "dzen", title: "Дзен", hint: "Видео авторов и каналов", home: "https://dzen.ru/video", mark: "Д", color: "#64748b" },
  { id: "ok", title: "ОК Видео", hint: "Фильмы и шоу на ok.ru", home: "https://ok.ru/video", mark: "ОК", color: "#f59e0b" },
  { id: "yandex", title: "Яндекс Видео", hint: "Поиск видео по всем сайтам", home: "https://yandex.ru/video/", mark: "Я", color: "#ef4444" },
  { id: "utv", title: "Телеканал «Ю»", hint: "Шоу канала «Ю»", home: "https://u-tv.ru/", mark: "Ю", color: "#d946ef" },
];

function hostIs(host: string, domain: string) {
  return host === domain || host.endsWith("." + domain);
}

/** Какая площадка открыта по этому адресу. */
export function siteOf(address: string | null): SiteId | null {
  if (!address) return null;
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostIs(host, "youtube.com") || host === "youtu.be") return "youtube";
  if (hostIs(host, "vkvideo.ru") || hostIs(host, "vk.com")) return "vk";
  if (hostIs(host, "rutube.ru")) return "rutube";
  if (hostIs(host, "smotrim.ru")) return "smotrim";
  if (hostIs(host, "dzen.ru")) return "dzen";
  if (hostIs(host, "ok.ru")) return "ok";
  if (hostIs(host, "yandex.ru")) return "yandex";
  if (hostIs(host, "u-tv.ru")) return "utv";
  return null;
}

/**
 * Ссылка на видео, если открыта страница с видео; иначе `null`.
 * Ссылку чистим от лишнего (плейлисты, метки), чтобы у всех открылось одно и то же.
 */
export function videoLink(address: string | null): string | null {
  if (!address) return null;
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // Яндекс Видео само ничего не хранит, а показывает видео с других сайтов.
  // Наша страничная «надстройка» (adblock.js) находит, откуда оно, и кладёт
  // адрес источника в #bh-src=… — его и проверяем как обычную ссылку.
  if (hostIs(host, "yandex.ru")) {
    const src = new URLSearchParams(u.hash.slice(1)).get("bh-src");
    return src && siteOf(src) !== "yandex" ? videoLink(src) : null;
  }

  if (hostIs(host, "youtube.com")) {
    const v = u.searchParams.get("v");
    if (path === "/watch" && v) return `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`;
    const m = path.match(/^\/(shorts|live)\/([\w-]{6,})/);
    if (m) return `https://www.youtube.com/watch?v=${m[2]}`;
    return null;
  }
  if (host === "youtu.be") {
    const id = path.slice(1);
    return /^[\w-]{6,}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  }
  if (hostIs(host, "vkvideo.ru") || hostIs(host, "vk.com")) {
    // Видео открыто поверх списка: ?z=video-123_456
    const z = u.searchParams.get("z")?.match(/(video|clip)(-?\d+_\d+)/);
    if (z) return `https://vkvideo.ru/${z[1]}${z[2]}`;
    const m = path.match(/\/(video|clip)(-?\d+_\d+)/);
    if (m) return `https://vkvideo.ru/${m[1]}${m[2]}`;
    return null;
  }
  if (hostIs(host, "rutube.ru")) {
    const m = path.match(/^\/(video|shorts)\/([0-9a-f]{32})/i);
    return m ? `https://rutube.ru/${m[1]}/${m[2]}/` : null;
  }
  if (hostIs(host, "smotrim.ru")) {
    const m = path.match(/^\/video\/(\d+)/);
    return m ? `https://smotrim.ru/video/${m[1]}` : null;
  }
  if (hostIs(host, "dzen.ru")) {
    const m = path.match(/^\/(video\/watch|shorts)\/([\w-]+)/);
    return m ? `https://dzen.ru/${m[1]}/${m[2]}` : null;
  }
  if (hostIs(host, "ok.ru")) {
    const m = path.match(/^\/(video|live)\/(\d+)/);
    return m ? `https://ok.ru/${m[1]}/${m[2]}` : null;
  }
  if (hostIs(host, "u-tv.ru")) {
    // У «Ю» видео — на страницах серий и выпусков; главная и разделы не годятся.
    const parts = path.split("/").filter(Boolean);
    return parts.length >= 2 ? `https://u-tv.ru${path}` : null;
  }
  return null;
}
