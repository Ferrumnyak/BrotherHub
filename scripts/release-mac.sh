#!/bin/bash
# Собирает BrotherHub для macOS (одна сборка для Apple Silicon и Intel) и
# кладёт всё в release/macos/:
#   BrotherHub-<версия>-macos.dmg         — для друзей: открыть и перетащить
#                                           в «Программы»;
#   BrotherHub-<версия>-macos.app.tar.gz  — им обновляется уже установленное
#   (+ .sig)                                приложение (кнопка «Обновить»);
#   latest-macos.json                     — часть latest.json для macOS.
#
# Запуск на Mac из корня репозитория:
#   scripts/release-mac.sh
#
# Дальше папку release/macos перенести на компьютер с Windows в release\macos
# и запустить там scripts\release.ps1 — он добавит macOS в latest.json.
# Подробно — docs/MACOS.md.
#
# Настройки — из того же release.env, что и на Windows (SERVER=…), ключ
# подписи обновлений — ~/.tauri/brotherhub.key (или UPDATER_KEY=… в release.env).
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { red "$*"; exit 1; }

# ---------- Настройки ----------
if [ ! -f release.env ]; then
    cp release.env.example release.env
    fail "Создан release.env. Впиши в него адрес сервера (SERVER=wss://…) и запусти скрипт снова."
fi
# release.env мог прийти с Windows — с \r в концах строк.
setting() {
    tr -d '\r' < release.env | grep -E "^[[:space:]]*$1[[:space:]]*=" | head -1 \
        | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
SERVER=$(setting SERVER)
case "$SERVER" in
    ""|*127.0.0.1*|*localhost*|*example.com*)
        fail "В release.env не указан настоящий адрес сервера (строка SERVER=wss://...)." ;;
esac

# ---------- Инструменты ----------
xcode-select -p >/dev/null 2>&1 || fail "Нет инструментов Xcode. Поставь их: xcode-select --install"
command -v node >/dev/null || fail "Нет Node.js (https://nodejs.org или brew install node)."
command -v cargo >/dev/null || fail "Нет Rust (https://rustup.rs)."
if command -v rustup >/dev/null; then
    rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
fi

VERSION=$(node -p "require('./app/src-tauri/tauri.conf.json').version")
BASE="https://github.com/Ferrumnyak/BrotherHub/releases/download/v$VERSION"
OUT="$ROOT/release/macos"

# ---------- Плеер ----------
HAS_MPV=$(node -p "const p=require('./app/src-tauri/player-pack.json'); !!(p.macos && p.macos.arm64 && p.macos.arm64.url && p.macos.x86_64 && p.macos.x86_64.url)")
if [ "$HAS_MPV" != "true" ]; then
    fail "В player-pack.json нет архивов mpv для macOS. Сначала запусти scripts/pack-player-mac.sh и выложи архивы (см. docs/MACOS.md)."
fi

# ---------- Ключ подписи обновлений ----------
EXTRA_CONFIG=()
KEY=$(setting UPDATER_KEY)
[ -n "$KEY" ] || KEY="$HOME/.tauri/brotherhub.key"
SIGN=1
if [ ! -f "$KEY" ]; then
    yellow "Нет ключа подписи обновлений ($KEY): соберу без файла для «Обновить»."
    yellow "Чтобы обновления на Mac работали, скопируй ключ с Windows (%USERPROFILE%\\.tauri\\brotherhub.key)."
    SIGN=0
    EXTRA_CONFIG=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
else
    PASSWORD=$(setting UPDATER_KEY_PASSWORD)
    if [ -z "$PASSWORD" ]; then
        read -r -s -p "Пароль ключа подписи обновлений: " PASSWORD
        echo
    fi
    export TAURI_SIGNING_PRIVATE_KEY="$KEY"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$PASSWORD"
fi

# ---------- Сборка ----------
echo "Собираю BrotherHub $VERSION для macOS (Apple Silicon + Intel), сервер $SERVER..."
cd "$ROOT/app"
[ -d node_modules ] || npm install
export VITE_DEFAULT_SERVER="$SERVER"
npm run tauri build -- --target universal-apple-darwin \
    --config src-tauri/tauri.bundle.json ${EXTRA_CONFIG[@]+"${EXTRA_CONFIG[@]}"}
unset VITE_DEFAULT_SERVER TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
cd "$ROOT"

BUNDLE="$ROOT/target/universal-apple-darwin/release/bundle/macos"
APP="$BUNDLE/BrotherHub.app"
[ -d "$APP" ] || fail "Не нашёл $APP"

# Своя подпись «без разработчика» (ad-hoc) на всё приложение целиком:
# без неё на Apple Silicon скачанное приложение macOS называет «повреждённым».
codesign --force --deep --sign - "$APP"

rm -rf "$OUT"
mkdir -p "$OUT"

# ---------- DMG ----------
DMG_NAME="BrotherHub-$VERSION-macos.dmg"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Программы"
hdiutil create -volname "BrotherHub" -srcfolder "$STAGE" -ov -format UDZO "$OUT/$DMG_NAME" >/dev/null
rm -rf "$STAGE"

FILES=("$DMG_NAME")
PLATFORMS="{}"

# ---------- Обновление ----------
if [ "$SIGN" = 1 ]; then
    TGZ="$BUNDLE/BrotherHub.app.tar.gz"
    [ -f "$TGZ" ] && [ -f "$TGZ.sig" ] || fail "Не нашёл $TGZ и подпись к нему."
    TGZ_NAME="BrotherHub-$VERSION-macos.app.tar.gz"
    cp "$TGZ" "$OUT/$TGZ_NAME"
    cp "$TGZ.sig" "$OUT/$TGZ_NAME.sig"
    FILES+=("$TGZ_NAME")
    PLATFORMS=$(SIG="$(cat "$TGZ.sig")" URL="$BASE/$TGZ_NAME" node -e '
        const entry = { signature: process.env.SIG.trim(), url: process.env.URL };
        console.log(JSON.stringify({ "darwin-aarch64": entry, "darwin-x86_64": entry }));
    ')
fi

FILES_JSON=$(printf '%s\n' "${FILES[@]}" | node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    console.log(JSON.stringify(lines));
')
node -e '
    const [version, platforms, files] = process.argv.slice(1);
    const out = { version, platforms: JSON.parse(platforms), files: JSON.parse(files) };
    require("fs").writeFileSync(process.argv[4], JSON.stringify(out, null, 2) + "\n");
' "$VERSION" "$PLATFORMS" "$FILES_JSON" "$OUT/latest-macos.json"

echo
green "Готово. Файлы в release/macos:"
for f in "${FILES[@]}"; do echo "  $f"; done
echo "  latest-macos.json"
echo
echo "Дальше: перенеси папку release/macos на компьютер с Windows в release\\macos"
echo "и собери релиз там (scripts\\release.ps1) — он добавит macOS в latest.json."
echo "В GitHub Releases (тег v$VERSION) выложи и эти файлы: ${FILES[*]}."
