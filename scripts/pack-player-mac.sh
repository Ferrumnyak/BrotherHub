#!/bin/bash
# Готовит плеер mpv для macOS — один раз на версию mpv, на Mac:
#   1. скачивает официальные сборки mpv для Apple Silicon и Intel
#      (релизы https://github.com/mpv-player/mpv);
#   2. проверяет, что mpv.app самодостаточен (не тянет библиотеки Homebrew);
#   3. перепаковывает каждый в zip с одним mpv.app внутри;
#   4. вписывает адреса и SHA-256 в app/src-tauri/player-pack.json (раздел macos).
# Архивы нужно выложить в GitHub Releases — приложение скачивает их при
# первом запуске. Запуск из корня репозитория:
#   scripts/pack-player-mac.sh            — mpv v0.41.0
#   scripts/pack-player-mac.sh v0.42.0    — другая версия
# Если в релизе mpv файлы называются иначе, их можно указать:
#   MPV_ARM_ASSET=… MPV_INTEL_ASSET=… scripts/pack-player-mac.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
REPO="Ferrumnyak/BrotherHub"

MPV_VERSION="${1:-v0.41.0}"
ARM_ASSET="${MPV_ARM_ASSET:-mpv-$MPV_VERSION-macos-14-arm.zip}"
INTEL_ASSET="${MPV_INTEL_ASSET:-mpv-$MPV_VERSION-macos-15-intel.zip}"
STAMP=$(date +%Y%m%d)
TAG="player-mac-$STAMP"
OUT="$ROOT/release/player"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

fail() { printf '\033[31m%s\033[0m\n' "$*"; exit 1; }

# Найти mpv.app в распакованном (внутри zip бывает ещё tar.gz).
find_app() {
    local dir=$1 app
    app=$(find "$dir" -type d -name "mpv.app" -prune | head -1)
    if [ -z "$app" ]; then
        local tgz
        for tgz in $(find "$dir" -name "*.tar.gz" -o -name "*.tgz"); do
            tar -xzf "$tgz" -C "$dir"
        done
        app=$(find "$dir" -type d -name "mpv.app" -prune | head -1)
    fi
    echo "$app"
}

pack() {
    local arch=$1 asset=$2
    local url="https://github.com/mpv-player/mpv/releases/download/$MPV_VERSION/$asset"
    local dir="$WORK/$arch"
    mkdir -p "$dir"
    echo "Скачиваю $url"
    curl -fL --progress-bar -o "$dir/download.zip" "$url" \
        || fail "Не скачался $asset. Посмотри имена файлов в релизе $MPV_VERSION и укажи их через MPV_ARM_ASSET / MPV_INTEL_ASSET."
    ditto -x -k "$dir/download.zip" "$dir/unpacked"
    local app
    app=$(find_app "$dir/unpacked")
    [ -n "$app" ] || fail "В $asset нет mpv.app."
    local exe="$app/Contents/MacOS/mpv"
    [ -x "$exe" ] || fail "В $asset нет mpv.app/Contents/MacOS/mpv."

    local want=$arch
    lipo -archs "$exe" | tr ' ' '\n' | grep -qx "$want" \
        || fail "mpv из $asset не для $want (а для $(lipo -archs "$exe"))."
    # Самодостаточен ли: библиотеки только системные или свои внутри mpv.app.
    local bad
    bad=$(find "$app/Contents" -type f \( -perm -u+x -o -name "*.dylib" \) -print0 \
        | xargs -0 otool -L 2>/dev/null | grep -E '^\s+/(opt/homebrew|usr/local|opt/local)/' || true)
    [ -z "$bad" ] || fail "mpv из $asset зависит от библиотек вне приложения:
$bad"
    if [ "$(uname -m)" = "$want" ]; then
        "$exe" --version | head -1
    fi

    local name="mpv-macos-$arch-$STAMP.zip"
    rm -f "$OUT/$name"
    ditto -c -k --keepParent "$app" "$OUT/$name"
    local sha size
    sha=$(shasum -a 256 "$OUT/$name" | cut -d' ' -f1)
    size=$(stat -f%z "$OUT/$name")
    echo "$arch $name $sha $size" >> "$WORK/packs.txt"
    echo "Готово: release/player/$name"
}

pack arm64 "$ARM_ASSET"
pack x86_64 "$INTEL_ASSET"

# ---------- player-pack.json ----------
node -e '
    const fs = require("fs");
    const [file, repo, tag, list] = process.argv.slice(1);
    const pack = JSON.parse(fs.readFileSync(file, "utf8"));
    pack.macos = pack.macos || {};
    for (const line of fs.readFileSync(list, "utf8").split("\n").filter(Boolean)) {
        const [arch, name, sha256, size] = line.split(" ");
        pack.macos[arch] = {
            url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
            sha256,
            size: Number(size),
        };
    }
    fs.writeFileSync(file, JSON.stringify(pack, null, 2) + "\n");
' "$ROOT/app/src-tauri/player-pack.json" "$REPO" "$TAG" "$WORK/packs.txt"

echo
printf '\033[32m%s\033[0m\n' "player-pack.json обновлён — закоммить его вместе с остальным."
echo
echo "Теперь выложи оба архива из release/player на GitHub (один раз для этой версии mpv):"
echo "  1. https://github.com/$REPO/releases/new"
echo "  2. Тег: $TAG (создать новый), название: Плеер mpv для macOS $STAMP"
echo "  3. Приложить: $(cut -d' ' -f2 "$WORK/packs.txt" | tr '\n' ' ')"
echo "  4. Отметить «Set as a pre-release» (чтобы не стал «последним релизом»)."
echo "Релиз не удалять: по этим адресам приложение скачивает плеер."
