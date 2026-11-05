# Собирает установщик BrotherWatch для друзей и кладёт его в папку release\.
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
$mpv = Join-Path $root "app\src-tauri\bin\mpv\mpv.exe"
$ytdlp = Join-Path $root "app\src-tauri\bin\yt-dlp\yt-dlp.exe"
if (-not (Test-Path $mpv) -or -not (Test-Path $ytdlp)) {
    Write-Host "Нет mpv или yt-dlp — скачиваю..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "fetch-player.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать mpv и yt-dlp." }
}

# ---------- Сборка ----------
$config = Get-Content (Join-Path $root "app\src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $config.version
Write-Host "Собираю BrotherWatch $version для сервера $server..."

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
$setup = Join-Path $root "target\release\bundle\nsis\BrotherWatch_${version}_x64-setup.exe"
if (-not (Test-Path $setup)) { throw "Не нашёл установщик: $setup" }

$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$dest = Join-Path $releaseDir "BrotherWatch-$version-setup.exe"
Copy-Item $setup $dest -Force

Write-Host ""
Write-Host "Готово: $dest" -ForegroundColor Green
Write-Host "Дальше — выложить его в GitHub Releases, см. docs\BUILD-INSTALLER.md."
