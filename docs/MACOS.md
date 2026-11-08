# Сборка для macOS

Одна сборка для Apple Silicon и Intel (`universal-apple-darwin`), macOS 11 и
новее. Собирается только на Mac: Rust под macOS с Windows не собрать.
Приложение не подписано сертификатом Apple (нужен платный аккаунт
разработчика) — оно подписано «без разработчика» (ad-hoc), поэтому при первом
запуске macOS спрашивает, открывать ли его (см. README).

## Чем macOS отличается от Windows

- **Видео.** На Windows mpv рисует в дочернее окно приложения (`--wid`). На
  macOS так нельзя: `--wid` там работает только для libmpv внутри самого
  приложения. Поэтому mpv открывает своё окно без рамки и без значка в Dock,
  а приложение держит его ровно над областью видео (`video.rs`, модуль `mac`):
  - место — свойство mpv `geometry` (меняется на ходу с mpv 0.38) в пикселях
    экрана с главным окном (`macos-geometry-calculation=whole`);
  - пока приложение активно — окно mpv «поверх» на уровень выше главного
    окна (`ontop-level`), панель и реакции — ещё выше; ушли в другую
    программу — `ontop` снимается;
  - спрятать видео — выключить видеодорожку (`vid=no`): с `--force-window=no`
    окно mpv закрывается, звук идёт дальше;
  - углы у видео прямые (на Windows скруглены).
- **Полный экран** — «простой» (`set_simple_fullscreen`), без отдельного
  рабочего стола: на отдельный Space окно mpv (другая программа) не попадёт.
- **Плеер** скачивается при первом запуске, как на Windows: mpv.app из
  официальных сборок mpv (архивы в нашем релизе `player-mac-…`, адреса и
  SHA-256 — раздел `macos` в `player-pack.json`), yt-dlp — `yt-dlp_macos`.
  Папка — `~/Library/Application Support/com.ferrumnyak.brotherwatch/`.
  Если mpv или yt-dlp уже стоят (`/Applications/mpv.app`, Homebrew), берутся они.
- **«Нажми и говори» и клавиша микрофона** — перехват `CGEventTap` (`ptt.rs`).
  Нужно разрешение «Мониторинг ввода»: macOS спросит при первом назначении
  клавиши. После каждого обновления приложения разрешение, возможно,
  придётся выдать заново (подпись ad-hoc меняется). Коды клавиш переводятся
  в коды Windows — настройки и названия клавиш общие.
- **ByeDPI** — готовой сборки для macOS нет; `build.rs` собирает `ciadpi` из
  `app/src-tauri/byedpi` (clang, сразу arm64 + x86_64) в
  `app/src-tauri/byedpi-build/`, оттуда он попадает в
  `BrotherHub.app/Contents/Resources/ciadpi`. «Обзор» на macOS ходит без
  обхода (прокси у WebView на macOS — только с macOS 14 и отдельной функцией Tauri).
- **Сертификаты для mpv** — Mozilla + связки ключей macOS (системная и
  пользователя, утилитой `security`).
- Настройки только для macOS — `app/src-tauri/tauri.macos.conf.json`
  (Tauri подмешивает его сам) и `app/src-tauri/Info.plist` (текст запроса
  микрофона).

## Что нужно на Mac

- Инструменты Xcode: `xcode-select --install`.
- Rust: https://rustup.rs (цели для обеих архитектур скрипт добавит сам).
- Node.js: https://nodejs.org или `brew install node`.
- Для «Обновить» — тот же ключ подписи обновлений, что на Windows: скопировать
  `%USERPROFILE%\.tauri\brotherhub.key` в `~/.tauri/brotherhub.key`. Без него
  сборка получится, но кнопка «Обновить» на Mac работать не будет.

## Плеер (один раз на версию mpv)

```sh
scripts/pack-player-mac.sh            # mpv v0.41.0
```

Скрипт скачивает официальные сборки mpv для Apple Silicon и Intel, проверяет,
что они не тянут библиотеки Homebrew, перепаковывает в
`release/player/mpv-macos-<arch>-<дата>.zip` и вписывает их в
`player-pack.json`. Оба архива выложить пререлизом с тегом
`player-mac-<дата>` (скрипт подскажет) и закоммитить `player-pack.json`.
Релиз не удалять.

Windows-скрипт `pack-player.ps1` раздел `macos` в `player-pack.json` сохраняет.

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

## Что не проверено

Код для macOS написан без Mac под рукой — первые сборки могут потребовать
правок. Сомнительные места:

- размер и место окна mpv на Retina и на втором мониторе (пиксели или точки,
  номер экрана);
- переходы: мини-окно, полный экран, сворачивание, «Обзор»;
- показ экрана из WKWebView (`getDisplayMedia`);
- сборка `ciadpi` под macOS.

Журнал — «Открыть папку с логами» (`~/Library/Application Support/com.ferrumnyak.brotherwatch/logs`),
там же журнал mpv.
