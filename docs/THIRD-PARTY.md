# Сторонние программы в BrotherHub

BrotherHub использует программы других авторов. Их нет в установщике:
приложение скачивает их при первом запуске (mpv — архив из релизов BrotherHub
с неизменённой сборкой, yt-dlp — с его официальной страницы релизов). Они
распространяются без изменений, на условиях их собственных лицензий.

## mpv

Видеоплеер. Лицензия: GNU GPL v2 или новее (часть кода — LGPL v2.1 или новее).

- Сайт: https://mpv.io
- Исходный код: https://github.com/mpv-player/mpv
- Сборка для Windows: https://github.com/shinchiro/mpv-winbuild-cmake

## yt-dlp

Загрузка видео с сайтов (YouTube, VK Видео, Rutube и др.).
Лицензия: The Unlicense (общественное достояние).

- Исходный код: https://github.com/yt-dlp/yt-dlp

## ByeDPI

Ускорение YouTube — локальный прокси `ciadpi` для обхода замедления.
На компьютере скачивается с официальной страницы релизов, только если
нажать «Найти лучший обход»; в APK собран из исходников
(`app/src-tauri/byedpi`, без изменений). Лицензия: MIT, © hufrea.

- Исходный код: https://github.com/hufrea/byedpi

## Microsoft Fluent Emoji

Объёмные смайлики в чате (`app/public/emoji3d/`, 40 штук, уменьшены до 64×64).
Лицензия: MIT, © Microsoft Corporation.

- Источник: https://github.com/microsoft/fluentui-emoji

## Шумоподавление RNNoise

Сильное шумоподавление голоса — [RNNoise](https://github.com/xiph/rnnoise)
(Xiph.Org, лицензия BSD-3-Clause) в сборке
[@sapphi-red/web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor)
(лицензия MIT).

## Корневые сертификаты Mozilla

Список доверенных центров сертификации из проекта certifi
(`app/src-tauri/certs/mozilla-roots.pem`), лицензия MPL-2.0. Приложение
передаёт его mpv вместе с сертификатами из хранилища Windows.

- Источник: https://github.com/certifi/python-certifi

## Библиотеки

Приложение собрано на Tauri, React и livekit-client; полный список зависимостей
с лицензиями — в `Cargo.lock` и `app/package-lock.json`.
