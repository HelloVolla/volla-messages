#!/bin/sh
# Bundle the shared libraries a binary needs into a directory.
#
# Libraries are resolved against the Ubuntu archive, never against what the
# build machine has installed. Each round reads the NEEDED entries of the
# binary and of everything bundled so far, looks up which packages ship the
# missing libraries, downloads and unpacks them, and repeats until nothing
# is missing.
#
# Libraries listed in rootfs-libs are part of the stock Ubuntu Touch image
# and are not bundled. Extra package names can be given for modules that are
# loaded with dlopen and so never show up as NEEDED.
#
# usage: bundle-deps.sh <binary> <destdir> [package...]

set -eu

binary=$1
dest=$2
shift 2
extra_packages="$*"

arch=${ARCH:-$(dpkg --print-architecture)}
triplet=${ARCH_TRIPLET:-$(dpkg-architecture -a"$arch" -qDEB_HOST_MULTIARCH)}
rootfs_libs=$(dirname "$(readlink -f "$0")")/rootfs-libs

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/debs"
touch "$work/seen"

# libc, the toolchain runtime and the hybris GL/EGL stack must always come
# from the device, even if rootfs-libs is out of date
never_bundle='^(ld-linux|libc|libm|libdl|libpthread|librt|libresolv|libutil|libgcc_s|libstdc\+\+|libEGL|libGLES|libGL|libGLX|libOpenGL|libgbm|libwayland-egl|libhybris|libandroid)[.-]'

# Print every library needed by the binary or by anything bundled so far.
needed_libs() {
    find "$binary" "$dest" -type f -exec readelf -d {} + 2>/dev/null |
        sed -n 's/.*NEEDED.*\[\(.*\)\]/\1/p' | sort -u
}

# Print the needed libraries that are not provided yet, each only once.
missing_libs() {
    for lib in $(needed_libs); do
        echo "$lib" | grep -qE "$never_bundle" && continue
        grep -qxF "$lib" "$rootfs_libs" "$work/seen" && continue
        echo "$lib" >>"$work/seen"
        [ -n "$(find "$dest" -name "$lib" | head -n1)" ] && continue
        echo "$lib"
    done
}

# Print the package shipping each given library. The archive contents are
# searched once for all of them, as every search reads the whole index.
packages_for() {
    pattern=$(printf '%s\n' "$@" | sed 's/[.+]/\\&/g' | paste -sd'|')
    apt-file -a "$arch" search -x "/$triplet/($pattern)\$" >"$work/hits"
    for lib; do
        pkg=$(grep -F "/$triplet/$lib" "$work/hits" | grep "/$lib\$" | head -n1 | cut -d: -f1)
        if [ -n "$pkg" ]; then
            echo "$pkg:$arch"
        else
            echo "W: no package ships $lib" >&2
        fi
    done
}

# Download the given packages and copy their libraries into the destination.
bundle() {
    (cd "$work/debs" && apt-get download -qq $(printf '%s\n' "$@" | sort -u))
    rm -rf "$work/unpacked"
    for deb in "$work"/debs/*.deb; do
        dpkg-deb -x "$deb" "$work/unpacked"
    done
    rm -f "$work"/debs/*.deb
    cp -a "$work/unpacked/usr/lib/$triplet/." "$dest/"
}

apt-get update -qq
apt-file -a "$arch" update >/dev/null
mkdir -p "$dest"

packages=$(for pkg in $extra_packages; do echo "$pkg:$arch"; done)
while :; do
    missing=$(missing_libs)
    if [ -n "$missing" ]; then
        packages="$packages $(packages_for $missing)"
    fi
    [ -n "$packages" ] || break
    bundle $packages
    packages=
done
