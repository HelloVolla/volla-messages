#!/bin/bash
set -ex

HERE=$(dirname "$(readlink -f "$0")")
mkdir -p "$INSTALL_DIR/lib"

APPIMAGE=$(readlink -f "${HERE}"/*.AppImage)
chmod +x "$APPIMAGE"
$APPIMAGE --appimage-extract

gcc -O2 -DARCH_TRIPLET="\"$ARCH_TRIPLET\"" -o "$INSTALL_DIR/volla-messages-launcher" "$HERE/launcher.c"
gcc -O2 -shared -fPIC -o "$INSTALL_DIR/lib/webkit_zoom_hook.so" "$HERE/patches/webkit_zoom_hook.c" -ldl
gcc -O2 -shared -fPIC -o "$INSTALL_DIR/lib/gtk_nocsd_hook.so" "$HERE/patches/gtk_nocsd_hook.c" -ldl
