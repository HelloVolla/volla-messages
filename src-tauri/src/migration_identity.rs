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

    if holochain_dir.exists() {
        return Ok(format!("{} already exists; keystore left as is", holochain_dir.display()));
    }

    let source = crate::migration_export::app_root_dir()
        .map_err(anyhow::Error::msg)?
        .join("holochain")
        .join(LEGACY_BUCKET)
        .join("keystore");
    if !source.join("store_file").exists() {
        return Ok(format!("no 1.x keystore at {}; starting fresh", source.display()));
    }

    let staging = staging_dir(holochain_dir)?;
    if staging.exists() {
        // Left over from an interrupted attempt. It is our own copy, never the
        // source, so it is safe to discard.
        fs::remove_dir_all(&staging)?;
    }

    // 0.6 ran lair from `<data>/keystore/`; the 0.7 plugin runs it from
    // `<data>/` directly. Copying into a `keystore/` subdirectory is silently
    // ignored and a fresh keystore is generated instead.
    copy_dir(&source, &staging)?;
    rewrite_lair_config(&source, &staging, holochain_dir)?;
    fs::write(staging.join(CARRIED_MARKER), b"")?;

    fs::rename(&staging, holochain_dir)?;

    Ok(format!(
        "carried the 1.x keystore from {} into {}",
        source.display(),
        holochain_dir.display()
    ))
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

    let encoded = serde_json::from_str::<serde_json::Value>(&contents)
        .ok()?
        .get("agentPubKeyB64")?
        .as_str()?
        .to_string();

    match AgentPubKey::try_from(encoded.clone()) {
        Ok(key) => Some(key),
        Err(e) => {
            log::error!("migration export has an invalid agent key {encoded}: {e:?}");
            None
        }
    }
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
