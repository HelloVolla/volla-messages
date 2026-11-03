#!/bin/bash
set -ex

# webkit spawns its helpers from a fixed /usr path, make it relative to
# the click root the launcher runs from (same length, so a plain sed)
sed -i "s|/usr/lib/${ARCH_TRIPLET}/webkit2gtk-4.1|././/lib/${ARCH_TRIPLET}/webkit2gtk-4.1|g" \
    "$INSTALL_DIR"/lib/${ARCH_TRIPLET}/libwebkit2gtk-4.1.so.0.*
