// На чём запущено приложение. На Android — свой плеер (ExoPlayer под
// прозрачным интерфейсом), нет окон поверх видео, трея и глобальных клавиш.

export const IS_ANDROID = /Android/i.test(navigator.userAgent);
