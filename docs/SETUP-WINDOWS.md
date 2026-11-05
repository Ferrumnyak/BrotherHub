# Подготовка Windows к разработке

Всё ставится один раз. Команды выполнять в PowerShell.

## 1. Инструменты сборки C++ (нужны компилятору Rust)

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Установка займёт 10–20 минут и несколько гигабайт.

## 2. Rust

```powershell
winget install --id Rustlang.Rustup
```

Закрой и снова открой PowerShell, затем проверь:

```powershell
rustup default stable-msvc
cargo --version
```

## 3. Node.js (для интерфейса)

```powershell
winget install --id OpenJS.NodeJS.LTS
```

Перезапусти PowerShell и проверь: `node --version`.

Разреши PowerShell запускать скрипты (иначе `npm` выдаст ошибку
«выполнение сценариев отключено в этой системе»):

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 4. Плеер mpv и yt-dlp

Через [Scoop](https://scoop.sh):

```powershell
irm get.scoop.sh | iex
scoop bucket add extras
scoop install mpv yt-dlp
```

Проверь: `mpv --version`. yt-dlp нужен для ссылок на YouTube, VK Видео, Rutube.

Если mpv лежит в другом месте, укажи путь к нему переменной окружения
`BROTHERWATCH_MPV` (например, `C:\Tools\mpv\mpv.exe`).

Можно ничего не ставить: если mpv или yt-dlp не найдутся, приложение при
запуске покажет экран «Готовлю плеер» и скачает их само (как у друзей) —
но только когда в `app/src-tauri/player-pack.json` уже вписан адрес архива
(см. `docs/BUILD-INSTALLER.md`).

## 5. Голосовой сервер LiveKit (для проверки голоса на своём ПК)

1. Открой https://github.com/livekit/livekit/releases и в последнем релизе
   скачай архив `livekit_<версия>_windows_amd64.zip`.
2. Распакуй `livekit-server.exe` в удобную папку, например `C:\Tools\livekit`.
3. Запускай его в отдельном окне PowerShell:

   ```powershell
   C:\Tools\livekit\livekit-server.exe --dev --bind 127.0.0.1
   ```

   `--dev` — режим разработки с готовыми ключами (`devkey` / `secret`),
   `--bind 127.0.0.1` — доступен только с этого ПК. Если Windows спросит
   про доступ в сеть — разреши только для частных сетей.

## 6. WebView2

Уже встроен в Windows 10 и 11, ставить не нужно.

## 7. (Удобно) редактор

VS Code с расширениями **rust-analyzer** и **Tauri**.

---

# Запуск в режиме разработки

Нужны два окна PowerShell, оба в папке проекта.

**Окно 1 — сервер:**

```powershell
cargo run -p brotherwatch-server -- --dev
```

`--dev` включает голос через локальный LiveKit (см. раздел 5). Без LiveKit
сервер тоже работает, просто без голоса.

Чтобы проверить вход по паролю:

```powershell
$env:BROTHERWATCH_PASSWORD = "придумай-пароль"
cargo run -p brotherwatch-server -- --dev
```

**Окно 2 — приложение:**

```powershell
cd app
npm install        # только в первый раз и после изменения package.json
npm run tauri dev
```

Первая сборка идёт долго (5–10 минут), дальше — секунды.

В окне приложения оставь сервер `ws://127.0.0.1:8080`, введи ник и войди.

**Как проверить чат вдвоём на одном ПК:** пока `npm run tauri dev` запущен,
открой ещё один экземпляр приложения файлом `target\debug\brotherwatch.exe`
и войди в ту же комнату под другим ником.

> `target\debug\brotherwatch.exe` — отладочная сборка: интерфейс она берёт
> у `npm run tauri dev`, поэтому без него не откроется. Самостоятельный exe —
> после `npm run tauri build` (см. ниже).

**Как проверить голос на одном ПК:** запусти LiveKit и сервер с `--dev`,
зайди с двух окон приложения. Чтобы не было эха, в одном окне выключи
микрофон или звук (кнопка с наушниками).


**Как проверить синхронизацию на одном ПК:** войди в обоих окнах в одну
комнату. В окне главы лобби (👑) нажми «Открыть файл», во втором окне выбери
тот же файл. Пауза и перемотка в плеере главы повторятся во втором плеере.

# Тесты

```powershell
cargo test -p brotherwatch-server -p brotherwatch-shared
```

Тесты сервера поднимают настоящий сервер на свободном порту и проверяют
вход, чат, права ведущего, исключение, пароль, возвращение после обрыва
связи и защиту от флуда. Тесты приложения (`cargo test -p brotherwatch`)
проверяют расчёт синхронизации и вспомогательные функции.

# Сборка установщика

```powershell
cd app
npm run tauri build
```

Готовый установщик появится в `target\release\bundle\nsis\`.
