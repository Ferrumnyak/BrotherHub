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
})();
