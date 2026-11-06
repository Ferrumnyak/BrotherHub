// Встроенный браузер «Обзора»: прячем рекламу. Работает только со страницей
// (без блокировки сети), поэтому ловит не всё, но основное на YouTube убирает.
(() => {
  if (window.__bhAdblock) return;
  window.__bhAdblock = true;

  const host = location.hostname;
  const on = (domain) => host === domain || host.endsWith("." + domain);

  const hide = [
    // YouTube: реклама в ленте, над плеером и рядом с ним
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-display-ad-renderer",
    "ytd-companion-slot-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-player-legacy-desktop-watch-ads-renderer",
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-ads']",
    "ytd-rich-item-renderer:has(ytd-ad-slot-renderer)",
    "ytd-rich-section-renderer:has(ytd-statement-banner-renderer)",
    "#masthead-ad",
    "#player-ads",
    ".ytp-ad-overlay-container",
    ".ytp-ad-image-overlay",
    "tp-yt-paper-dialog:has(#mealbar-promo-renderer)",
    // Общие рекламные блоки
    "iframe[src*='doubleclick.net']",
    "iframe[src*='googlesyndication.com']",
    "iframe[src*='an.yandex.ru']",
    "iframe[src*='yandex.ru/ads']",
    "[id^='yandex_rtb']",
    "[id^='adfox_']",
    "[class*='adfox']",
    "ins.adsbygoogle",
  ];

  const style = document.createElement("style");
  style.textContent = hide.join(",\n") + " { display: none !important; }";
  const addStyle = () => (document.head || document.documentElement).appendChild(style);
  if (document.documentElement) addStyle();
  else document.addEventListener("DOMContentLoaded", addStyle);

  if (on("yandex.ru")) {
    findYandexSource();
    return;
  }

  if (!on("youtube.com")) return;

  // Реклама в самом плеере YouTube: жмём «Пропустить», а непропускаемую
  // проматываем до конца без звука.
  setInterval(() => {
    const player = document.querySelector(".html5-video-player");
    if (!player) return;
    for (const b of document.querySelectorAll(
      ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^='skip-button']",
    )) {
      b.click();
    }
    if (player.classList.contains("ad-showing")) {
      const video = player.querySelector("video");
      if (video) {
        video.muted = true;
        if (isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
      }
    } else {
      const video = player.querySelector("video");
      if (video && video.dataset.bhMuted !== "user") {
        // После рекламы возвращаем звук, если его выключили мы.
        if (video.muted && video.dataset.bhAdMuted === "1") video.muted = false;
      }
    }
    const video = player.querySelector("video");
    if (video) video.dataset.bhAdMuted = player.classList.contains("ad-showing") ? "1" : "";
  }, 300);

  // Яндекс Видео показывает чужие видео (VK, YouTube, Rutube, ОК, Дзен…).
  // Ищем на странице плеер или ссылку на источник и кладём его адрес
  // в #bh-src=… — приложение видит адрес страницы и включит источник.
  function findYandexSource() {
    const known = /(^|\.)(youtube\.com|youtu\.be|vk\.com|vkvideo\.ru|rutube\.ru|ok\.ru|dzen\.ru|smotrim\.ru)$/;

    // Адрес встроенного плеера — в адрес страницы с видео.
    const fromEmbed = (raw) => {
      let u;
      try {
        u = new URL(raw, location.href);
      } catch {
        return null;
      }
      const h = u.hostname.replace(/^www\.|^m\./, "");
      if (!known.test(h)) return null;
      let m;
      if ((m = u.pathname.match(/^\/embed\/([\w-]{6,})/)) && /youtube/.test(h))
        return "https://www.youtube.com/watch?v=" + m[1];
      if (/video_ext\.php/.test(u.pathname)) {
        const oid = u.searchParams.get("oid");
        const id = u.searchParams.get("id");
        return oid && id ? `https://vkvideo.ru/video${oid}_${id}` : null;
      }
      if ((m = u.pathname.match(/^\/play\/embed\/([0-9a-f]{32})/i)))
        return `https://rutube.ru/video/${m[1]}/`;
      if ((m = u.pathname.match(/^\/videoembed\/(\d+)/))) return `https://ok.ru/video/${m[1]}`;
      return u.href;
    };

    let last = "";
    const look = () => {
      if (!/^\/video\//.test(location.pathname)) return;
      let found = null;
      for (const f of document.querySelectorAll("iframe[src]")) {
        found = fromEmbed(f.getAttribute("src"));
        if (found) break;
      }
      if (!found) {
        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.getAttribute("href");
          if (!href || !/^https?:/.test(href)) continue;
          const candidate = fromEmbed(href);
          if (candidate && /video|watch|clip|shorts/.test(candidate)) {
            found = candidate;
            break;
          }
        }
      }
      const hash = found ? "#bh-src=" + encodeURIComponent(found) : "";
      if (hash !== last) {
        last = hash;
        history.replaceState(history.state, "", location.pathname + location.search + hash);
      }
    };
    setInterval(look, 800);
  }
})();
