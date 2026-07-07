#!/bin/bash

set -e

dlarch="$1"
if [ "$1" == "amd64" ]; then
    dlarch="x86_64"
elif [ "$1" == "arm64" ]; then
    dlarch="aarch64"
fi

frameworkver="$2"

CLICK_ARCH=$(dpkg-architecture -qDEB_HOST_ARCH)
CLICK_FRAMEWORK=$frameworkver

pkgver=0.0.0
srcdir=$ROOT
pkgdir=$INSTALL_DIR
pkgfile=Volla.Messages_${pkgver}_${dlarch}.AppImage

mkdir -p $pkgdir

# Various common environment variables
export PKG_CONFIG_PATH=$pkgdir/lib/pkgconfig:$pkgdir/share/pkgconfig:$PKG_CONFIG_PATH
export LD_LIBRARY_PATH=$pkgdir/lib:$LD_LIBRARY_PATH

DL_URL="https://github.com/HelloVolla/volla-messages/releases/download/v$pkgver/$pkgfile"

FILENAME=$pkgfile

if [ ! -f ./"$FILENAME" ] ; then
    echo "[+] Downloading the Volla Messages AppImage"
    wget $DL_URL -O "$FILENAME"
else
    echo "[+] Volla Messages AppImage already exists"
fi

if [[ "${ARCH}" == "amd64" ]]; then
    QEMU_ARCH="x86_64";
elif [[ "${ARCH}" == "arm64" ]]; then
    QEMU_ARCH="aarch64";
elif [[ "${ARCH}" == "armhf" ]]; then
    QEMU_ARCH="arm";
fi;

chmod +x ./"$FILENAME"

echo "[+] Extracting the AppImage"
qemu-${QEMU_ARCH}-static ./"$FILENAME" --appimage-extract

echo "[+] Copying files..."
cp -r squashfs-root/* "$pkgdir/"

echo "[+] Removing upstream desktop file"
rm -f "$pkgdir/Volla Messages.desktop"

echo "[+] Fixing permissions"
chmod -R u+rwX,go+rX,go-w "$pkgdir"

mkdir -p $pkgdir/patches

echo "[+] Compiling webkit scale hook..."
aarch64-linux-gnu-gcc \
    -shared -fPIC \
    -o "$pkgdir/patches/webkit_zoom_hook.so" \
    "$ROOT/patches/webkit_zoom_hook.c" \
    -ldl

echo "[+] Downloading & Installing NoCSD Patch..."
rm -r libgtk-nocsd0* || true

# This is in the 26.04 repos, so we need to download it manually
wget "https://mirrors.edge.kernel.org/ubuntu/pool/universe/g/gtk-nocsd/libgtk-nocsd0_3+0~20260321+0b77e1b-1_arm64.deb"
mv libgtk-nocsd0*.deb libgtk-nocsd0.deb
dpkg-deb -x libgtk-nocsd0.deb libgtk-nocsd0_extracted
cp libgtk-nocsd0_extracted/usr/lib/aarch64-linux-gnu/libgtk-nocsd.so.0 $pkgdir/patches/libgtk-nocsd.so

echo "[+] Adding Maliit Keyboard Support"
FOCAL="http://ports.ubuntu.com/ubuntu-ports/pool/universe/m/maliit-framework"
FOCAL_GTK="http://ports.ubuntu.com/ubuntu-ports/pool/universe/m/maliit-inputcontext-gtk"
GLIB_VER="0.99.1+git20151118+62bd54b-0ubuntu26"
GTK_VER="0.99.1-0ubuntu2"

wget -q "${FOCAL}/libmaliit-glib0_${GLIB_VER}_arm64.deb"              -O libmaliit-glib0.deb
wget -q "${FOCAL_GTK}/maliit-inputcontext-gtk3_${GTK_VER}_arm64.deb"  -O maliit-inputcontext-gtk3.deb

dpkg-deb -x libmaliit-glib0.deb          libmaliit_ex/
dpkg-deb -x maliit-inputcontext-gtk3.deb maliit_gtk_ex/

mkdir -p $pkgdir/lib/aarch64-linux-gnu/gtk-3.0/3.0.0/immodules/
cp libmaliit_ex/usr/lib/libmaliit-glib.so.0.99.1  $pkgdir/lib/aarch64-linux-gnu/
ln -sf libmaliit-glib.so.0.99.1 $pkgdir/lib/aarch64-linux-gnu/libmaliit-glib.so.0.99
ln -sf libmaliit-glib.so.0.99.1 $pkgdir/lib/aarch64-linux-gnu/libmaliit-glib.so.0

IMMALIIT=$(find maliit_gtk_ex/ -name "im-maliit.so" | head -1)
cp "$IMMALIIT" $pkgdir/lib/aarch64-linux-gnu/gtk-3.0/3.0.0/immodules/

cp $ROOT/manifest.json $pkgdir/
sed -i "s/@CLICK_ARCH@/$CLICK_ARCH/g"       $pkgdir/manifest.json
sed -i "s/@CLICK_FRAMEWORK@/$CLICK_FRAMEWORK/g" $pkgdir/manifest.json
sed -i "s/@CLICK_VERSION@/$pkgver/g"        $pkgdir/manifest.json
cp $ROOT/volla-messages.apparmor $pkgdir/
cp $ROOT/volla-messages.desktop $pkgdir/
cp $ROOT/volla-messages.wrapper $pkgdir/
chmod a+x $pkgdir/volla-messages.wrapper

echo "[+] Packaging into a click file..."

exit 0