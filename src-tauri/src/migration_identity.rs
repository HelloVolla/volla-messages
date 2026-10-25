//! Carry the 1.x (Holochain 0.6) agent identity into the 2.x (0.7) conductor.
//!
//! A 0.7 conductor cannot read a 0.6 database, so a `2.x` release starts from
//! an empty conductor and would normally mint a brand new agent key. That is
//! worse than losing message history: membrane proofs name a specific agent,
//! so a new key locks the user out of every private conversation they did not
//! create, permanently.
//!
//! Two things preserve the identity:
//!
//! 1. the lair keystore from `holochain/1/keystore/`, which holds the private
//!    key — lair 0.7.1 opens a store written by 0.6 unchanged; and
//! 2. the agent's public key from the `1.0.3` export, so the app is installed
//!    under that key instead of a newly generated one.
//!
//! Never writes to `holochain/1/`: everything here is a copy.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use holochain_types::prelude::AgentPubKey;

/// Data directory of the last `1.x` release, under `<app_root>/holochain/`.
const LEGACY_BUCKET: &str = "1";

/// Written next to the carried keystore. Its presence means the keystore holds
/// the exported agent's private key, so installing under that key can succeed.
/// Deliberately never removed: it is only consulted before the app is
/// installed, and it records where this install's identity came from.
const CARRIED_MARKER: &str = "keystore-carried-from-1";

/// What `carry_keystore_forward` did. It runs before Tauri initialises the
/// log plugin, when `log` macros are silently dropped, so the outcome is kept
/// here and reported by `report_carry_outcome` once logging works.
static CARRY_OUTCOME: OnceLock<String> = OnceLock::new();

/// A running lair leaves these behind. Copying them would point the new
/// keystore at the old process.
const SKIPPED_FILES: [&str; 2] = ["socket", "pid_file"];

/// Copy the 1.x keystore into `holochain_dir`, if this is the first launch of
/// a 2.x release on a machine that ran 1.x.
///
/// Must run before the Holochain plugin starts lair. Only acts when
/// `holochain_dir` does not exist yet, so an existing 2.x install is never
/// touched. The keystore is assembled in a staging directory and renamed into
/// place in one step, so a crash part-way leaves no `holochain_dir` behind and
/// the next launch simply tries again.
///
/// Skipped in dev builds: they run a throwaway conductor, and giving one the
/// user's real keystore would let a dev run act as the real agent.
pub fn carry_keystore_forward(holochain_dir: &Path) {
    let outcome = match try_carry_keystore_forward(holochain_dir) {
        Ok(outcome) => outcome,
        // Not fatal: the app still starts, just under a new agent.
        Err(e) => format!("could not carry the 1.x keystore forward: {e:?}"),
    };
    let _ = CARRY_OUTCOME.set(outcome);
}

/// Log what `carry_keystore_forward` did. Call once the log plugin is up.
pub fn report_carry_outcome() {
    if let Some(outcome) = CARRY_OUTCOME.get() {
        log::info!("[migration] {outcome}");
    }
}

fn try_carry_keystore_forward(holochain_dir: &Path) -> anyhow::Result<String> {
    if tauri::is_dev() {
        return Ok("dev build; not carrying the 1.x keystore".into());
    }

    let source = crate::migration_export::app_root_dir()
        .map_err(anyhow::Error::msg)?
        .join("holochain")
        .join(LEGACY_BUCKET)
        .join("keystore");

    Ok(match carry_keystore(&source, holochain_dir)? {
        CarryOutcome::AlreadyPresent => {
            format!("{} already exists; keystore left as is", holochain_dir.display())
        }
        CarryOutcome::NoLegacyKeystore => {
            format!("no 1.x keystore at {}; starting fresh", source.display())
        }
        CarryOutcome::Carried => format!(
            "carried the 1.x keystore from {} into {}",
            source.display(),
            holochain_dir.display()
        ),
    })
}

#[derive(Debug, PartialEq)]
enum CarryOutcome {
    /// `destination` already exists: an existing 2.x install, left untouched.
    AlreadyPresent,
    /// No 1.x keystore to carry; the conductor starts fresh.
    NoLegacyKeystore,
    Carried,
}

/// Copy the lair keystore in `source` (a 1.x `keystore/` directory) to become
/// `destination` (a 2.x data directory). Never writes to `source`.
fn carry_keystore(source: &Path, destination: &Path) -> anyhow::Result<CarryOutcome> {
    if destination.exists() {
        return Ok(CarryOutcome::AlreadyPresent);
    }
    if !source.join("store_file").exists() {
        return Ok(CarryOutcome::NoLegacyKeystore);
    }

    let staging = staging_dir(destination)?;
    if staging.exists() {
        // Left over from an interrupted attempt. It is our own copy, never the
        // source, so it is safe to discard.
        fs::remove_dir_all(&staging)?;
    }

    // 0.6 ran lair from `<data>/keystore/`; the 0.7 plugin runs it from
    // `<data>/` directly. Copying into a `keystore/` subdirectory is silently
    // ignored and a fresh keystore is generated instead.
    copy_dir(source, &staging)?;
    rewrite_lair_config(source, &staging, destination)?;
    fs::write(staging.join(CARRIED_MARKER), b"")?;

    fs::rename(&staging, destination)?;
    Ok(CarryOutcome::Carried)
}

/// The agent key to install the app under, or `None` for a new agent.
///
/// Only returns a key when the keystore was carried from 1.x, since installing
/// under a key whose private half lair does not hold cannot succeed.
pub fn carried_agent_key(holochain_dir: &Path) -> Option<AgentPubKey> {
    if !holochain_dir.join(CARRIED_MARKER).exists() {
        return None;
    }

    let contents = match crate::migration_export::read_export(None) {
        Ok(Some(contents)) => contents,
        Ok(None) => {
            log::warn!("keystore was carried from 1.x but there is no export naming its agent");
            return None;
        }
        Err(e) => {
            log::error!("could not read the migration export: {e}");
            return None;
        }
    };

    match agent_key_from_export(&contents) {
        Ok(key) => Some(key),
        Err(e) => {
            log::error!("migration export names no usable agent key: {e}");
            None
        }
    }
}

/// The agent key named by a migration export's JSON.
fn agent_key_from_export(contents: &str) -> Result<AgentPubKey, String> {
    let export: serde_json::Value =
        serde_json::from_str(contents).map_err(|e| format!("not valid JSON: {e}"))?;
    let encoded = export
        .get("agentPubKeyB64")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "no agentPubKeyB64".to_string())?;
    AgentPubKey::try_from(encoded.to_string()).map_err(|e| format!("invalid key {encoded}: {e:?}"))
}

/// Sibling of `holochain_dir`, so the final rename stays on one filesystem.
fn staging_dir(holochain_dir: &Path) -> anyhow::Result<PathBuf> {
    let parent = holochain_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent", holochain_dir.display()))?;
    let name = holochain_dir
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("{} has no file name", holochain_dir.display()))?
        .to_string_lossy();

    fs::create_dir_all(parent)?;
    Ok(parent.join(format!(".{name}-keystore-staging")))
}

fn copy_dir(source: &Path, destination: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(destination)?;

    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIPPED_FILES.iter().any(|skipped| name == *skipped) {
            continue;
        }

        let from = entry.path();
        let to = destination.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }

    Ok(())
}

/// `lair-keystore-config.yaml` stores absolute paths, so a copied keystore
/// still points at the old directory. Rewrite them to where the keystore will
/// live after the rename — not the staging directory it is assembled in.
fn rewrite_lair_config(source: &Path, staging: &Path, final_dir: &Path) -> anyhow::Result<()> {
    let config = staging.join("lair-keystore-config.yaml");
    if !config.exists() {
        return Ok(());
    }

    let contents = fs::read_to_string(&config)?;
    let rewritten = contents.replace(
        source.to_string_lossy().as_ref(),
        final_dir.to_string_lossy().as_ref(),
    );
    fs::write(&config, rewritten)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempdir::TempDir;

    /// A 1.x `keystore/` directory as lair 0.6 leaves it, including the runtime
    /// files of a lair that is still running.
    fn legacy_keystore(root: &Path) -> PathBuf {
        let keystore = root.join("holochain").join("1").join("keystore");
        fs::create_dir_all(&keystore).unwrap();
        let k = keystore.display();
        fs::write(keystore.join("store_file"), b"encrypted store").unwrap();
        fs::write(keystore.join("store_file-wal"), b"write-ahead log").unwrap();
        fs::write(
            keystore.join("lair-keystore-config.yaml"),
            format!(
                "connectionUrl: unix://{k}/socket?k=abc\npidFile: {k}/pid_file\nstoreFile: {k}/store_file\n"
            ),
        )
        .unwrap();
        fs::write(keystore.join("socket"), b"").unwrap();
        fs::write(keystore.join("pid_file"), b"4242").unwrap();
        keystore
    }

    /// Every file under `dir` and its contents, to compare before and after.
    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files.extend(snapshot(&path));
            } else {
                files.insert(path.clone(), fs::read(&path).unwrap());
            }
        }
        files
    }

    #[test]
    fn carries_the_keystore_into_a_fresh_data_directory() {
        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        let before = snapshot(&source);
        let destination = root.path().join("holochain").join("2");

        assert_eq!(carry_keystore(&source, &destination).unwrap(), CarryOutcome::Carried);

        // Lair 0.7 runs from the data directory root, not `keystore/`.
        assert_eq!(fs::read(destination.join("store_file")).unwrap(), b"encrypted store");
        assert_eq!(fs::read(destination.join("store_file-wal")).unwrap(), b"write-ahead log");
        assert!(!destination.join("keystore").exists());
        assert!(destination.join(CARRIED_MARKER).exists());

        // A running lair's socket and pid file must not come along.
        assert!(!destination.join("socket").exists());
        assert!(!destination.join("pid_file").exists());

        // Config paths point at the final directory, never the source or staging.
        let config = fs::read_to_string(destination.join("lair-keystore-config.yaml")).unwrap();
        let dest = destination.display().to_string();
        assert!(config.contains(&format!("unix://{dest}/socket?k=abc")));
        assert!(config.contains(&format!("pidFile: {dest}/pid_file")));
        assert!(config.contains(&format!("storeFile: {dest}/store_file")));
        assert!(!config.contains(&source.display().to_string()));
        assert!(!config.contains("keystore-staging"));

        // No staging directory left behind, and the 1.x keystore is untouched.
        assert!(!staging_dir(&destination).unwrap().exists());
        assert_eq!(snapshot(&source), before);
    }

    #[test]
    fn never_touches_an_existing_data_directory() {
        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        let destination = root.path().join("holochain").join("2");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("store_file"), b"the 2.x keystore").unwrap();
        let before = snapshot(&destination);

        assert_eq!(
            carry_keystore(&source, &destination).unwrap(),
            CarryOutcome::AlreadyPresent
        );
        assert_eq!(snapshot(&destination), before);
        assert!(!staging_dir(&destination).unwrap().exists());
    }

    #[test]
    fn starts_fresh_without_a_legacy_keystore() {
        let root = TempDir::new("carry").unwrap();
        let source = root.path().join("holochain").join("1").join("keystore");
        let destination = root.path().join("holochain").join("2");

        assert_eq!(
            carry_keystore(&source, &destination).unwrap(),
            CarryOutcome::NoLegacyKeystore
        );
        // Nothing created, so the conductor sets up its own keystore.
        assert!(!destination.exists());
    }

    #[test]
    fn retries_cleanly_after_an_interrupted_attempt() {
        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        let destination = root.path().join("holochain").join("2");

        // A crash after staging began, before the rename.
        let staging = staging_dir(&destination).unwrap();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("store_file"), b"half copied").unwrap();
        fs::write(staging.join("stray"), b"left over").unwrap();

        assert_eq!(carry_keystore(&source, &destination).unwrap(), CarryOutcome::Carried);
        assert_eq!(fs::read(destination.join("store_file")).unwrap(), b"encrypted store");
        assert!(!destination.join("stray").exists());
        assert!(!staging.exists());
    }

    #[test]
    fn reads_the_agent_key_from_an_export() {
        // From 32 bytes, so the library computes the location bytes a real key has.
        let key = AgentPubKey::from_raw_32(vec![7; 32]);
        let export = format!(r#"{{"version":1,"agentPubKeyB64":"{key}"}}"#);
        assert_eq!(agent_key_from_export(&export).unwrap(), key);
    }

    #[test]
    fn rejects_an_export_without_a_usable_agent_key() {
        assert!(agent_key_from_export("not json").is_err());
        assert!(agent_key_from_export(r#"{"version":1}"#).is_err());
        assert!(agent_key_from_export(r#"{"agentPubKeyB64":42}"#).is_err());
        assert!(agent_key_from_export(r#"{"agentPubKeyB64":"uhCAknotakey"}"#).is_err());
        // A valid hash of the wrong kind is not an agent key.
        let entry = holochain_types::prelude::EntryHash::from_raw_32(vec![7; 32]);
        assert!(agent_key_from_export(&format!(r#"{{"agentPubKeyB64":"{entry}"}}"#)).is_err());
    }

    #[test]
    fn installs_under_a_new_agent_unless_the_keystore_was_carried() {
        let root = TempDir::new("carry").unwrap();
        // No marker: the conductor's keystore was not carried over, so it
        // cannot hold the exported agent's private key.
        assert_eq!(carried_agent_key(root.path()), None);
    }
}
