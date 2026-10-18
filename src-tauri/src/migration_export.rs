//! Read access to the 0.6 -> 0.7 migration export written by `1.0.3`.
//!
//! A 0.7 conductor cannot read a 0.6 conductor database, and `get_version()`
//! buckets the conductor directory by major version, so everything under
//! `holochain/1/` is unreachable from a `2.x` release. Conversation network
//! seeds lived only inside that database, so `1.0.3` copied them out to a
//! version-independent file beside `holochain/`, and this release imports
//! from it.
//!
//! This release only ever reads the export. It must never write it: a fresh
//! 0.7 install starts under a new agent with no conversations, and any export
//! it wrote would replace the user's `1.0.3` export with an empty one before
//! the import had a chance to run.

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

use crate::config::APP_ID;

/// File name of the migration export, inside the `export/` directory.
const EXPORT_FILE_NAME: &str = "migration-export.json";

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

/// Must resolve exactly as `1.0.3` did, or the import will not find the file.
fn export_path(agent: Option<&str>) -> Result<PathBuf, String> {
    // Dev builds of `1.0.3` wrote to `export-dev/` so they could never degrade
    // an installed release's export.
    let dir = if tauri::is_dev() { "export-dev" } else { "export" };

    // A multi-agent dev run (`AGENTS=2`) scoped the filename per agent. A real
    // install has exactly one agent and uses the stable name.
    let file = match (tauri::is_dev(), agent) {
        (true, Some(agent)) => format!("migration-export-{}.json", agent_fragment(agent)),
        _ => EXPORT_FILE_NAME.to_string(),
    };

    Ok(app_root()?.join(dir).join(file))
}

/// Read the migration export, or `None` when there is none to import.
#[tauri::command]
pub fn read_migration_export(agent: Option<String>) -> Result<Option<String>, String> {
    let path = export_path(agent.as_deref())?;

    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}
