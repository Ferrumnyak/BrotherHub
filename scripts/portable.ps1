# Собирает BrotherWatch без установщика: папка с BrotherWatch.exe, mpv и
# yt-dlp, упакованная в zip. Распаковал — запустил, ничего не устанавливая.
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
$binDir = Join-Path $root "app\src-tauri\bin"
if (-not (Test-Path (Join-Path $binDir "mpv\mpv.exe")) -or -not (Test-Path (Join-Path $binDir "yt-dlp\yt-dlp.exe"))) {
    Write-Host "Нет mpv или yt-dlp — скачиваю..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "fetch-player.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать mpv и yt-dlp." }
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
Copy-Item (Join-Path $binDir "mpv") (Join-Path $out "mpv") -Recurse
Copy-Item (Join-Path $binDir "yt-dlp") (Join-Path $out "yt-dlp") -Recurse
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
