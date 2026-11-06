# Установщик и релиз для друзей

Установщик — один небольшой `.exe` (около 6 МБ). Плеера mpv и yt-dlp в нём
нет: при первом запуске приложение показывает экран «Готовлю плеер» и само
скачивает их (около 60 МБ) в `%LOCALAPPDATA%\com.ferrumnyak.brotherwatch\`.
Друзьям ничего не нужно ставить отдельно.

- **mpv** скачивается архивом из релизов этого репозитория. Адрес архива и его
  SHA-256 записаны в `app/src-tauri/player-pack.json`, так что версия mpv
  закреплена и меняется только когда ты сам её обновишь.
- **yt-dlp** скачивается с официальной страницы
  [релизов yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) с проверкой по
  `SHA2-256SUMS`. При каждом запуске приложение тихо его обновляет, чтобы
  ссылки на YouTube и другие сайты не ломались из-за изменений на сайтах.

Если mpv или yt-dlp уже стоят на компьютере (Scoop, PATH, папки `mpv\` и
`yt-dlp\` рядом с `BrotherHub.exe`), приложение берёт их и ничего не качает.

Команды выполнять в PowerShell из корня репозитория.

## Архив плеера (один раз, потом — только при обновлении mpv)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\pack-player.ps1
```

Скрипт:

1. скачает свежую сборку mpv
   ([shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake))
   в `app\src-tauri\bin\mpv\`, если её там ещё нет;
2. упакует плеер в `release\mpv-x86_64-<дата>.zip`;
3. впишет адрес и SHA-256 архива в `app/src-tauri/player-pack.json` —
   закоммить этот файл.

Затем выложи архив на GitHub (скрипт напечатает то же самое):

1. **Releases** → **Draft a new release**.
2. **Choose a tag** → новый тег `player-<дата>` (дата — как в имени архива).
   Название — например, «Плеер mpv <дата>».
3. Перетащи `release\mpv-x86_64-<дата>.zip` в **Attach binaries**.
4. Поставь **Set as a pre-release** и сними **Set as the latest release** —
   чтобы ссылка «последний релиз» по-прежнему вела на сам BrotherHub.
5. **Publish release**.

Этот релиз нельзя удалять, пока есть сборки BrotherHub, которые на него
ссылаются. Обновить mpv — снова запустить скрипт (предварительно удалив
`app\src-tauri\bin\mpv\`, чтобы скачалась новая сборка), выложить новый
архив под новым тегом и выпустить новую версию приложения.

Для скачивания mpv нужен 7-Zip или встроенный в Windows `tar`; 7-Zip ещё и
сжимает архив сильнее. Поставить: `winget install 7zip.7zip`.

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

Скрипт проверит, что в `player-pack.json` вписан архив плеера (и
предупредит, если он ещё не выложен на GitHub), соберёт установщик с вшитым
адресом сервера и положит его в папку `release\`:
`release\BrotherHub-<версия>-setup.exe`. Папка в git не попадает — оттуда
файл удобно переслать в Telegram или Discord.

### 3. GitHub Releases

1. Если версия новая — подними её в `app/src-tauri/tauri.conf.json`,
   `app/package.json` и `Cargo.toml` (`[workspace.package]`), закоммить и
   собери заново.
2. Поставь метку версии и отправь её на GitHub:

   ```powershell
   git tag v0.2.0
   git push origin main --tags
   ```

3. На GitHub: страница репозитория → **Releases** → **Draft a new release**.
4. **Choose a tag** → `v0.2.0`. Название — например, «BrotherHub 0.2.0».
5. Перетащи `release\BrotherHub-0.2.0-setup.exe` в поле
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

Собирает папку `release\BrotherHub\` (BrotherHub.exe и THIRD-PARTY.md) и
архив `release\BrotherHub-<версия>-portable.zip`. Распаковал — запустил
`BrotherHub.exe`, ничего не устанавливая; плеер скачается при первом
запуске, как и в установленной версии. Нужна Windows 10/11.

## Что делает установщик

- Ставит BrotherHub для текущего пользователя (права администратора не
  нужны) в `%LOCALAPPDATA%\BrotherHub`.
- Создаёт ярлык в меню «Пуск».
- Если на компьютере нет WebView2 (бывает на старых Windows 10), докачивает его.

Скачанный плеер лежит отдельно, в `%LOCALAPPDATA%\com.ferrumnyak.brotherwatch\`
(`mpv\` и `yt-dlp\`), поэтому переживает обновление приложения. При удалении
BrotherHub его убирает галочка «Удалить данные приложения».

## Сборка вручную

Без скрипта, например для проверки у себя:

```powershell
cd app
$env:VITE_DEFAULT_SERVER = "wss://адрес-сервера"   # необязательно
npm run bundle
```

Готовый установщик: `target\release\bundle\nsis\BrotherHub_<версия>_x64-setup.exe`.

## Обычная разработка

`npm run tauri dev` берёт mpv и yt-dlp, установленные через Scoop. Если их
нет — покажет экран «Готовлю плеер» и скачает, как у друзей.

Проверить экран первого запуска у себя: удали папку
`%LOCALAPPDATA%\com.ferrumnyak.brotherwatch\mpv` и, если mpv стоит через
Scoop, временно убери его (`scoop uninstall mpv`), затем запусти приложение.
