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

use anyhow::Context;

use holochain_types::prelude::{
    AgentPubKey, CellId, DnaHash, ExternIO, Timestamp, ZomeCallParams,
};
use lair_keystore_api::config::LairServerConfigInner;
use tauri_plugin_holochain::Runtime;
use uuid::Uuid;

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

/// Holds the secrets that decrypt `store_file`; a store without it is unreadable.
const LAIR_CONFIG: &str = "lair-keystore-config.yaml";

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
///
/// An error means the conductor must not start: it would create a fresh
/// keystore in `holochain_dir`, and once that exists the carry is never tried
/// again, so the 1.x identity would be lost for good.
pub fn carry_keystore_forward(holochain_dir: &Path) -> anyhow::Result<()> {
    let outcome = try_carry_keystore_forward(holochain_dir)
        .context("could not carry the 1.x keystore forward")?;
    let _ = CARRY_OUTCOME.set(outcome);
    Ok(())
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
        CarryOutcome::UnreadableLegacyKeystore => format!(
            "the 1.x keystore at {} has no {LAIR_CONFIG} lair can read, so its keys \
             cannot be read; starting fresh",
            source.display()
        ),
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
    /// A 1.x store without a readable lair config to decrypt it; the
    /// conductor starts fresh.
    UnreadableLegacyKeystore,
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
    let config = match fs::read(source.join(LAIR_CONFIG)) {
        Ok(bytes) => LairServerConfigInner::from_bytes(&bytes).ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let Some(config) = config else {
        // Without a config lair can read, no one can ever decrypt this store
        // (1.x could not either), so it holds no identity to keep. Carried
        // along, it would stop the new lair from starting at all.
        return Ok(CarryOutcome::UnreadableLegacyKeystore);
    };

    let staging = staging_dir(destination)?;
    if staging.exists() {
        // Left over from an interrupted attempt. It is our own copy, never the
        // source, so it is safe to discard.
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    restrict_to_owner(&staging)?;

    // 0.6 ran lair from `<data>/keystore/`; the 0.7 plugin runs it from
    // `<data>/` directly. Copying into a `keystore/` subdirectory is silently
    // ignored and a fresh keystore is generated instead.
    //
    // A 1.x app still running at the same time (two installs side by side)
    // cannot be detected: its lair runs inside the app with no socket. The
    // copy is still safe: the agent key was written long before, and SQLite
    // falls back to the last consistent state when the WAL does not match.
    copy_dir(source, &staging)?;
    rewrite_lair_config(config, source, &staging, destination)?;
    fs::write(staging.join(CARRIED_MARKER), b"")?;

    fs::rename(&staging, destination)?;
    Ok(CarryOutcome::Carried)
}

/// The agent to install the app under, or `None` for a new agent.
///
/// A new agent costs the user their 1.x identity for good, so it is only
/// chosen when there is no 1.x identity to keep, or lair is confirmed not to
/// hold its key. Any doubt is an error instead: the app does not start, and
/// the next launch tries again.
pub async fn agent_to_install_under(
    runtime: &Runtime,
    holochain_dir: &Path,
) -> anyhow::Result<Option<AgentPubKey>> {
    let Some(agent_key) = carried_agent_key(holochain_dir)? else {
        return Ok(None);
    };

    if keystore_holds_key(runtime, &agent_key).await? {
        log::info!("installing under the carried 1.x agent {agent_key}");
        Ok(Some(agent_key))
    } else {
        log::error!(
            "the carried keystore does not hold the key of the 1.x agent {agent_key}; \
             starting with a new agent"
        );
        Ok(None)
    }
}

/// The 1.x agent named by the export, when the keystore was carried from 1.x.
///
/// `None` when there is no 1.x identity to keep. An export that cannot be read
/// right now is an error, since the next launch may well read it.
fn carried_agent_key(holochain_dir: &Path) -> anyhow::Result<Option<AgentPubKey>> {
    if !holochain_dir.join(CARRIED_MARKER).exists() {
        return Ok(None);
    }

    let contents = match crate::migration_export::read_export(None) {
        Ok(Some(contents)) => contents,
        // Updated straight from a release older than 1.0.3, which wrote no
        // export: nothing names the agent to keep.
        Ok(None) => {
            log::warn!("keystore was carried from 1.x but there is no export naming its agent");
            return Ok(None);
        }
        Err(e) => anyhow::bail!("could not read the migration export: {e}"),
    };

    // Only 1.x writes the export, so a broken one stays broken: waiting for
    // the next launch would keep the app from ever starting.
    match agent_key_from_export(&contents) {
        Ok(key) => Ok(Some(key)),
        Err(e) => {
            log::error!("migration export names no usable agent key: {e}");
            Ok(None)
        }
    }
}

/// Whether lair holds the private key of `agent_key`.
///
/// The runtime offers no way to list lair's keys, so this asks lair to sign
/// with it. Errors unless lair answers for sure.
async fn keystore_holds_key(runtime: &Runtime, agent_key: &AgentPubKey) -> anyhow::Result<bool> {
    let sign = |key: AgentPubKey| async move {
        runtime
            .sign_zome_call(probe_call(key))
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    };

    classify_key_probe(
        sign(runtime.device_agent_key()).await,
        sign(random_agent_key()).await,
        sign(agent_key.clone()).await,
    )
}

/// Decide from three signing attempts whether lair holds a key:
///
/// - `device`: the runtime's own device key, which lair always holds; a
///   failure means lair is not working (locked, say), so it proves nothing.
/// - `unheld`: a random key lair cannot hold; it must fail with lair's "no
///   such key" answer, the one a missing carried key gets too.
/// - `carried`: the key in question.
fn classify_key_probe(
    device: Result<(), String>,
    unheld: Result<(), String>,
    carried: Result<(), String>,
) -> anyhow::Result<bool> {
    if let Err(e) = device {
        anyhow::bail!("lair cannot sign with the device key: {e}");
    }
    let Err(not_held) = unheld else {
        anyhow::bail!("lair signed with a random key, so its answers cannot be trusted");
    };

    // The device key is cached in memory, so it signs even when lair cannot
    // read its database. Then every other key fails alike, with that database
    // error: only lair's own "no such key" answer proves anything.
    anyhow::ensure!(
        not_held.contains(LAIR_KEY_NOT_FOUND),
        "lair could not look up a random key: {not_held}"
    );

    match carried {
        Ok(()) => Ok(true),
        Err(e) if e == not_held => Ok(false),
        Err(e) => anyhow::bail!("lair could not sign with the carried key: {e}"),
    }
}

/// What lair's SQLite store answers for a public key it holds no entry for.
/// Pinned by `real_lair_answers_every_unheld_key_alike`.
const LAIR_KEY_NOT_FOUND: &str = "Query returned no rows";

/// A zome call that is only ever signed, never made: signing looks at nothing
/// but its provenance.
fn probe_call(provenance: AgentPubKey) -> ZomeCallParams {
    ZomeCallParams {
        cell_id: CellId::new(DnaHash::from_raw_32(vec![0; 32]), provenance.clone()),
        provenance,
        zome_name: "probe".into(),
        fn_name: "probe".into(),
        cap_secret: None,
        payload: ExternIO::encode(()).expect("unit always serialises"),
        nonce: [0; 32].into(),
        expires_at: Timestamp::now(),
    }
}

fn random_agent_key() -> AgentPubKey {
    let mut bytes = Uuid::new_v4().as_bytes().to_vec();
    bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    AgentPubKey::from_raw_32(bytes)
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

/// The unix socket lair listens on, or `None` for a named pipe (Windows),
/// which names no directory. Lair's own `get_connection_path` panics on a URL
/// it cannot read; a broken config must not crash startup.
fn unix_socket(config: &LairServerConfigInner) -> anyhow::Result<Option<PathBuf>> {
    if config.connection_url.scheme() != "unix" {
        return Ok(None);
    }
    config.connection_url.to_file_path().map(Some).map_err(|()| {
        anyhow::anyhow!("connectionUrl {} names no absolute path", config.connection_url)
    })
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
        // Follows symlinks, so a linked directory is copied rather than
        // failing the carry on every launch.
        if fs::metadata(&from)?.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }

    Ok(())
}

/// Lair runs with an empty passphrase, so whoever can read the store and its
/// config can read the keys: only the user may enter the directory.
fn restrict_to_owner(dir: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// `lair-keystore-config.yaml` stores absolute paths, so a copied keystore
/// still points at the old directory. Rewrite them to where the keystore will
/// live after the rename — not the staging directory it is assembled in.
///
/// Goes through lair's own config type rather than replacing text: the socket
/// path sits percent-encoded inside `connectionUrl` (macOS's "Application
/// Support" becomes `Application%20Support`), where a plain replace misses it
/// and the new lair would put its socket into the 1.x directory.
fn rewrite_lair_config(
    mut config: LairServerConfigInner,
    source: &Path,
    staging: &Path,
    final_dir: &Path,
) -> anyhow::Result<()> {

    let moved = |file: &Path| -> anyhow::Result<PathBuf> {
        let name = file
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("{} has no file name", file.display()))?;
        Ok(final_dir.join(name))
    };
    config.pid_file = moved(&config.pid_file)?;
    config.store_file = moved(&config.store_file)?;

    if let Some(socket) = unix_socket(&config)? {
        let socket = moved(&socket)?;
        let socket_str = socket
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("{} is not valid UTF-8", socket.display()))?;
        // Keeps the `?k=` server key, which clients check.
        config.connection_url.set_path(socket_str);
        anyhow::ensure!(
            unix_socket(&config)?.as_ref() == Some(&socket),
            "the rewritten connectionUrl {} does not lead to {}",
            config.connection_url,
            socket.display()
        );
    }

    let rewritten = config.to_string();
    anyhow::ensure!(
        !rewritten.contains(source.to_string_lossy().as_ref()),
        "the rewritten lair config still names {}",
        source.display()
    );
    fs::write(staging.join(LAIR_CONFIG), rewritten)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lair_keystore_api::config::get_connection_path;
    use std::collections::BTreeMap;
    use tempdir::TempDir;

    /// A 1.x `keystore/` directory as lair 0.6 leaves it, including the runtime
    /// files of a lair that is still running.
    fn legacy_keystore(root: &Path) -> PathBuf {
        let keystore = root.join("holochain").join("1").join("keystore");
        fs::create_dir_all(&keystore).unwrap();
        fs::write(keystore.join("store_file"), b"encrypted store").unwrap();
        fs::write(keystore.join("store_file-wal"), b"write-ahead log").unwrap();
        fs::write(keystore.join(LAIR_CONFIG), lair_config(&keystore).to_string()).unwrap();
        fs::write(keystore.join("socket"), b"").unwrap();
        fs::write(keystore.join("pid_file"), b"4242").unwrap();
        keystore
    }

    /// The config lair writes for a keystore in `dir`. Lair 0.6 and 0.7 share
    /// the format.
    fn lair_config(dir: &Path) -> LairServerConfigInner {
        use lair_keystore_api::dependencies::hc_seed_bundle::PwHashLimits;

        let runtime = tokio::runtime::Runtime::new().unwrap();
        // Minimum limits only make the passphrase hashing fast.
        PwHashLimits::Minimum
            .with_exec(|| {
                runtime.block_on(LairServerConfigInner::new(
                    dir,
                    tauri_plugin_holochain::vec_to_locked(vec![]),
                ))
            })
            .unwrap()
    }

    fn read_config(dir: &Path) -> LairServerConfigInner {
        LairServerConfigInner::from_bytes(&fs::read(dir.join(LAIR_CONFIG)).unwrap()).unwrap()
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

        assert_config_moved(&source, &destination);

        // No staging directory left behind, and the 1.x keystore is untouched.
        assert!(!staging_dir(&destination).unwrap().exists());
        assert_eq!(snapshot(&source), before);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&destination).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_symlinked_directory_in_the_keystore() {
        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        let elsewhere = root.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("note"), b"kept").unwrap();
        std::os::unix::fs::symlink(&elsewhere, source.join("linked")).unwrap();
        let destination = root.path().join("holochain").join("2");

        assert_eq!(carry_keystore(&source, &destination).unwrap(), CarryOutcome::Carried);
        assert_eq!(fs::read(destination.join("linked").join("note")).unwrap(), b"kept");
    }

    /// Config paths point at the final directory, never the source or
    /// staging, and everything else in the config is kept.
    fn assert_config_moved(source: &Path, destination: &Path) {
        let before = read_config(source);
        let after = read_config(destination);

        assert_eq!(after.pid_file, destination.join("pid_file"));
        assert_eq!(after.store_file, destination.join("store_file"));
        assert_eq!(get_connection_path(&after.connection_url), destination.join("socket"));
        assert_eq!(after.connection_url.query(), before.connection_url.query());
        assert_eq!(after.get_server_pub_key().unwrap(), before.get_server_pub_key().unwrap());
        assert_eq!(after.database_salt, before.database_salt);
        assert_eq!(after.runtime_secrets_salt, before.runtime_secrets_salt);

        let text = fs::read_to_string(destination.join(LAIR_CONFIG)).unwrap();
        assert!(!text.contains(&source.display().to_string()));
        assert!(!text.contains("keystore-staging"));
    }

    /// macOS keeps app data under "Application Support". Inside
    /// `connectionUrl` the space is percent-encoded, which a plain text
    /// replace of the path never matched.
    #[test]
    fn moves_the_socket_out_of_a_directory_with_a_space() {
        let root = TempDir::new("carry").unwrap();
        let app_root = root.path().join("Library").join("Application Support").join("app");
        let source = legacy_keystore(&app_root);
        let destination = app_root.join("holochain").join("2");
        assert!(read_config(&source).connection_url.as_str().contains("Application%20Support"));

        assert_eq!(carry_keystore(&source, &destination).unwrap(), CarryOutcome::Carried);

        assert_config_moved(&source, &destination);
        assert!(!read_config(&destination)
            .connection_url
            .as_str()
            .contains("holochain/1"));
    }

    /// Windows lair listens on a named pipe, which names no directory.
    #[test]
    fn keeps_a_named_pipe_connection_url_as_it_is() {
        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        let mut config = read_config(&source);
        config.connection_url = format!(
            "named-pipe:\\\\.\\pipe\\abc?{}",
            config.connection_url.query().unwrap()
        )
        .parse()
        .unwrap();
        fs::write(source.join(LAIR_CONFIG), config.to_string()).unwrap();
        let destination = root.path().join("holochain").join("2");

        assert_eq!(carry_keystore(&source, &destination).unwrap(), CarryOutcome::Carried);

        let after = read_config(&destination);
        assert_eq!(after.connection_url, config.connection_url);
        assert_eq!(after.store_file, destination.join("store_file"));
    }

    /// The config holds the secrets that decrypt `store_file`. Without it the
    /// store can never be read, and carried along it would keep the new lair
    /// from starting.
    #[test]
    fn starts_fresh_when_the_legacy_keystore_has_no_config() {
        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        fs::remove_file(source.join(LAIR_CONFIG)).unwrap();
        let destination = root.path().join("holochain").join("2");

        assert_eq!(
            carry_keystore(&source, &destination).unwrap(),
            CarryOutcome::UnreadableLegacyKeystore
        );
        assert!(!destination.exists());
    }

    /// 1.x parsed it with the same type, so it could not open this store
    /// either.
    #[test]
    fn starts_fresh_when_lair_cannot_parse_the_legacy_config() {
        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        fs::write(source.join(LAIR_CONFIG), b"not: [a lair config").unwrap();
        let destination = root.path().join("holochain").join("2");

        assert_eq!(
            carry_keystore(&source, &destination).unwrap(),
            CarryOutcome::UnreadableLegacyKeystore
        );
        assert!(!destination.exists());
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

    /// A failed copy must leave no data directory behind: the conductor would
    /// otherwise start on an empty keystore there, and no later launch would
    /// try the carry again.
    #[cfg(unix)]
    #[test]
    fn a_failed_copy_leaves_nothing_behind_and_the_next_launch_retries() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempDir::new("carry").unwrap();
        let source = legacy_keystore(root.path());
        let destination = root.path().join("holochain").join("2");
        let unreadable = source.join("store_file-wal");
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&unreadable).is_ok() {
            // Running as root: permissions cannot make the copy fail.
            return;
        }

        assert!(carry_keystore(&source, &destination).is_err());
        assert!(!destination.exists());

        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(carry_keystore(&source, &destination).unwrap(), CarryOutcome::Carried);
        assert_eq!(fs::read(destination.join("store_file-wal")).unwrap(), b"write-ahead log");
        assert!(!staging_dir(&destination).unwrap().exists());
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
        assert_eq!(carried_agent_key(root.path()).unwrap(), None);
    }

    fn random_key_bytes() -> [u8; 32] {
        let mut bytes = [0; 32];
        bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        bytes
    }

    const NOT_HELD: &str = r#"Lair(OneErr { error: "Query returned no rows" })"#;

    fn not_held() -> Result<(), String> {
        Err(NOT_HELD.to_string())
    }

    #[test]
    fn the_carried_key_is_held_when_lair_signs_with_it() {
        assert!(classify_key_probe(Ok(()), not_held(), Ok(())).unwrap());
    }

    #[test]
    fn the_carried_key_is_missing_only_when_lair_says_so_as_for_an_unheld_key() {
        assert!(!classify_key_probe(Ok(()), not_held(), not_held()).unwrap());
    }

    #[test]
    fn any_other_signing_error_is_not_proof_the_key_is_missing() {
        let other = Err("Lair(OneErr { error: \"database is locked\" })".to_string());
        assert!(classify_key_probe(Ok(()), not_held(), other).is_err());
    }

    #[test]
    fn a_database_error_for_every_uncached_key_is_not_proof_the_key_is_missing() {
        // The device key signs from lair's memory cache while the store
        // itself cannot be read, so both other keys fail with the same error.
        let broken = || Err("Lair(OneErr { error: \"database disk image is malformed\" })".into());
        assert!(classify_key_probe(Ok(()), broken(), broken()).is_err());
    }

    #[test]
    fn a_locked_keystore_is_not_proof_the_key_is_missing() {
        // Locked, lair gives every key the same error, so the carried key
        // would look exactly like an unheld one. The device key exposes it.
        let locked = || Err("Lair(OneErr { error: \"KeystoreLocked\" })".to_string());
        assert!(classify_key_probe(locked(), locked(), locked()).is_err());
    }

    #[test]
    fn a_keystore_signing_with_any_key_is_not_trusted() {
        assert!(classify_key_probe(Ok(()), Ok(()), not_held()).is_err());
    }

    /// Pins the lair behaviour `classify_key_probe` relies on, against the
    /// real lair the app ships: a held key signs, and every key lair does not
    /// hold gets the very same error.
    #[tokio::test(flavor = "multi_thread")]
    async fn real_lair_answers_every_unheld_key_alike() {
        use holochain_keystore::lair_keystore::spawn_lair_keystore_in_proc;
        use std::sync::Arc;

        let root = TempDir::new("lair").unwrap();
        let passphrase = tauri_plugin_holochain::vec_to_locked(vec![]);
        let config = root.path().join("lair-keystore-config.yaml");
        let keystore = spawn_lair_keystore_in_proc(&config, passphrase)
            .await
            .unwrap();
        let lair = keystore.lair_client();
        let held = lair.new_seed("held".into(), None, false).await.unwrap();

        let sign = |key: [u8; 32]| {
            let lair = lair.clone();
            async move {
                lair.sign_by_pub_key(key.into(), None, Arc::from(&b"probe"[..]))
                    .await
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
        };
        let random = random_key_bytes;

        // The held key stands in for the device key: lair holds both.
        let held_key = *held.ed25519_pub_key.0;
        let held_carried = sign(held_key).await;
        let unheld_carried = sign(random()).await;
        // Pins the answer `classify_key_probe` requires for an unheld key.
        assert!(unheld_carried.as_ref().unwrap_err().contains(LAIR_KEY_NOT_FOUND));
        assert!(classify_key_probe(sign(held_key).await, sign(random()).await, held_carried)
            .unwrap());
        assert!(!classify_key_probe(sign(held_key).await, sign(random()).await, unheld_carried)
            .unwrap());
    }

    /// The whole carry against real lairs: a keystore written exactly as 1.x
    /// wrote it (lair 0.6.3 in process, empty passphrase) still signs as the
    /// 1.x agent once carried and opened by the lair 2.x ships.
    #[tokio::test(flavor = "multi_thread")]
    async fn lair_07_signs_as_the_agent_of_a_carried_06_keystore() {
        use holochain_keystore::lair_keystore::spawn_lair_keystore_in_proc;
        use lair_keystore_06::dependencies::lair_keystore_api as lair_06;
        use lair_keystore_06::dependencies::sodoken as sodoken_06;
        use std::sync::{Arc, Mutex};

        let root = TempDir::new("carry").unwrap();
        let source = root.path().join("holochain").join("1").join("keystore");
        fs::create_dir_all(&source).unwrap();

        // As the 1.x plugin's `spawn_lair_keystore_in_proc` did.
        let agent_key = {
            let passphrase = Arc::new(Mutex::new(sodoken_06::LockedArray::from(vec![])));
            let config = lair_06::prelude::PwHashLimits::Minimum
                .with_exec(|| {
                    lair_06::config::LairServerConfigInner::new(&source, passphrase.clone())
                })
                .await
                .unwrap();
            fs::write(source.join(LAIR_CONFIG), config.to_string()).unwrap();
            let store = lair_keystore_06::create_sql_pool_factory(
                &config.store_file,
                &config.database_salt,
            );
            let keystore = lair_06::in_proc_keystore::InProcKeystore::new(
                Arc::new(config),
                store,
                passphrase,
            )
            .await
            .unwrap();
            let lair = keystore.new_client().await.unwrap();
            let seed = lair.new_seed("agent".into(), None, false).await.unwrap();
            *seed.ed25519_pub_key.0
        };

        let destination = root.path().join("holochain").join("2");
        assert_eq!(carry_keystore(&source, &destination).unwrap(), CarryOutcome::Carried);

        let keystore = spawn_lair_keystore_in_proc(
            &destination.join(LAIR_CONFIG),
            tauri_plugin_holochain::vec_to_locked(vec![]),
        )
        .await
        .unwrap();
        let lair = keystore.lair_client();
        let sign = |key: [u8; 32]| {
            let lair = lair.clone();
            async move {
                lair.sign_by_pub_key(key.into(), None, Arc::from(&b"probe"[..]))
                    .await
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
        };

        let device = lair.new_seed("device".into(), None, false).await.unwrap();
        let device_key = *device.ed25519_pub_key.0;
        assert!(classify_key_probe(
            sign(device_key).await,
            sign(random_key_bytes()).await,
            sign(agent_key).await
        )
        .unwrap());
        // The new lair runs from the new directory, not the 1.x one.
        assert!(destination.join("socket").exists());
        assert!(!source.join("socket").exists());
    }

    #[test]
    fn the_probe_call_is_signed_as_the_given_agent() {
        let key = random_agent_key();
        let call = probe_call(key.clone());
        assert_eq!(call.provenance, key);
        assert_eq!(call.cell_id.agent_pubkey(), &key);
        assert!(call.serialize_and_hash().is_ok());
        assert_ne!(random_agent_key(), random_agent_key());
    }
}
