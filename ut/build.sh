#!/bin/bash
# Assemble a click package for Ubuntu Touch from a previously built Volla Messages deb.
# A previously set up environment with all the dependencies for click packaging is required.
#
# Layout of the click:
#   volla-messages-launcher   sets up the environment and execs lib/volla_messages
#   lib/                      the app, the libraries the stock image lacks, and the hooks
#   lib/webkit2gtk-4.1/       webkit's helper processes
set -ex

APPIMAGE=$(readlink -f "$1")

[ -f "$APPIMAGE" ] || { echo "usage: $0 Volla.Messages_*.AppImage"; exit 1; }

ARCH=${ARCH:-$(dpkg --print-architecture)}
TRIPLET=$(dpkg-architecture -a"$ARCH" -qDEB_HOST_MULTIARCH)
HERE=$(dirname "$(readlink -f "$0")")
OUT=$(pwd)
WORK=$(mktemp -d)
STAGE=$WORK/stage
CLICK=$WORK/click

chmod +x "$APPIMAGE"
"$APPIMAGE" --appimage-extract
mv squashfs-root/ "$STAGE"
cd "$WORK"

# The app and its libraries. The maliit gtk module gives GTK the on-screen keyboard.
mkdir -p "$CLICK/lib"
cp "$STAGE"/usr/bin/volla_messages "$CLICK/lib/"
"$HERE"/bundle-deps.sh "$CLICK/lib/volla_messages" "$CLICK/lib" maliit-inputcontext-gtk3

# Webkit runs its helper processes from a directory hardcoded at build time.
# Rewrite it to the bundled copy, relative to the app root the launcher chdirs
# to. The new path is padded with slashes to the same length, so the library
# layout stays intact.
WEBKIT_DIR=/usr/lib/$TRIPLET/webkit2gtk-4.1
BUNDLED_DIR=lib/webkit2gtk-4.1
while [ ${#BUNDLED_DIR} -lt ${#WEBKIT_DIR} ]; do
    BUNDLED_DIR=${BUNDLED_DIR%%/*}//${BUNDLED_DIR#*/}
done
sed -i --follow-symlinks "s|$WEBKIT_DIR|$BUNDLED_DIR|g" "$CLICK"/lib/libwebkit2gtk-4.1.so.0

# Click metadata
cp "$STAGE"/usr/share/icons/hicolor/128x128/apps/volla_messages.png "$CLICK/volla_messages.png"
cp "$HERE"/manifest.json "$HERE"/volla-messages.apparmor "$HERE"/volla-messages.desktop "$CLICK/"
sed -i "s/@CLICK_ARCH@/$ARCH/g" "$CLICK"/manifest.json

# The launcher and the hooks it preloads: page zoom from the grid unit, and no titlebar
gcc -O2 -o "$CLICK/volla-messages-launcher" "$HERE/launcher.c" $(pkg-config --cflags --libs gio-2.0)
gcc -O2 -shared -fPIC -o "$CLICK/lib/webkit_zoom_hook.so" "$HERE/patches/webkit_zoom_hook.c" -ldl
gcc -O2 -shared -fPIC -o "$CLICK/lib/gtk_nocsd_hook.so" "$HERE/patches/gtk_nocsd_hook.c" -ldl

click build "$CLICK"

mv "$WORK"/*.click "$OUT"/
rm -rf "$WORK"
