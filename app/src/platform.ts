// На чём запущено приложение. На Android — свой плеер (ExoPlayer под
// прозрачным интерфейсом), нет окон поверх видео, трея и глобальных клавиш.

export const IS_ANDROID = /Android/i.test(navigator.userAgent);

// macOS: видео mpv — в отдельном окне над областью видео, полный экран —
// «простой», без отдельного рабочего стола (video.rs).
export const IS_MAC = !IS_ANDROID && /Macintosh|Mac OS X/i.test(navigator.userAgent);
