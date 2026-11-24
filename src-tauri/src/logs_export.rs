//! Hand the app's log files to the user, so a problem can be reported without
//! digging through hidden folders (or, on Android, using adb).
//!
//! The log plugin keeps the current file and one archived file (lib.rs), at
//! most 10 MB together. They are joined into one text, oldest first, behind a
//! short header that tells support which build wrote them. Saving is left to
//! the UI's save dialog, which also handles Android's content:// locations.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

/// All log files, oldest first, joined into one text for the user to save.
///
/// `exported_at` comes from the UI, so the header needs no date library.
#[tauri::command]
pub fn read_logs(app: tauri::AppHandle, exported_at: String) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let files = log_files_oldest_first(&dir)
        .map_err(|e| format!("could not list the logs in {}: {e}", dir.display()))?;

    let mut contents = Vec::with_capacity(files.len());
    for path in files {
        let bytes =
            fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        contents.push((name, bytes));
    }

    let header = header(&app.package_info().version.to_string(), &exported_at);
    Ok(join_logs(&header, &contents))
}

fn header(version: &str, exported_at: &str) -> String {
    let variant = if cfg!(feature = "holochain_service") {
        " (Lite: Holochain's own logs are in the service app and not included)"
    } else {
        ""
    };
    format!(
        "Volla Messages logs\n\
         Version: {version}{variant}\n\
         System: {} {}\n\
         Install: {}\n\
         Exported: {exported_at}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        crate::app_update::install_kind(),
    )
}

/// The `.log` files in `dir`, the oldest first. None when there is no folder
/// yet: nothing has been logged.
fn log_files_oldest_first(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "log") && entry.file_type()?.is_file() {
            files.push((entry.metadata()?.modified()?, path));
        }
    }
    files.sort();
    Ok(files.into_iter().map(|(_, path)| path).collect())
}

fn join_logs(header: &str, files: &[(String, Vec<u8>)]) -> String {
    let mut text = header.to_string();
    if files.is_empty() {
        text.push_str("\n(no log files found)\n");
    }
    for (name, bytes) in files {
        text.push_str(&format!("\n===== {name} =====\n"));
        text.push_str(&String::from_utf8_lossy(bytes));
        if !text.ends_with('\n') {
            text.push('\n');
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};
    use tempdir::TempDir;

    fn write_with_age(dir: &Path, name: &str, contents: &str, age_secs: u64) {
        let path = dir.join(name);
        fs::write(&path, contents).unwrap();
        let modified = SystemTime::now() - Duration::from_secs(age_secs);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
    }

    #[test]
    fn lists_only_log_files_oldest_first() {
        let dir = TempDir::new("logs").unwrap();
        write_with_age(dir.path(), "Volla Messages.log", "current", 0);
        write_with_age(dir.path(), "Volla Messages_2026-11-24_10-00-00.log", "archived", 600);
        write_with_age(dir.path(), "notes.txt", "not a log", 1200);

        let names: Vec<_> = log_files_oldest_first(dir.path())
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            ["Volla Messages_2026-11-24_10-00-00.log", "Volla Messages.log"]
        );
    }

    #[test]
    fn a_missing_log_folder_means_no_logs_yet() {
        let dir = TempDir::new("logs").unwrap();
        assert!(log_files_oldest_first(&dir.path().join("logs")).unwrap().is_empty());
    }

    #[test]
    fn joins_the_files_under_the_header_in_order() {
        let files = vec![
            ("old.log".to_string(), b"first line".to_vec()),
            ("new.log".to_string(), b"second line\n".to_vec()),
        ];
        let text = join_logs("HEADER\n", &files);
        assert_eq!(
            text,
            "HEADER\n\n===== old.log =====\nfirst line\n\n===== new.log =====\nsecond line\n"
        );
    }

    #[test]
    fn says_so_when_there_is_nothing_to_export() {
        assert_eq!(join_logs("HEADER\n", &[]), "HEADER\n\n(no log files found)\n");
    }

    #[test]
    fn keeps_lines_that_are_not_valid_utf8() {
        let files = vec![("a.log".to_string(), vec![b'o', b'k', 0xff, b'\n'])];
        assert!(join_logs("H\n", &files).contains("ok\u{fffd}"));
    }

    #[test]
    fn the_header_names_the_build() {
        let header = header("1.0.6", "2026-11-24T10:00:00Z");
        assert!(header.contains("Version: 1.0.6"));
        assert!(header.contains("Exported: 2026-11-24T10:00:00Z"));
        assert!(header.contains(std::env::consts::OS));
    }
}
