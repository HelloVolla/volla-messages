//! In-app updates, used to move 1.x users to 2.0.
//!
//! Desktop builds that can replace themselves (Windows, macOS, Linux AppImage)
//! install the update through Tauri's updater, which downloads the build named
//! in the release's `latest.json` and refuses it unless it carries a valid
//! signature from Volla's updater key (the public half is in the desktop
//! config). Everything else — Linux `.deb`, Android, Ubuntu Touch — is updated
//! by its package manager or store, and the UI only links there.
//!
//! Driven from Rust rather than the updater's JS API, so the app needs no extra
//! capabilities, and mobile builds compile without the plugin.

use serde::Serialize;

/// How this copy of the app was installed, which decides how it can update.
#[tauri::command]
pub fn install_kind() -> &'static str {
    if cfg!(target_os = "android") {
        return "android";
    }
    if cfg!(target_os = "windows") {
        return "windows";
    }
    if cfg!(target_os = "macos") {
        return "macos";
    }
    // The Ubuntu Touch launcher (ut/volla-messages.wrapper) sets this. A click
    // package is read-only and updated by OpenStore, so it must never be taken
    // for a self-updating build.
    if std::env::var_os("VOLLA_LAUNCHED").is_some() {
        return "ubuntu-touch";
    }
    // Set by the AppImage runtime; the only Linux package that can replace
    // itself. Anything else on Linux is treated as a `.deb`.
    if std::env::var_os("APPIMAGE").is_some() {
        return "appimage";
    }
    "deb"
}

#[derive(Serialize)]
pub struct DesktopUpdate {
    version: String,
}

/// The update the updater would install, if any.
#[cfg(desktop)]
#[tauri::command]
pub async fn check_desktop_update(app: tauri::AppHandle) -> Result<Option<DesktopUpdate>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| DesktopUpdate { version: u.version }))
}

/// Download, verify and install the update, then restart into it.
///
/// The caller must have flushed the migration export first: after the restart
/// the new version runs, and a 2.x release can no longer write it.
#[cfg(desktop)]
#[tauri::command]
pub async fn install_desktop_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update is available".to_string())?;

    log::info!("[update] installing {}", update.version);
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg(mobile)]
#[tauri::command]
pub async fn check_desktop_update() -> Result<Option<DesktopUpdate>, String> {
    Ok(None)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn install_desktop_update() -> Result<(), String> {
    Err("In-app installation is only available on desktop".to_string())
}
