# Скачивает свежую сборку mpv, из которой scripts\pack-player.ps1 делает
# архив плеера для BrotherWatch. Обычно отдельно запускать не нужно —
# pack-player.ps1 вызывает его сам.
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-player.ps1
#
# Результат: app\src-tauri\bin\mpv\ (в git не попадает).
# mpv — сборка shinchiro/mpv-winbuild-cmake (архив .7z).
# yt-dlp не нужен: приложение скачивает его само с официальной страницы.

$ErrorActionPreference = "Stop"
# Без этого Invoke-WebRequest качает в разы медленнее из-за полосы прогресса.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "app\src-tauri\bin"
$mpvDir = Join-Path $bin "mpv"
$headers = @{ "User-Agent" = "BrotherWatch-build" }

New-Item -ItemType Directory -Force -Path $mpvDir | Out-Null

# ---------- mpv ----------
Write-Host "Ищу последнюю сборку mpv..."
$release = Invoke-RestMethod -Headers $headers `
    -Uri "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest"
# Обычная 64-битная сборка (не -v3 для новых процессоров, не dev-файлы).
$asset = $release.assets |
    Where-Object { $_.name -match '^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$' } |
    Select-Object -First 1
if (-not $asset) {
    throw "Не нашёл архив mpv в релизе $($release.tag_name). Открой https://github.com/shinchiro/mpv-winbuild-cmake/releases и распакуй mpv-x86_64-<дата>-git-<хеш>.7z в $mpvDir вручную."
}

$archive = Join-Path $env:TEMP $asset.name
Write-Host "Скачиваю $($asset.name)..."
Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $archive

Write-Host "Распаковываю..."
Get-ChildItem $mpvDir | Remove-Item -Recurse -Force
$sevenZip = @(
    "$env:ProgramFiles\7-Zip\7z.exe",
    "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($sevenZip) {
    & $sevenZip x $archive "-o$mpvDir" -y | Out-Null
} else {
    # Встроенный в Windows 10/11 tar обычно умеет .7z.
    tar -xf $archive -C $mpvDir
}
Remove-Item $archive -Force

if (-not (Test-Path (Join-Path $mpvDir "mpv.exe"))) {
    throw "mpv.exe не появился после распаковки. Поставь 7-Zip (winget install 7zip.7zip) и запусти скрипт ещё раз."
}

# Установщик ассоциаций файлов из архива нам не нужен.
Remove-Item (Join-Path $mpvDir "installer") -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Готово:"
Write-Host "  mpv    $((Get-Item (Join-Path $mpvDir 'mpv.exe')).VersionInfo.ProductVersion) ($($asset.name))"
