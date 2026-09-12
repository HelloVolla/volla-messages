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
use std::path::PathBuf;

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
    let dir = path
        .parent()
        .ok_or_else(|| "Export path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Export path has no file name".to_string())?;

    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    let tmp_path = dir.join(format!("{file_name}.tmp"));
    fs::write(&tmp_path, contents.as_bytes())
        .map_err(|e| format!("Could not write {}: {e}", tmp_path.display()))?;
    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Could not replace {}: {e}", path.display()))?;

    Ok(path.display().to_string())
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
            fs::create_dir_all(dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
            fs::write(&path, cell.as_bytes())
                .map_err(|e| format!("Could not write {}: {e}", path.display()))
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
