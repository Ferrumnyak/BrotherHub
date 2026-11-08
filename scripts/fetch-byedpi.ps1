# Скачивает исходники ByeDPI (ciadpi) для ускорения YouTube на телефоне и ТВ.
# build.rs собирает из них ciadpi под Android вместе с приложением.
# Запускать один раз (и при обновлении ByeDPI) — исходники коммитятся.
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-byedpi.ps1
#
# Результат: app\src-tauri\byedpi\ (исходники ByeDPI, лицензия MIT).
# На компьютере ciadpi.exe не собирается: приложение скачивает готовый
# с официальной страницы релизов (версия — в app\src-tauri\src\dpi.rs).

param([string]$Version = "0.17.3")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "app\src-tauri\byedpi"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "brotherhub-byedpi"
$archive = Join-Path $tmp "byedpi.zip"

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$url = "https://github.com/hufrea/byedpi/archive/refs/tags/v$Version.zip"
Write-Host "Скачиваю $url"
Invoke-WebRequest -Uri $url -OutFile $archive -Headers @{ "User-Agent" = "BrotherHub-build" }
Expand-Archive -LiteralPath $archive -DestinationPath $tmp -Force

$unpacked = Get-ChildItem -Directory $tmp | Select-Object -First 1
if (-not $unpacked -or -not (Test-Path (Join-Path $unpacked.FullName "main.c"))) {
    throw "В архиве нет исходников ByeDPI (main.c)."
}

Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dest | Out-Null
# Только то, что нужно для сборки, и лицензия.
Get-ChildItem -File $unpacked.FullName |
    Where-Object { $_.Extension -in ".c", ".h" -or $_.Name -like "LICENSE*" -or $_.Name -like "README*" } |
    Copy-Item -Destination $dest
Set-Content -Path (Join-Path $dest "VERSION") -Value $Version -Encoding ascii

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host "Готово: $dest (ByeDPI $Version)"
