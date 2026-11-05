# Сборка установщика для друзей

Установщик — один `.exe`, внутри которого уже есть плеер mpv и yt-dlp.
Друзьям ничего не нужно ставить отдельно.

Команды выполнять в PowerShell из корня репозитория.

## 1. Скачать mpv и yt-dlp (один раз и для обновления)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-player.ps1
```

Скрипт скачает последние версии в `app\src-tauri\bin\` (в git эта папка
не попадает). Для распаковки mpv нужен 7-Zip или встроенный в Windows `tar`.
Если скрипт попросит 7-Zip:

```powershell
winget install 7zip.7zip
```

## 2. Собрать установщик

```powershell
cd app
npm run bundle
```

Чтобы у друзей сразу был вписан адрес сервера:

```powershell
cd app
$env:VITE_DEFAULT_SERVER = "wss://адрес-сервера"
npm run bundle
```

Готовый установщик:
`target\release\bundle\nsis\BrotherWatch_<версия>_x64-setup.exe`

## Что делает установщик

- Ставит BrotherWatch для текущего пользователя (права администратора не нужны)
  в `%LOCALAPPDATA%\BrotherWatch`.
- Рядом с приложением кладёт `mpv\` и `yt-dlp\` — приложение находит их само.
- Создаёт ярлык в меню «Пуск».
- Если на компьютере нет WebView2 (бывает на старых Windows 10), докачивает его.

При каждом запуске приложение тихо обновляет встроенный yt-dlp, чтобы
ссылки на YouTube и другие сайты не ломались из-за изменений на сайтах.

## Обычная разработка

`npm run tauri dev` и `npm run tauri build` работают как раньше и mpv не
требуют: в разработке используется mpv, установленный через Scoop.
