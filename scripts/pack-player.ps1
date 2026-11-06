# Готовит архив плеера mpv, который BrotherHub скачивает при первом запуске.
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\pack-player.ps1
#
# Что делает:
#   1. берёт mpv из app\src-tauri\bin\mpv\ (если его нет — скачивает
#      свежую сборку через fetch-player.ps1);
#   2. упаковывает нужные файлы в release\mpv-x86_64-<дата>.zip;
#   3. записывает адрес архива и его SHA-256 в app\src-tauri\player-pack.json
#      (этот файл коммитится: по нему приложение знает, что качать).
#
# После этого архив нужно выложить в GitHub Releases (скрипт подскажет как).
# Запускать заново нужно только для обновления mpv — не к каждому релизу.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$repo = "Ferrumnyak/Brotherwatch"
$mpvDir = Join-Path $root "app\src-tauri\bin\mpv"
$mpvExe = Join-Path $mpvDir "mpv.exe"

if (-not (Test-Path $mpvExe)) {
    Write-Host "Нет mpv — скачиваю..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "fetch-player.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать mpv." }
}

# Дата сборки mpv — по ней называются архив и тег релиза.
$stamp = (Get-Item $mpvExe).LastWriteTime.ToString("yyyyMMdd")
$tag = "player-$stamp"
$name = "mpv-x86_64-$stamp.zip"

# ---------- Что кладём в архив ----------
# Только сам плеер: без документации, .bat-файлов и mpv.com.
$staging = Join-Path $env:TEMP "brotherwatch-mpv-pack"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item $mpvExe $staging
foreach ($extra in @("d3dcompiler_43.dll", "mpv")) {
    $path = Join-Path $mpvDir $extra
    if (Test-Path $path) { Copy-Item $path $staging -Recurse }
}

# ---------- Архив ----------
$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$zip = Join-Path $releaseDir $name
if (Test-Path $zip) { Remove-Item $zip -Force }

$sevenZip = @(
    "$env:ProgramFiles\7-Zip\7z.exe",
    "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Host "Упаковываю $name..."
if ($sevenZip) {
    # Обычный zip (Deflate), но сжатый сильнее, чем умеет PowerShell.
    & $sevenZip a -tzip -mx=9 $zip (Join-Path $staging "*") | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7-Zip не смог упаковать архив." }
} else {
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -CompressionLevel Optimal
}
Remove-Item $staging -Recurse -Force

# ---------- player-pack.json ----------
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item $zip).Length
$url = "https://github.com/$repo/releases/download/$tag/$name"
$json = "{`n  `"url`": `"$url`",`n  `"sha256`": `"$hash`",`n  `"size`": $size`n}`n"
# Без BOM: файл читает Rust при сборке.
[IO.File]::WriteAllText((Join-Path $root "app\src-tauri\player-pack.json"), $json, (New-Object Text.UTF8Encoding $false))

$mb = [Math]::Round($size / 1MB, 1)
Write-Host ""
Write-Host "Готово: $zip ($mb МБ)" -ForegroundColor Green
Write-Host "player-pack.json обновлён — закоммить его вместе с остальным."
Write-Host ""
Write-Host "Теперь выложи архив на GitHub (один раз для этой версии mpv):" -ForegroundColor Yellow
Write-Host "  1. https://github.com/$repo/releases/new"
Write-Host "  2. Тег: $tag (создать новый), название: Плеер mpv $stamp"
Write-Host "  3. Прикрепи файл $name"
Write-Host "  4. Поставь галочку «Set as a pre-release», сними «Set as the latest release»"
Write-Host "     — чтобы на странице «последний релиз» оставался сам BrotherHub."
Write-Host "  5. Publish release"
Write-Host ""
Write-Host "Проверить, что архив доступен: $url"
