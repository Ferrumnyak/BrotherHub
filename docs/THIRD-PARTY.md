# Сторонние программы в BrotherWatch

BrotherWatch использует программы других авторов. Их нет в установщике:
приложение скачивает их при первом запуске (mpv — архив из релизов BrotherWatch
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

## Библиотеки

Приложение собрано на Tauri, React и livekit-client; полный список зависимостей
с лицензиями — в `Cargo.lock` и `app/package-lock.json`.
