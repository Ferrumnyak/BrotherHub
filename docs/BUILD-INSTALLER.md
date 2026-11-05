# Установщик и релиз для друзей

Установщик — один `.exe`, внутри которого уже есть плеер mpv и yt-dlp.
Друзьям ничего не нужно ставить отдельно.

Команды выполнять в PowerShell из корня репозитория.

## Релиз для друзей

### 1. Адрес сервера

Репозиторий публичный, поэтому адрес сервера хранится в `release.env`,
который в git не попадает. Первый запуск скрипта создаст его из
`release.env.example`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1
```

Открой `release.env` и впиши адрес сервера, например:

```
SERVER=wss://watch.example.ru
```

### 2. Сборка

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1
```

Скрипт сам скачает mpv и yt-dlp (если их ещё нет), соберёт установщик с
вшитым адресом сервера и положит его в папку `release\`:
`release\BrotherWatch-<версия>-setup.exe`. Папка в git не попадает — оттуда
файл удобно переслать в Telegram или Discord.

### 3. GitHub Releases

1. Если версия новая — подними её в `app/src-tauri/tauri.conf.json`,
   `app/package.json` и `Cargo.toml` (`[workspace.package]`), закоммить и
   собери заново.
2. Поставь метку версии и отправь её на GitHub:

   ```powershell
   git tag v0.1.0
   git push origin main --tags
   ```

3. На GitHub: страница репозитория → **Releases** → **Draft a new release**.
4. **Choose a tag** → `v0.1.0`. Название — например, «BrotherWatch 0.1.0».
5. Перетащи `release\BrotherWatch-0.1.0-setup.exe` в поле
   **Attach binaries**.
6. Нажми **Publish release**.

Друзьям достаточно ссылки
`https://github.com/Ferrumnyak/Brotherwatch/releases/latest` — она всегда
ведёт на последнюю версию. Там же README объясняет, как установить
и что делать с предупреждением Windows SmartScreen.

## Без установщика (portable)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\portable.ps1
```

Собирает папку `release\BrotherWatch\` (BrotherWatch.exe, mpv, yt-dlp) и
архив `release\BrotherWatch-<версия>-portable.zip`. Распаковал — запустил
`BrotherWatch.exe`, ничего не устанавливая. Нужна Windows 10/11.

## Что делает установщик

- Ставит BrotherWatch для текущего пользователя (права администратора не
  нужны) в `%LOCALAPPDATA%\BrotherWatch`.
- Рядом с приложением кладёт `mpv\` и `yt-dlp\` — приложение находит их само.
- Создаёт ярлык в меню «Пуск».
- Если на компьютере нет WebView2 (бывает на старых Windows 10), докачивает его.

При каждом запуске приложение тихо обновляет встроенный yt-dlp, чтобы
ссылки на YouTube и другие сайты не ломались из-за изменений на сайтах.

## Сборка вручную

Без скрипта, например для проверки у себя:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-player.ps1
cd app
$env:VITE_DEFAULT_SERVER = "wss://адрес-сервера"   # необязательно
npm run bundle
```

Готовый установщик: `target\release\bundle\nsis\BrotherWatch_<версия>_x64-setup.exe`.

Для скачивания mpv нужен 7-Zip или встроенный в Windows `tar`. Если скрипт
попросит 7-Zip: `winget install 7zip.7zip`.

## Обычная разработка

`npm run tauri dev` и `npm run tauri build` mpv из установщика не требуют:
в разработке используется mpv, установленный через Scoop.
