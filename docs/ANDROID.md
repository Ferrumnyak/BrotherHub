# BrotherHub для Android

Первая версия для телефона: совместный просмотр по ссылке (YouTube, VK,
SoundCloud и всё, что открывает yt-dlp) и голосовой чат. Показа экрана,
«Обзора», СДВГ-режима и мини-окна на телефоне нет.

Как это устроено:

- интерфейс тот же, что на компьютере (React), в режиме `html.android`;
- видео показывает ExoPlayer (Media3), он лежит **под** прозрачным
  интерфейсом — кнопки и чат рисуются поверх видео как обычно;
- ссылки разбирает yt-dlp, встроенный в APK (библиотека youtubedl-android);
  при каждом запуске он сам обновляется;
- Rust-часть (синхронизация, сеть, голосовой токен) — общая с компьютером;
  с плеером она говорит теми же командами, что с mpv
  (`src-tauri/src/player_android.rs` ↔ `src-tauri/gen/android/app/src/main/java/com/ferrumnyak/brotherwatch/PlayerPlugin.kt`).

## Что установить (один раз)

1. **Android Studio** — https://developer.android.com/studio
2. В Android Studio: *More Actions → SDK Manager*:
   - вкладка *SDK Platforms*: **Android 14 (API 34)** или новее;
   - вкладка *SDK Tools*: **Android SDK Build-Tools**, **NDK (Side by side)**,
     **Android SDK Command-line Tools**, **Android SDK Platform-Tools**.
3. Переменные окружения (Пуск → «Изменение системных переменных среды»),
   пути — свои, версию NDK посмотри в папке `ndk`:
   ```
   JAVA_HOME    = C:\Program Files\Android\Android Studio\jbr
   ANDROID_HOME = C:\Users\<ты>\AppData\Local\Android\Sdk
   NDK_HOME     = %ANDROID_HOME%\ndk\<версия>
   ```
4. Цели Rust для Android:
   ```
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
5. На телефоне: *Настройки → О телефоне* → 7 раз нажать «Номер сборки»,
   затем в *Для разработчиков* включить **Отладку по USB**.

## Первый запуск

В папке `app`:

```
npm run tauri android init
powershell -ExecutionPolicy Bypass -File ..\scripts\android-setup.ps1
npm run tauri icon src-tauri\icons\icon.png
```

`android-setup.ps1` кладёт Kotlin-плеер в созданный Android-проект,
добавляет библиотеки и разрешение на микрофон. Папку
`src-tauri/gen/android` коммитим в репозиторий.

## Разработка и сборка

Телефон по USB:

```
npm run tauri android dev
```

APK для друзей (подписан отладочным ключом, ставится без Play Маркета):

```
npm run tauri android build -- --apk --debug --target aarch64
```

Готовый файл: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/`.
На телефоне при установке нужно разрешить «установку из неизвестных
источников». Почти все современные телефоны — `aarch64` (arm64).

Логи приложения на телефоне: `adb logcat -s BrotherHub` (плеер) и
`adb logcat | findstr RustStdoutStderr` (Rust).
