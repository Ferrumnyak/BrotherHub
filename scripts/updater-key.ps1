# Один раз: создаёт ключ подписи обновлений и вписывает его открытую часть
# в app\src-tauri\tauri.conf.json (plugins.updater.pubkey).
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\updater-key.ps1
#
# Закрытый ключ ложится в %USERPROFILE%\.tauri\brotherhub.key — в репозиторий
# он НЕ попадает. Им scripts\release.ps1 подписывает каждый релиз, а
# приложения у друзей ставят только подписанные им обновления.
# Потеряешь ключ — уже установленные версии не смогут обновиться по кнопке,
# придётся один раз поставить новую вручную. Сохрани копию ключа и пароль.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$keyDir = Join-Path $env:USERPROFILE ".tauri"
$key = Join-Path $keyDir "brotherhub.key"
$pub = "$key.pub"
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null

if (Test-Path $key) {
    Write-Host "Ключ уже есть: $key — новый не создаю." -ForegroundColor Yellow
} else {
    Write-Host "Создаю ключ. Придумай пароль и запомни его — он понадобится при каждом релизе."
    Push-Location (Join-Path $root "app")
    try {
        npm run tauri signer generate -- -w "$key"
        if ($LASTEXITCODE -ne 0) { throw "Не получилось создать ключ — ошибки выше." }
    }
    finally {
        Pop-Location
    }
}
if (-not (Test-Path $pub)) { throw "Не нашёл открытый ключ: $pub" }

$pubkey = (Get-Content $pub -Raw).Trim()
$confPath = Join-Path $root "app\src-tauri\tauri.conf.json"
$conf = [IO.File]::ReadAllText($confPath)
$updated = [regex]::Replace($conf, '"pubkey":\s*"[^"]*"', '"pubkey": "' + $pubkey + '"')
[IO.File]::WriteAllText($confPath, $updated, (New-Object Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Готово. Открытый ключ вписан в app\src-tauri\tauri.conf.json — закоммить этот файл." -ForegroundColor Green
Write-Host "Закрытый ключ: $key (никому не отдавай и не клади в репозиторий)."
