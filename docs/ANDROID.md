# BrotherHub для Android

Версия для телефона и Android TV: совместный просмотр по ссылке (YouTube,
VK, SoundCloud и всё, что открывает yt-dlp), голос, чат, реакции, «Обзор»,
приглашения по ссылке, работа в фоне и «картинка в картинке». Показа
экрана и СДВГ-режима на телефоне нет.

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

Android-проект `src-tauri/gen/android` уже лежит в репозитории вместе с
Kotlin-частью (плеер, служба для фона, «Обзор»), так что `init` и
`android-setup.ps1` нужны только если создавать проект заново.

## Ключ подписи для релизов (один раз)

Обновление APK ставится поверх старого, только если оба подписаны одним
ключом. Ключ создаётся один раз и **не теряется** (без него друзьям придётся
удалять приложение и ставить заново):

```powershell
& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkey -v `
  -keystore "$env:USERPROFILE\.android\brotherhub-release.jks" `
  -keyalg RSA -keysize 2048 -validity 10000 -alias brotherhub
```

Затем файл `app/src-tauri/gen/android/keystore.properties` (он в
`.gitignore`, в репозиторий не попадает):

```
storeFile=C:/Users/<ты>/.android/brotherhub-release.jks
storePassword=<пароль>
keyAlias=brotherhub
keyPassword=<пароль>
```

Когда этот файл есть, `scripts/release.ps1` сам собирает
`BrotherHub-<версия>-android.apk` и прописывает его в `latest.json` —
кнопка «Обновить» на телефоне скачивает его и открывает установку.

## Версия

У Android-версии своя нумерация — `app/src-tauri/tauri.android.conf.json`
(`"version"`). Перед выпуском новой версии APK подними её там: кнопка
«Обновить» на телефоне сравнивает именно её, а файл в релизе называется
`BrotherHub-<эта версия>-android.apk`.

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

Логи приложения на телефоне и ТВ: `adb logcat -s BrotherHub` — и Kotlin, и
Rust (`logs.rs` пишет туда же), и записи интерфейса (`ui_log`).

### Android TV: пульт

- Навигация — `app/src/tv.ts`; «ОК», «Назад» —
  `PlayerPlugin.routeKey` (из `MainActivity.dispatchKeyEvent`).
- Микрофон на ТВ (проверено на Xiaomi MiTV-MZTU1, Google TV 14):
  - встроенный микрофон отдаёт приложениям ровно нули (`AudioRecord`, все
    источники) — физически его нет;
  - кнопку микрофона пульта и его звук забирает Google Ассистент
    (`com.google.android.katniss`);
  - если Ассистента выключить (`adb shell pm disable-user --user 0
    com.google.android.katniss`, вернуть — `pm enable`), кнопка приходит в
    приложение как `KEYCODE_PROG_BLUE` (186), нажатие и отпускание сразу,
    а пульт после нажатия ~15 с передаёт звук; повторное нажатие обрывает;
  - звук пульта приходит только в запись, открытую после нажатия, и только
    на 16 кГц (`VOICE_RECOGNITION`, моно, PCM 16 бит); на 48 кГц
    (`VOICE_COMMUNICATION` и `MIC`) — нули. WebView (`getUserMedia`, WebRTC)
    пишет на 48 кГц, поэтому голосовой чат звук пульта не получает;
  - без Ассистента не работает голосовой ввод во всех приложениях ТВ.
  - Возможный путь: по кнопке Kotlin пишет 16 кГц и передаёт PCM в интерфейс,
    там — дорожка через AudioWorklet → `MediaStreamAudioDestinationNode` и
    публикация в LiveKit вместо обычного микрофона. Пока не сделано.
  - Иначе — USB-микрофон.
