# Подготовка Android-проекта BrotherHub.
#
# Запускать ОДИН раз после `npm run tauri android init` (из папки app):
#   powershell -ExecutionPolicy Bypass -File ..\scripts\android-setup.ps1
#
# Что делает:
#  - добавляет библиотеки: ExoPlayer (Media3) и yt-dlp для Android;
#  - разрешает микрофон (голосовой чат) и распаковку нативных библиотек
#    (её требует yt-dlp внутри APK).
# Повторный запуск ничего не ломает: уже сделанное пропускается.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$gen = Join-Path $root "app\src-tauri\gen\android"
if (-not (Test-Path $gen)) {
    throw "Нет папки $gen. Сначала выполни в папке app: npm run tauri android init"
}

function Read-Text($path) { [System.IO.File]::ReadAllText($path) }
function Write-Text($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# 1. Kotlin-плеер лежит прямо в Android-проекте (gen/android коммитится):
#    app/src-tauri/gen/android/app/src/main/java/com/ferrumnyak/brotherwatch/PlayerPlugin.kt
#    Если проект создан заново (`android init`), верни его из git.

# 2. Библиотеки
$gradle = Join-Path $gen "app\build.gradle.kts"
$text = Read-Text $gradle
if ($text -notmatch "media3-exoplayer") {
    $deps = @"
dependencies {
    // BrotherHub: плеер и yt-dlp для Android
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")
    implementation("io.github.junkfood02.youtubedl-android:library:0.17.4")
"@
    $text = [regex]::Replace($text, "(?m)^dependencies\s*\{", $deps.Replace("`r`n", "`n"), 1)
    Write-Host "библиотеки добавлены"
}
if ($text -notmatch "useLegacyPackaging") {
    $pack = @"
android {
    // yt-dlp внутри APK запускается из распакованных нативных библиотек.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
"@
    $text = [regex]::Replace($text, "(?m)^android\s*\{", $pack.Replace("`r`n", "`n"), 1)
    Write-Host "распаковка нативных библиотек включена"
}
Write-Text $gradle $text

# 3. Манифест: микрофон и extractNativeLibs
$manifest = Join-Path $gen "app\src\main\AndroidManifest.xml"
$text = Read-Text $manifest
foreach ($perm in @("android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS")) {
    if ($text -notmatch [regex]::Escape($perm)) {
        $text = $text -replace "(<application)", "<uses-permission android:name=`"$perm`" />`n    `$1"
    }
}
if ($text -notmatch "extractNativeLibs") {
    $text = $text -replace "<application", "<application android:extractNativeLibs=`"true`""
}
Write-Text $manifest $text
Write-Host "манифест обновлён"

Write-Host "Готово. Дальше: npm run tauri android dev (телефон по USB) или npm run tauri android build" -ForegroundColor Green
