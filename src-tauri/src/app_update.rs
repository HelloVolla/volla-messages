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

/// Where a release's updater manifest lives. Each release, pre-releases
/// included, carries its own `latest.json`, so the app installs exactly the
/// release it found — not whatever GitHub currently calls "latest".
const RELEASE_MANIFEST_URL: &str =
    "https://github.com/HelloVolla/volla-messages/releases/download/{tag}/latest.json";

/// Download, verify and install the release `tag`, then restart into it.
///
/// The caller must have flushed the migration export first: after the restart
/// the new version runs, and a 2.x release can no longer write it.
#[cfg(desktop)]
#[tauri::command]
pub async fn install_desktop_update(app: tauri::AppHandle, tag: String) -> Result<(), String> {
    install_and_restart(&app, &tag).await.map_err(|e| {
        log::error!("[update] updating to {tag} failed: {e}");
        e
    })
}

#[cfg(desktop)]
async fn install_and_restart(app: &tauri::AppHandle, tag: &str) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    // The tag comes from the UI and becomes part of a URL: a plain version tag
    // only, never something that could point the updater elsewhere.
    let valid = tag.len() <= 64
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid {
        return Err(format!("Refusing unexpected release tag {tag:?}"));
    }
    let endpoint = tauri::Url::parse(&RELEASE_MANIFEST_URL.replace("{tag}", &tag))
        .map_err(|e| e.to_string())?;

    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?;
    if let Some(target) = windows_update_target() {
        builder = builder.target(target);
    }
    let update = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Release {tag} offers no update for this installation"))?;

    log::info!("[update] installing {}", update.version);
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // Windows never gets here: its installer ends this process and reopens
    // the app itself.
    //
    // `app.restart()` starts the new version only once the exit has finished,
    // but the Holochain plugin ends the process itself while exiting, so that
    // never happened and the app just closed. Start the new version now; it
    // waits until this process is gone before touching the data.
    match relaunch_after_exit(app) {
        Ok(()) => log::info!("[update] installed {}; restarting", update.version),
        Err(e) => log::error!("[update] installed {}, but could not restart: {e}", update.version),
    }
    app.exit(0);
    Ok(())
}

/// Passed to the version started after an update, with this process's id.
///
/// Every later release must honour it (`wait_for_previous_instance`), 2.x
/// included: a version that ignores it starts while this one is still
/// shutting down, and both use the same app and WebView data for a moment.
const WAIT_FOR_PID_ARG: &str = "--volla-wait-for-pid=";

/// How long a new version waits for the old one to exit. The Holochain plugin
/// gives its shutdown 3 seconds and then ends the process, so this is ample.
#[cfg(unix)]
const WAIT_FOR_PREVIOUS_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

/// Start the newly installed version, telling it to wait for this process.
#[cfg(desktop)]
fn relaunch_after_exit(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    // The AppImage file rather than the binary inside its temporary mount,
    // which disappears with this process.
    let binary = tauri::process::current_binary(&app.env()).map_err(|e| e.to_string())?;
    std::process::Command::new(&binary)
        .args(relaunch_args(std::env::args_os().skip(1), std::process::id()))
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", binary.display()))?;
    Ok(())
}

/// This process's arguments for the new version, plus the one telling it
/// which process to wait for (replacing any left from an earlier update).
#[cfg(any(desktop, test))]
fn relaunch_args(
    current: impl Iterator<Item = std::ffi::OsString>,
    pid: u32,
) -> Vec<std::ffi::OsString> {
    current
        .filter(|arg| !arg.to_string_lossy().starts_with(WAIT_FOR_PID_ARG))
        .chain(std::iter::once(format!("{WAIT_FOR_PID_ARG}{pid}").into()))
        .collect()
}

/// If an update started this process, wait until the old version has exited:
/// two copies opening the same Holochain data at once could damage it. Call
/// first thing at start-up.
pub fn wait_for_previous_instance() {
    let Some(pid) = waited_for_pid(std::env::args_os()) else {
        return;
    };
    #[cfg(unix)]
    {
        let deadline = std::time::Instant::now() + WAIT_FOR_PREVIOUS_LIMIT;
        while process_alive(pid) {
            if std::time::Instant::now() >= deadline {
                // Still running: better not to start than to share its data.
                // Logging is not set up yet; stderr still reaches the journal.
                eprintln!("[update] previous version (pid {pid}) is still running; not starting");
                std::process::exit(1);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// `args_os`, because `args` panics on arguments that are not UTF-8, and this
/// runs on every start. Only a real process id: `kill` treats 0 and negative
/// values as whole process groups.
fn waited_for_pid(args: impl Iterator<Item = std::ffi::OsString>) -> Option<u32> {
    args.filter_map(|arg| arg.to_str()?.strip_prefix(WAIT_FOR_PID_ARG)?.parse().ok())
        .filter(|pid| (1..=i32::MAX as u32).contains(pid))
        .last()
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // Signal 0 only checks whether the process exists. EPERM means it does,
    // but belongs to someone else.
    // SAFETY: kill with signal 0 sends nothing.
    let exists = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
    exists || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Which Windows installer to update with: the one this copy came from.
///
/// The updater would pick it itself if the bundler had stamped the bundle type
/// into the binary, but the CLI we build with (2.5) does not, so it falls back
/// to `windows-x86_64` (the NSIS installer). Running the NSIS installer over an
/// MSI install leaves two copies side by side. The MSI installs per machine
/// under Program Files; our NSIS installer installs per user, never there.
#[cfg(desktop)]
fn windows_update_target() -> Option<&'static str> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let exe = exe.to_string_lossy().to_lowercase();
    let per_machine = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|dir| dir.to_string_lossy().to_lowercase())
        .any(|dir| !dir.is_empty() && exe.starts_with(&dir));
    Some(if per_machine {
        "windows-x86_64-msi"
    } else {
        "windows-x86_64-nsis"
    })
}

#[cfg(mobile)]
#[tauri::command]
pub async fn install_desktop_update(tag: String) -> Result<(), String> {
    let _ = tag;
    Err("In-app installation is only available on desktop".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn the_new_version_gets_this_process_id_once() {
        let args = vec![
            OsString::from("--some-flag"),
            OsString::from(format!("{WAIT_FOR_PID_ARG}111")),
        ];
        assert_eq!(
            relaunch_args(args.into_iter(), 222),
            vec![OsString::from("--some-flag"), OsString::from(format!("{WAIT_FOR_PID_ARG}222"))]
        );
    }

    #[test]
    fn only_a_process_started_by_an_update_waits() {
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>().into_iter();
        assert_eq!(waited_for_pid(args(&["volla_messages"])), None);
        assert_eq!(waited_for_pid(args(&["volla_messages", "--volla-wait-for-pid=42"])), Some(42));
        assert_eq!(waited_for_pid(args(&["volla_messages", "--volla-wait-for-pid=abc"])), None);
        // Not process ids `kill` would treat as a single process.
        assert_eq!(waited_for_pid(args(&["volla_messages", "--volla-wait-for-pid=0"])), None);
        assert_eq!(waited_for_pid(args(&["volla_messages", "--volla-wait-for-pid=4294967295"])), None);
    }

    #[cfg(unix)]
    #[test]
    fn ignores_arguments_that_are_not_utf8() {
        use std::os::unix::ffi::OsStringExt;
        let args = vec![OsString::from_vec(vec![0xff, 0xfe]), OsString::from("--volla-wait-for-pid=7")];
        assert_eq!(waited_for_pid(args.into_iter()), Some(7));
    }

    #[cfg(unix)]
    #[test]
    fn tells_a_running_process_from_one_that_has_exited() {
        assert!(process_alive(std::process::id()));

        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!process_alive(pid));
    }
}
