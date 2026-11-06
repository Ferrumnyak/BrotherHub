# Собирает установщик BrotherHub для друзей и кладёт его в папку release\.
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#
# Адрес сервера берётся из release.env (в git не попадает — репозиторий
# публичный). При первом запуске файл создаётся из release.env.example.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ---------- Настройки релиза ----------
$envFile = Join-Path $root "release.env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root "release.env.example") $envFile
    Write-Host "Создан release.env. Впиши в него адрес сервера и запусти скрипт снова." -ForegroundColor Yellow
    exit 1
}

$settings = @{}
foreach ($raw in Get-Content $envFile -Encoding UTF8) {
    $line = $raw.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
        $parts = $line.Split([char[]]"=", 2)
        $settings[$parts[0].Trim()] = $parts[1].Trim()
    }
}

$server = $settings["SERVER"]
if (-not $server -or $server -match "127\.0\.0\.1|localhost|example\.com") {
    throw "В release.env не указан настоящий адрес сервера (строка SERVER=wss://...)."
}

# ---------- Плеер ----------
# mpv и yt-dlp не входят в сборку: приложение скачивает их при первом
# запуске. Адрес архива mpv должен быть вписан в player-pack.json.
$pack = Get-Content (Join-Path $root "app\src-tauri\player-pack.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pack.url) {
    throw "В player-pack.json нет адреса плеера. Сначала запусти scripts\pack-player.ps1 и выложи архив (см. docs\BUILD-INSTALLER.md)."
}
try {
    Invoke-WebRequest -Method Head -UseBasicParsing -Uri $pack.url | Out-Null
} catch {
    Write-Warning "Архив плеера пока недоступен: $($pack.url)`nВыложи его в GitHub Releases до того, как раздавать сборку, иначе у друзей не скачается плеер."
}

# ---------- Сборка ----------
$config = Get-Content (Join-Path $root "app\src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $config.version
Write-Host "Собираю BrotherHub $version для сервера $server..."

$env:VITE_DEFAULT_SERVER = $server
Push-Location (Join-Path $root "app")
try {
    npm run bundle
    if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась — ошибки выше." }
}
finally {
    Pop-Location
    Remove-Item Env:VITE_DEFAULT_SERVER -ErrorAction SilentlyContinue
}

# ---------- Готовый файл ----------
$setup = Join-Path $root "target\release\bundle\nsis\BrotherHub_${version}_x64-setup.exe"
if (-not (Test-Path $setup)) { throw "Не нашёл установщик: $setup" }

$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$dest = Join-Path $releaseDir "BrotherHub-$version-setup.exe"
Copy-Item $setup $dest -Force

Write-Host ""
Write-Host "Готово: $dest" -ForegroundColor Green
Write-Host "Дальше — выложить его в GitHub Releases, см. docs\BUILD-INSTALLER.md."
