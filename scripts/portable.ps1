# Собирает BrotherWatch без установщика: папка с BrotherWatch.exe,
# упакованная в zip. Распаковал — запустил, ничего не устанавливая.
# mpv и yt-dlp приложение скачает само при первом запуске (в
# %LOCALAPPDATA%\com.ferrumnyak.brotherwatch\).
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\portable.ps1
#
# Адрес сервера берётся из release.env (если есть), иначе — адрес по
# умолчанию из приложения.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ---------- Адрес сервера ----------
$server = $null
$envFile = Join-Path $root "release.env"
if (Test-Path $envFile) {
    foreach ($raw in Get-Content $envFile -Encoding UTF8) {
        $line = $raw.Trim()
        if ($line.StartsWith("SERVER=")) { $server = $line.Substring(7).Trim() }
    }
    if ($server -match "example\.com") { $server = $null }
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

# ---------- Сборка exe (без установщика) ----------
$config = Get-Content (Join-Path $root "app\src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $config.version
if ($server) {
    Write-Host "Собираю BrotherWatch $version для сервера $server..."
    $env:VITE_DEFAULT_SERVER = $server
} else {
    Write-Host "Собираю BrotherWatch $version (адрес сервера — по умолчанию)..."
}
Push-Location (Join-Path $root "app")
try {
    npm run tauri build -- --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась — ошибки выше." }
}
finally {
    Pop-Location
    Remove-Item Env:VITE_DEFAULT_SERVER -ErrorAction SilentlyContinue
}

# ---------- Папка ----------
$exe = Join-Path $root "target\release\brotherwatch.exe"
if (-not (Test-Path $exe)) { throw "Не нашёл $exe" }

$releaseDir = Join-Path $root "release"
$out = Join-Path $releaseDir "BrotherWatch"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Copy-Item $exe (Join-Path $out "BrotherWatch.exe")
Copy-Item (Join-Path $root "docs\THIRD-PARTY.md") $out

# ---------- Zip ----------
$zip = Join-Path $releaseDir "BrotherWatch-$version-portable.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $out -DestinationPath $zip

Write-Host ""
Write-Host "Готово:" -ForegroundColor Green
Write-Host "  папка  $out"
Write-Host "  архив  $zip"
Write-Host "Запуск — BrotherWatch.exe в папке. Нужна Windows 10/11 (WebView2 там уже есть)."
Write-Host "При первом запуске приложение скачает плеер (~60 МБ)."
