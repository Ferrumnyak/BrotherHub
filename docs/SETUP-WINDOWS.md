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

## 4. WebView2

Уже встроен в Windows 10 и 11, ставить не нужно.

## 5. (Удобно) редактор

VS Code с расширениями **rust-analyzer** и **Tauri**.

---

# Запуск в режиме разработки

Нужны два окна PowerShell, оба в папке проекта.

**Окно 1 — сервер:**

```powershell
cargo run -p brotherwatch-server
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

# Сборка установщика

```powershell
cd app
npm run tauri build
```

Готовый установщик появится в `target\release\bundle\nsis\`.
