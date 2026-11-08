# Собирает релиз BrotherHub для друзей и кладёт всё в папку release\:
#   BrotherHub-<версия>-setup.exe     — установщик;
#   BrotherHub-<версия>-portable.zip  — без установки (для первого раза);
#   BrotherHub-<версия>-portable.exe  — им обновляется portable-версия;
#   latest.json                       — по нему приложения узнают о новой версии.
# Все четыре файла выкладываются в GitHub Releases (см. docs\BUILD-INSTALLER.md).
#
# Запуск из корня репозитория:
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Notes "Что нового"
#
# Адрес сервера берётся из release.env (в git не попадает — репозиторий
# публичный). При первом запуске файл создаётся из release.env.example.
# Обновления подписываются ключом из scripts\updater-key.ps1.

param([string]$Notes = "")

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

# ---------- Ключ подписи обновлений ----------
$config = Get-Content (Join-Path $root "app\src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $config.version
if (-not $config.plugins.updater.pubkey) {
    throw "Нет ключа подписи обновлений. Один раз запусти scripts\updater-key.ps1."
}
$key = $settings["UPDATER_KEY"]
if (-not $key) { $key = Join-Path $env:USERPROFILE ".tauri\brotherhub.key" }
if (-not (Test-Path $key)) {
    throw "Не нашёл закрытый ключ подписи: $key (создаётся scripts\updater-key.ps1)."
}
# Пароль проверяем сразу, подписав пробный файл, — а не через пять минут
# сборки. Неверный — спрашиваем ещё раз.
function Test-KeyPassword([string]$pass) {
    $probe = Join-Path $env:TEMP "brotherhub-key-check.txt"
    Set-Content -Path $probe -Value "check" -Encoding ASCII
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pass
    Push-Location (Join-Path $root "app")
    try {
        npm run --silent tauri signer sign -- -f "$key" "$probe" *> $null
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        Pop-Location
        Remove-Item $probe, "$probe.sig" -ErrorAction SilentlyContinue
        Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    }
}

$password = $settings["UPDATER_KEY_PASSWORD"]
if ($null -ne $password -and -not (Test-KeyPassword $password)) {
    Write-Warning "Пароль из release.env не подходит к ключу."
    $password = $null
}
$tries = 0
while ($null -eq $password) {
    $secure = Read-Host "Пароль ключа подписи обновлений (проверь раскладку и Caps Lock)" -AsSecureString
    $typed = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    if (Test-KeyPassword $typed) {
        $password = $typed
    } else {
        $tries += 1
        if ($tries -ge 3) {
            throw "Пароль не подходит к ключу $key. Если он забыт — см. docs\BUILD-INSTALLER.md («Потерял пароль ключа»)."
        }
        Write-Warning "Пароль не подходит, попробуй ещё раз."
    }
}
Write-Host "Пароль ключа подходит." -ForegroundColor Green

# ---------- Сборка ----------
Write-Host "Собираю BrotherHub $version для сервера $server..."

$env:VITE_DEFAULT_SERVER = $server
$env:TAURI_SIGNING_PRIVATE_KEY = $key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
Push-Location (Join-Path $root "app")
try {
    npm run bundle
    if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась — ошибки выше." }
}
finally {
    Pop-Location
    Remove-Item Env:VITE_DEFAULT_SERVER -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

# ---------- Установщик ----------
$setup = Join-Path $root "target\release\bundle\nsis\BrotherHub_${version}_x64-setup.exe"
if (-not (Test-Path $setup)) { throw "Не нашёл установщик: $setup" }
if (-not (Test-Path "$setup.sig")) { throw "Не нашёл подпись установщика: $setup.sig" }

$releaseDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$setupName = "BrotherHub-$version-setup.exe"
Copy-Item $setup (Join-Path $releaseDir $setupName) -Force

# ---------- Portable: тот же exe ----------
$exe = Join-Path $root "target\release\brotherwatch.exe"
if (-not (Test-Path $exe)) { throw "Не нашёл $exe" }
$portableName = "BrotherHub-$version-portable.exe"
$portableExe = Join-Path $releaseDir $portableName
Copy-Item $exe $portableExe -Force

$folder = Join-Path $releaseDir "BrotherHub"
if (Test-Path $folder) { Remove-Item $folder -Recurse -Force }
New-Item -ItemType Directory -Force -Path $folder | Out-Null
Copy-Item $exe (Join-Path $folder "BrotherHub.exe")
Copy-Item (Join-Path $root "docs\THIRD-PARTY.md") $folder
$zip = Join-Path $releaseDir "BrotherHub-$version-portable.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $folder -DestinationPath $zip

# ---------- Android: APK ----------
# Собирается, если есть ключ подписи (app/src-tauri/gen/android/keystore.properties,
# см. docs/ANDROID.md). Без него — только версия для компьютера.
$base = "https://github.com/Ferrumnyak/BrotherHub/releases/download/v$version"
$apkName = $null
$apk32Name = $null
$androidDir = Join-Path $root "app\src-tauri\gen\android"
# У Android своя нумерация версий: app/src-tauri/tauri.android.conf.json.
$androidConf = Join-Path $root "app\src-tauri\tauri.android.conf.json"
$androidVersion = (Get-Content $androidConf -Raw | ConvertFrom-Json).version
if (Test-Path (Join-Path $androidDir "keystore.properties")) {
    Write-Host "Собираю APK для Android $androidVersion..."
    $env:VITE_DEFAULT_SERVER = $server
    Push-Location (Join-Path $root "app")
    try {
        # Отдельный APK под каждый процессор: в общем лежал бы yt-dlp (Python)
        # сразу для всех, и файл вышел бы в 2–3 раза тяжелее.
        npm run tauri android build -- --apk --split-per-abi --target aarch64 armv7
        if ($LASTEXITCODE -ne 0) { throw "Сборка APK не удалась — ошибки выше." }
    }
    finally {
        Pop-Location
        Remove-Item Env:VITE_DEFAULT_SERVER -ErrorAction SilentlyContinue
    }
    $apkDir = Join-Path $androidDir "app\build\outputs\apk"
    $apk = Get-ChildItem $apkDir -Recurse -Filter "*arm64*release*.apk" |
        Where-Object { $_.Name -notmatch "unsigned" } | Select-Object -First 1
    if (-not $apk) { throw "Не нашёл подписанный APK для arm64 в $apkDir" }
    # Почти все телефоны — arm64; старые ТВ-приставки бывают 32-битными (armv7).
    $apkName = "BrotherHub-$androidVersion-android.apk"
    Copy-Item $apk.FullName (Join-Path $releaseDir $apkName) -Force
    $apk32 = Get-ChildItem $apkDir -Recurse -Filter "*-arm-release*.apk" |
        Where-Object { $_.Name -notmatch "unsigned" } | Select-Object -First 1
    if ($apk32) {
        $apk32Name = "BrotherHub-$androidVersion-android-armv7.apk"
        Copy-Item $apk32.FullName (Join-Path $releaseDir $apk32Name) -Force
    }
}
else {
    Write-Warning "APK не собран: нет ключа подписи (keystore.properties) — см. docs\ANDROID.md."
}

# ---------- latest.json ----------
$latest = [ordered]@{
    version  = $version
    notes    = $Notes
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = (Get-Content "$setup.sig" -Raw).Trim()
            url       = "$base/$setupName"
        }
    }
    portable = [ordered]@{
        url    = "$base/$portableName"
        sha256 = (Get-FileHash $portableExe -Algorithm SHA256).Hash.ToLower()
    }
}
if ($apkName) {
    $latest["android"] = [ordered]@{
        version = $androidVersion
        url     = "$base/$apkName"
    }
}
$json = $latest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $releaseDir "latest.json"), $json, (New-Object Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Готово. Выложи в GitHub Releases с тегом v${version} эти файлы из release\:" -ForegroundColor Green
Write-Host "  $setupName"
Write-Host "  BrotherHub-$version-portable.zip"
Write-Host "  $portableName"
if ($apkName) { Write-Host "  $apkName" }
if ($apk32Name) { Write-Host "  $apk32Name" }
Write-Host "  latest.json"
Write-Host "Подробно — docs\BUILD-INSTALLER.md."
