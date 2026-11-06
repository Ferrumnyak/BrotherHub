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

### 2. Ключ подписи обновлений (один раз)

Приложение обновляется по кнопке «Обновить» и ставит только обновления,
подписанные твоим ключом.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\updater-key.ps1
```

Скрипт создаст ключ в `%USERPROFILE%\.tauri\brotherhub.key` (спросит пароль)
и впишет открытую часть в `app/src-tauri/tauri.conf.json` — закоммить этот
файл. Закрытый ключ и пароль никому не отдавай и сохрани копию: без них
установленные версии не смогут обновиться по кнопке.

### 3. Сборка

Подними версию в `app/src-tauri/tauri.conf.json`, `app/package.json` и
`Cargo.toml` (`[workspace.package]`), закоммить, затем:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Notes "Что нового — одной строкой"
```

Скрипт спросит пароль ключа (или возьмёт его из `release.env`), соберёт всё
с вшитым адресом сервера и положит в `release\`:

| Файл | Зачем |
|---|---|
| `BrotherHub-<версия>-setup.exe` | установщик |
| `BrotherHub-<версия>-portable.zip` | без установки, для первого раза |
| `BrotherHub-<версия>-portable.exe` | им обновляется portable-версия |
| `latest.json` | по нему приложения узнают о новой версии |

Текст из `-Notes` друзья увидят рядом с кнопкой «Обновить».

### 4. GitHub Releases

1. Поставь метку версии и отправь всё на GitHub:

   ```powershell
   git tag v0.3.0
   git push origin main --tags
   ```

2. На GitHub: **Releases** → **Draft a new release** → **Choose a tag** →
   `v0.3.0`. Название — например, «BrotherHub 0.3.0».
3. Перетащи в **Attach binaries** все четыре файла из таблицы выше.
   Имена не меняй — на них ссылается `latest.json`.
4. Оставь **Set as the latest release** включённым и нажми **Publish release**.

Через несколько секунд у друзей с версией 0.3.0 и новее появится кнопка
«Обновить до …» (в шапке зала и на экране входа, а в настройках — «Проверить
обновления»). Нажал — скачалось, поставилось и перезапустилось само.

Версии до 0.3.0 обновляться по кнопке не умеют: на них один раз нужно
поставить новую версию вручную по ссылке
`https://github.com/Ferrumnyak/Brotherwatch/releases/latest`.

## Без установщика (portable)

`scripts\release.ps1` уже собирает portable-версию. Отдельно, без подписи и
`latest.json` (например, для проверки у себя):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\portable.ps1
```

Собирает папку `release\BrotherHub\` (BrotherHub.exe и THIRD-PARTY.md) и
архив `release\BrotherHub-<версия>-portable.zip`. Распаковал — запустил
`BrotherHub.exe`, ничего не устанавливая; плеер скачается при первом
запуске, как и в установленной версии. Обновляется portable по той же кнопке:
приложение скачивает новый `BrotherHub.exe` и подменяет себя. Нужна Windows 10/11.

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
