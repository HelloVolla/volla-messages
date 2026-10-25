//! Version-independent storage for the 0.6 -> 0.7 migration export.
//!
//! A 0.7 conductor cannot read a 0.6 conductor database, and `get_version()`
//! buckets the conductor directory by major version, so everything under
//! `holochain/1/` becomes unreachable the moment a `2.x` release starts up.
//! Conversation network seeds live only inside that database — they are not
//! cached anywhere in the frontend — so they have to be copied somewhere that
//! survives the bucket change *before* the upgrade happens.
//!
//! This module owns that location. The export sits beside `holochain/`, not
//! inside it, and its path depends on `APP_ID` alone — never on the app
//! version. Both the exporting release and the importing release resolve the
//! same path.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::config::APP_ID;

/// File name of the migration export, inside the `export/` directory.
const EXPORT_FILE_NAME: &str = "migration-export.json";

/// File recording a clone cell that was deliberately enabled to read its
/// membrane proof, and must be disabled again.
const PENDING_ENABLE_FILE_NAME: &str = "pending-enable";

/// Root of the app's own data directory, shared by every release.
///
/// Intentionally stops short of the `holochain/<version>` suffix that
/// `holochain_dir()` appends, since that suffix is exactly what the export has
/// to outlive.
fn app_root() -> Result<PathBuf, String> {
    app_dirs2::app_root(
        app_dirs2::AppDataType::UserData,
        &app_dirs2::AppInfo {
            name: APP_ID,
            author: std::env!("CARGO_PKG_AUTHORS"),
        },
    )
    .map_err(|e| format!("Could not resolve app root: {e}"))
}

/// Filename-safe fragment of an agent key, for dev-only scoping.
fn agent_fragment(agent: &str) -> String {
    agent
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(12)
        .collect()
}

fn export_path(agent: Option<&str>) -> Result<PathBuf, String> {
    // Dev builds run against a throwaway conductor in a temp directory, so
    // their export describes an empty or synthetic account. Keep it out of the
    // directory a real install reads, so running the app in dev can never
    // degrade an installed release's export.
    let dir = if tauri::is_dev() { "export-dev" } else { "export" };

    // A multi-agent dev run (`AGENTS=2`) gives each agent its own conductor but
    // shares this app root, so scope the filename per agent to stop them
    // overwriting each other. A real install has exactly one agent and keeps
    // the stable name, which is what the importing release looks for.
    let file = match (tauri::is_dev(), agent) {
        (true, Some(agent)) => format!("migration-export-{}.json", agent_fragment(agent)),
        _ => EXPORT_FILE_NAME.to_string(),
    };

    Ok(app_root()?.join(dir).join(file))
}

/// Write the migration export, replacing any previous one.
///
/// Writes to a temporary file and renames it into place. A crash or a full disk
/// midway through therefore leaves the previous export intact rather than
/// truncating it — the export is the only copy of data the next major release
/// cannot otherwise reach.
#[tauri::command]
pub fn write_migration_export(contents: String, agent: Option<String>) -> Result<String, String> {
    let path = export_path(agent.as_deref())?;
    write_atomically(&path, contents.as_bytes())?;
    Ok(path.display().to_string())
}

/// Write `bytes` to `path` through a temporary file and a rename, so a crash
/// or a full disk leaves the previous file intact instead of truncating it.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Export path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Export path has no file name".to_string())?;

    ensure_private_dir(dir)?;

    let tmp_path = dir.join(format!("{file_name}.tmp"));
    write_private_file(&tmp_path, bytes)?;
    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Could not replace {}: {e}", path.display()))?;
    Ok(())
}

/// Create `dir` if needed and make it readable by this user only.
///
/// The export holds the user's identity, membership proofs, full message
/// history and images. Other accounts on the same machine have no business
/// reading it. Windows profile directories and Android app storage are already
/// private to the user; Unix data directories are not necessarily.
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Could not restrict {}: {e}", dir.display()))?;
    }
    Ok(())
}

/// Write a file readable by this user only, from the moment it is created.
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    // `mode` only applies when the file is created; tighten a leftover one too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Could not restrict {}: {e}", path.display()))?;
    }
    Ok(())
}

/// A subdirectory of the export directory, e.g. `history` or `images`.
/// Shares the export's dev and per-agent scoping.
fn export_subdir(name: &str, agent: Option<&str>) -> Result<PathBuf, String> {
    let export = export_path(agent)?;
    let dir = export
        .parent()
        .ok_or_else(|| "Export path has no parent directory".to_string())?;
    // Restricted on every lookup, not only when a file is written: a run that
    // finds nothing changed writes nothing, and must not leave a directory
    // created by an earlier release readable.
    ensure_private_dir(dir)?;
    let name = match (tauri::is_dev(), agent) {
        (true, Some(agent)) => format!("{name}-{}", agent_fragment(agent)),
        _ => name.to_string(),
    };
    let subdir = dir.join(name);
    ensure_private_dir(&subdir)?;
    Ok(subdir)
}

/// Network seeds and image hashes come from the frontend and become file
/// names, so anything but a plain identifier is refused rather than allowed
/// to form a path.
fn checked_name<'a>(name: &'a str, what: &str) -> Result<&'a str, String> {
    let valid = !name.is_empty()
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(name)
    } else {
        Err(format!("Refusing unexpected {what} {name:?} as a file name"))
    }
}

/// The history file for a conversation, named after its network seed.
fn history_path(seed: &str, agent: Option<&str>) -> Result<PathBuf, String> {
    let seed = checked_name(seed, "network seed")?;
    Ok(export_subdir("history", agent)?.join(format!("{seed}.json")))
}

const IMAGE_INDEX_FILE_NAME: &str = "index.json";

/// Write the message history of one conversation, replacing the previous one.
#[tauri::command]
pub fn write_history_export(
    seed: String,
    contents: String,
    agent: Option<String>,
) -> Result<String, String> {
    let path = history_path(&seed, agent.as_deref())?;
    write_atomically(&path, contents.as_bytes())?;
    Ok(path.display().to_string())
}

/// Read the exported history of one conversation, or `None` if there is none.
#[tauri::command]
pub fn read_history_export(seed: String, agent: Option<String>) -> Result<Option<String>, String> {
    let path = history_path(&seed, agent.as_deref())?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

fn pending_enable_path(agent: Option<&str>) -> Result<PathBuf, String> {
    let export = export_path(agent)?;
    let dir = export
        .parent()
        .ok_or_else(|| "Export path has no parent directory".to_string())?;

    // Share the export's per-agent scoping so a multi-agent dev run does not
    // have one agent repairing another's cell.
    let suffix = match (tauri::is_dev(), agent) {
        (true, Some(agent)) => format!("-{}", agent_fragment(agent)),
        _ => String::new(),
    };

    Ok(dir.join(format!("{PENDING_ENABLE_FILE_NAME}{suffix}")))
}

/// Record that a clone cell is about to be enabled solely to read its membrane
/// proof, or clear the record once it has been disabled again.
///
/// Archiving a conversation disables its cell, and a disabled cell cannot be
/// zome-called — so reading its proof means briefly enabling it. If the app
/// dies in that window the conversation would silently stay un-archived, so the
/// intent is written to disk first and repaired on the next launch.
#[tauri::command]
pub fn set_pending_enable(cell: Option<String>, agent: Option<String>) -> Result<(), String> {
    let path = pending_enable_path(agent.as_deref())?;

    match cell {
        Some(cell) => {
            let dir = path
                .parent()
                .ok_or_else(|| "Pending-enable path has no parent directory".to_string())?;
            ensure_private_dir(dir)?;
            write_private_file(&path, cell.as_bytes())
        }
        None => match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Could not remove {}: {e}", path.display())),
        },
    }
}

/// The clone cell left enabled by an interrupted proof read, if any.
#[tauri::command]
pub fn get_pending_enable(agent: Option<String>) -> Result<Option<String>, String> {
    let path = pending_enable_path(agent.as_deref())?;

    match fs::read_to_string(&path) {
        Ok(cell) => Ok(Some(cell)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Read the migration export, or `None` when no export has been written yet.
///
/// Used by the exporting release to avoid overwriting a good export with a
/// worse one, and by the importing release to find the data in the first place.
#[tauri::command]
pub fn read_migration_export(agent: Option<String>) -> Result<Option<String>, String> {
    let path = export_path(agent.as_deref())?;

    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Write one exported image, named after its file-storage entry hash.
///
/// Takes the bytes as a raw IPC body rather than JSON: a JSON array spends
/// several bytes per image byte, which matters for photos. The hash and agent
/// travel as `x-image-hash` and `x-agent` headers.
#[tauri::command]
pub fn write_export_image(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the image as raw bytes".to_string());
    };
    let header = |key: &str| {
        request
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let hash = header("x-image-hash").ok_or_else(|| "Missing x-image-hash header".to_string())?;
    let agent = header("x-agent");

    let hash = checked_name(&hash, "image hash")?;
    let path = export_subdir("images", agent.as_deref())?.join(hash);
    write_atomically(&path, bytes)
}

/// Hashes of the images already exported, so a run only adds new ones.
#[tauri::command]
pub fn list_export_images(agent: Option<String>) -> Result<Vec<String>, String> {
    let dir = export_subdir("images", agent.as_deref())?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read {}: {e}", dir.display())),
    };

    Ok(entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name != IMAGE_INDEX_FILE_NAME && !name.ends_with(".tmp"))
        .collect())
}

/// Write the image index: what each exported image is, and which images were
/// left out and why.
#[tauri::command]
pub fn write_image_index(contents: String, agent: Option<String>) -> Result<(), String> {
    let path = export_subdir("images", agent.as_deref())?.join(IMAGE_INDEX_FILE_NAME);
    write_atomically(&path, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempdir::TempDir;

    #[test]
    fn accepts_network_seeds_and_image_hashes_as_file_names() {
        for name in [
            "218dcd9d-4c19-47fa-bdf6-8ee4ae1b8f14",
            "uhCEk1NmHJ2MPm4gVelKbPcshrn3ZUl38EVprEb7FuoUuQI6Wrk1k",
            "uhCEkfWwAdnPAhKW7HploXXvMC0ror3HxkXNiwlXsu3bkb6A_Gt4Z",
        ] {
            assert_eq!(checked_name(name, "test").unwrap(), name);
        }
    }

    #[test]
    fn refuses_names_that_could_form_a_path() {
        let too_long = "a".repeat(129);
        for name in [
            "", ".", "..", "../x", "a/b", "a\\b", "/etc/passwd", "x y", "x\0y", "ü", &too_long,
        ] {
            assert!(checked_name(name, "test").is_err(), "accepted {name:?}");
        }
    }

    #[test]
    fn writes_and_replaces_a_file_atomically() {
        let root = TempDir::new("export").unwrap();
        let path = root.path().join("nested").join("history").join("seed.json");

        write_atomically(&path, b"first").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");

        write_atomically(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");

        // Nothing left over from the temporary-file step.
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec!["seed.json"]);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_file_intact() {
        let root = TempDir::new("export").unwrap();
        let path = root.path().join("migration-export.json");
        write_atomically(&path, b"good export").unwrap();

        // Make the temporary file impossible to create, as a full disk or a
        // crash mid-write would.
        fs::create_dir(root.path().join("migration-export.json.tmp")).unwrap();

        assert!(write_atomically(&path, b"").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"good export");
    }

    #[test]
    fn recovers_from_a_stale_temporary_file() {
        let root = TempDir::new("export").unwrap();
        let path = root.path().join("seed.json");
        fs::write(root.path().join("seed.json.tmp"), b"half written by a crash").unwrap();

        write_atomically(&path, b"complete").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete");
        assert!(!root.path().join("seed.json.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn export_files_are_readable_by_their_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;

        let root = TempDir::new("export").unwrap();
        let dir = root.path().join("history");
        let path = dir.join("seed.json");

        // As an earlier release left them: world-readable.
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_atomically(&path, b"new").unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&path), 0o600);

        // A newly created directory and file are private from the start.
        let fresh = root.path().join("images").join("hash");
        write_atomically(&fresh, b"bytes").unwrap();
        assert_eq!(mode(fresh.parent().unwrap()), 0o700);
        assert_eq!(mode(&fresh), 0o600);
    }
}
