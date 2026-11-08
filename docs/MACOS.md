# Сборка для macOS

Одна сборка для Apple Silicon и Intel (`universal-apple-darwin`), macOS 11 и
новее; mpv — из Homebrew (см. ниже). Собирается только на Mac: Rust под macOS с Windows не собрать.
Приложение не подписано сертификатом Apple (нужен платный аккаунт
разработчика) — оно подписано «без разработчика» (ad-hoc), поэтому при первом
запуске macOS спрашивает, открывать ли его (см. README).

## Чем macOS отличается от Windows

- **Видео.** На Windows mpv — отдельная программа, которая рисует в
  дочернее окно приложения (`--wid`). На macOS окно другой программы встроить
  нельзя, а `--wid` у видео mpv для macOS (Vulkan, «macvk») не работает.
  Поэтому:
  - mpv работает как библиотека **libmpv внутри приложения** (`libmpv.rs`,
    `dlopen`). Управление то же — JSON IPC через `input-ipc-server`
    (`player.rs`), синхронизация общая;
  - окно mpv (без рамки, свойство `window-id`) становится **дочерним окном
    главного** (`addChildWindow`, `video.rs`, модуль `mac`): macOS двигает его
    вместе с главным без задержки, переносит на другой рабочий стол и в
    полный экран. Место — из `set_video_rect`, как на Windows; углы
    скруглены слоем;
  - спрятать видео — прозрачностью окна (`alphaValue = 0`): видео не
    останавливается и не перезагружается;
  - панель и реакции заново подвешиваются над окнами mpv; меню, которое
    ставит mpv, заменяется меню приложения;
  - ролик СДВГ-режима — второй экземпляр libmpv, ролики добавляются
    командами `loadfile`.
- **libmpv пока из Homebrew** (`brew install mpv`): ищется в
  `/opt/homebrew/lib` и `/usr/local/lib` (или `BROTHERHUB_LIBMPV`).
  Приложение её не скачивает — без неё экран «Готовлю плеер» просит
  поставить mpv. Упаковать libmpv в приложение — следующий шаг.
  yt-dlp — из Homebrew или скачивается сам (`yt-dlp_macos`).
- **Полный экран** — «простой» (`set_simple_fullscreen`), без отдельного
  рабочего стола.
- **«Нажми и говори» и клавиша микрофона** — перехват `CGEventTap` (`ptt.rs`).
  Нужно разрешение «Мониторинг ввода»: macOS спросит при первом назначении
  клавиши. После обновления приложения разрешение, возможно, придётся выдать
  заново (подпись ad-hoc меняется). Коды клавиш переводятся в коды Windows —
  настройки и названия клавиш общие.
- **ByeDPI** — готовой сборки для macOS нет; `build.rs` собирает `ciadpi` из
  `app/src-tauri/byedpi` (clang, сразу arm64 + x86_64) в
  `app/src-tauri/byedpi-build/`, оттуда он попадает в
  `BrotherHub.app/Contents/Resources/ciadpi`. «Обзор» на macOS ходит без
  обхода (прокси у WebView на macOS — только с macOS 14 и отдельной функцией Tauri).
- **Сертификаты для mpv** — Mozilla + связки ключей macOS (системная и
  пользователя, утилитой `security`).
- Папка данных и логи — `~/Library/Application Support/com.ferrumnyak.brotherwatch/`.
- Настройки только для macOS — `app/src-tauri/tauri.macos.conf.json`
  (Tauri подмешивает его сам) и `app/src-tauri/Info.plist` (текст запроса
  микрофона).

## Что нужно на Mac

- Инструменты Xcode: `xcode-select --install`.
- Rust: https://rustup.rs (цели для обеих архитектур скрипт добавит сам).
- Node.js: https://nodejs.org или `brew install node`.
- mpv (libmpv) и yt-dlp: `brew install mpv yt-dlp`.
- Для «Обновить» — тот же ключ подписи обновлений, что на Windows: скопировать
  `%USERPROFILE%\.tauri\brotherhub.key` в `~/.tauri/brotherhub.key`. Без него
  сборка получится, но кнопка «Обновить» на Mac работать не будет.

## Сборка

```sh
scripts/release-mac.sh
```

Адрес сервера — из того же `release.env` (`SERVER=…`). В `release/macos/`:

- `BrotherHub-<версия>-macos.dmg` — для друзей;
- `BrotherHub-<версия>-macos.app.tar.gz` и `.sig` — обновление по кнопке;
- `latest-macos.json` — часть `latest.json` для macOS.

## Релиз вместе с Windows и Android

Версия одна (`tauri.conf.json`). Порядок:

1. На Mac — `scripts/release-mac.sh`.
2. Папку `release/macos` перенести на компьютер с Windows в `release\macos`.
3. На Windows — `scripts\release.ps1`: он добавит `darwin-aarch64` и
   `darwin-x86_64` в `latest.json` (если версия совпадает) и перечислит файлы
   macOS среди тех, что нужно выложить.
4. В релиз `v<версия>` выложить и файлы из `release\macos` (кроме
   `latest-macos.json`).

Если сборки для macOS в релизе нет, приложение на Mac просто не увидит
обновления.

## Разработка

```sh
cd app
npm install
npm run tauri dev
```

Проверка без Mac невозможна: всё, что под `cfg(target_os = "macos")`,
компилируется только там.

## Что проверено (2026-11-09, MacBook Pro M4 Pro, macOS 26.2)

`tauri dev` с libmpv из Homebrew (mpv 0.41): видео в области плеера,
двигается с окном, полный экран, мини-окно, СДВГ-ролик.

Не проверено: собранный `release-mac.sh` .dmg на другом Mac, Intel,
«нажми и говори», показ экрана (`getDisplayMedia` в WKWebView), ByeDPI.

Журнал — «Открыть папку с логами»
(`~/Library/Application Support/com.ferrumnyak.brotherwatch/logs`), там же
журнал mpv.
