{
  description = "Volla Messages — development environment";

  # We depend on holonix only for the Holochain toolchain (holochain, hc,
  # lair-keystore, bootstrap-srv) and the rust-overlay it already pins.
  # Everything else (Rust toolchain, Android SDK/NDK, Tauri desktop libs) is
  # composed here from nixpkgs, so the repo has no dependency on any external
  # Tauri/Holochain dev-shell flake. (The previous dev shells came from
  # darksoil-studio/tauri-plugin-holochain, whose availability has been
  # unreliable, and which pinned a stale webkitgtk 2.42.)
  inputs = {
    holonix.url = "github:holochain/holonix/main-0.7";

    nixpkgs.follows = "holonix/nixpkgs";
    flake-parts.follows = "holonix/flake-parts";
    rust-overlay.follows = "holonix/rust-overlay";
  };

  outputs = inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = builtins.attrNames inputs.holonix.devShells;
      perSystem = { system, inputs', ... }:
        let
          pkgs = import inputs.nixpkgs {
            inherit system;
            overlays = [ (import inputs.rust-overlay) ];
            config = {
              allowUnfree = true; # Android SDK/NDK are unfree
              android_sdk.accept_license = true;
            };
          };

          # Rust toolchain. Channel, components, and cross-compilation targets all
          # come from ./rust-toolchain.toml so nix and rustup users stay in sync.
          rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

          # Android SDK + NDK, matching the gradle configs in src-tauri/gen/*
          # (compileSdk 35, targetSdk 34, minSdk 27). The NDK is what `cargo ndk`
          # uses to cross-compile the Rust crates into jniLibs. 28.0.13004108 is
          # the NDK the previous (darksoil) dev shell shipped, so produced .so
          # files stay the same (clang 19, 16 KB page-aligned).
          ndkVersion = "28.0.13004108";
          androidComposition = pkgs.androidenv.composeAndroidPackages {
            # 34 + 35: targetSdk and compileSdk. Gradle cannot auto-install
            # platforms or build-tools into the read-only nix store, so every
            # version the build touches must be listed here.
            platformVersions = [ "34" "35" ];
            buildToolsVersions = [ "34.0.0" "35.0.0" ];
            includeNDK = true;
            ndkVersions = [ ndkVersion ];
            cmakeVersions = [ "3.22.1" ];
            includeEmulator = false; # emulator is provided by CI / installed on demand
            includeSystemImages = false;
          };
          androidSdk = androidComposition.androidsdk;
          androidHome = "${androidSdk}/libexec/android-sdk";
          ndkHome = "${androidHome}/ndk/${ndkVersion}";

          # System libraries to build/run a Tauri v2 desktop app on Linux.
          tauriDeps = with pkgs; [
            webkitgtk_4_1
            gtk3
            gdk-pixbuf
            glib
            glib-networking
            librsvg
            libsoup_3
            dbus
            openssl
          ];

          # Tools common to the desktop and android shells.
          commonPackages = (with inputs'.holonix.packages; [
            holochain
            hc
            lair-keystore
            bootstrap-srv # `kitsune2-bootstrap-srv`, used by `npm run local-services`
          ]) ++ [
            rust
          ] ++ (with pkgs; [
            nodejs_22
            cmake # aws-lc-sys (iroh/rustls crypto) builds its C sources with CMake
            pkg-config
            binaryen # wasm-opt, for building hApp/zome wasm
            shared-mime-info
            gsettings-desktop-schemas
          ]);

          # Environment for building and running the Tauri desktop app with the
          # nix-provided webkit. Shared verbatim by both shells.
          desktopHook = ''
            # getrandom 0.3 (in the zome dependency tree) refuses to build for
            # wasm32-unknown-unknown unless a backend is chosen; zome wasm never
            # calls OS randomness, so select the "custom" backend (same as the
            # previous darksoil dev shell did).
            export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='--cfg getrandom_backend="custom"'

            # TLS for the nix webkit (glib-networking's GIO module). Additive on
            # purpose: GIO_MODULE_DIR would override the module search path for
            # every GLib app launched from this shell.
            export GIO_EXTRA_MODULES=${pkgs.glib-networking}/lib/gio/modules
            # webkitgtk >= 2.44 requires a working EGL display in its web process
            # (DMA-BUF renderer + Skia) and aborts with EGL_BAD_PARAMETER without
            # one. nixpkgs' libglvnd only searches /run/opengl-driver for EGL
            # vendor drivers — a NixOS-only path — so on other distros the nix
            # dev shell finds no GPU driver and the webview dies blank. Supply a
            # vendor list: the host's native drivers first (host binaries run
            # from this shell behave exactly as outside it), then nixpkgs Mesa,
            # which nix-linked binaries fall back to (llvmpipe on NVIDIA;
            # can drive AMD/Intel GPUs directly) after failing to dlopen the
            # host's driver. NixOS hosts skip this and keep /run/opengl-driver.
            if [ ! -e /run/opengl-driver ] && [ -z "$__EGL_VENDOR_LIBRARY_FILENAMES" ] && [ -z "$__EGL_VENDOR_LIBRARY_DIRS" ]; then
              export __EGL_VENDOR_LIBRARY_DIRS=/etc/glvnd/egl_vendor.d:/usr/share/glvnd/egl_vendor.d:${pkgs.mesa}/share/glvnd/egl_vendor.d
            fi
            # GTK schema lookup for the nix webkit; GSETTINGS_SCHEMAS_PATH is
            # filled by the glib setup hook from the schemas in `packages`.
            export XDG_DATA_DIRS=$GSETTINGS_SCHEMAS_PATH:$XDG_DATA_DIRS
          '';
        in
        {
          devShells.default = pkgs.mkShell {
            packages = commonPackages;
            buildInputs = tauriDeps;
            shellHook = desktopHook + ''
              export PS1='\[\033[1;35m\][volla-dev:\w]\$\[\033[0m\] '
            '';
          };

          devShells.androidDev = pkgs.mkShell {
            packages = commonPackages ++ [ androidSdk ] ++ (with pkgs; [
              cargo-ndk # build Rust -> Android jniLibs
              jdk17 # Gradle
            ]);
            buildInputs = tauriDeps;
            shellHook = desktopHook + ''
              export ANDROID_HOME="${androidHome}"
              export ANDROID_SDK_ROOT="${androidHome}"
              export ANDROID_NDK="${ndkHome}"
              export ANDROID_NDK_ROOT="${ndkHome}"
              export ANDROID_NDK_HOME="${ndkHome}"
              export NDK_HOME="${ndkHome}"

              # cargo-ndk exports plain CC/CXX/AR pointing at the NDK clang, which
              # also hijacks *host* compiles (build scripts, proc-macro deps). The
              # HOST_* variants take precedence in the `cc` crate for host-targeted
              # units, so host builds keep the host toolchain even under
              # `cargo ndk`.
              export HOST_CC=gcc
              export HOST_CXX=g++
              export HOST_AR=ar

              export PS1='\[\033[1;35m\][volla-android:\w]\$\[\033[0m\] '
            '';
          };
        };
    };
}
