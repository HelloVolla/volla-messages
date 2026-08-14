//! In-place coordinator-zome updates for the bundled happ.
//!
//! The unified tauri-plugin-holochain runtime installs apps but has no update
//! path. When a release ships a changed happ into an existing data dir, this
//! module diffs the bundled happ's coordinator zomes against the installed
//! DNAs (via the conductor's admin websocket on the runtime's admin port) and
//! updates the changed ones, then restarts the app so the new zomes are live.
//! A persisted hash of the last-installed bundle gates the (expensive) diff to
//! the first run after an upgrade.
//!
//! The diff/update algorithm is ported from darksoil-studio's
//! tauri-plugin-holochain (crates/holochain_runtime/src/happs/update.rs).

use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use holochain_client::AdminWebsocket;
use holochain_conductor_api::CellInfo;
use holochain_types::prelude::{
    AppBundle, AppManifest, CoordinatorBundle, CoordinatorManifest, DnaBundle, DnaFile, RoleName,
    UpdateCoordinatorsPayload, ZomeDependency, ZomeManifest,
};
use mr_bundle::{Bundle, ResourceBytes, ResourceIdentifier};
use sha2::Digest;
use tauri_plugin_holochain::Runtime;

fn hash_path(data_dir: &Path, app_id: &str) -> PathBuf {
    data_dir.join("happ-hashes").join(app_id)
}

fn bundle_hash(bundle_bytes: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(bundle_bytes))
}

/// Persist the hash of the happ bundle that is now installed, so later runs
/// can tell whether the bundled happ changed. Called after a fresh install and
/// after a successful update.
pub fn record_installed_bundle_hash(
    data_dir: &Path,
    app_id: &str,
    bundle_bytes: &[u8],
) -> Result<()> {
    let path = hash_path(data_dir, app_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bundle_hash(bundle_bytes))?;
    Ok(())
}

fn stored_bundle_hash(data_dir: &Path, app_id: &str) -> Option<String> {
    std::fs::read_to_string(hash_path(data_dir, app_id)).ok()
}

/// If the bundled happ differs from the one recorded at install time, update
/// the installed app's coordinator zomes to match and record the new hash.
pub async fn update_app_if_necessary(
    runtime: &Runtime,
    data_dir: &Path,
    app_id: &str,
    bundle_bytes: &[u8],
) -> Result<()> {
    if stored_bundle_hash(data_dir, app_id).as_deref() == Some(bundle_hash(bundle_bytes).as_str()) {
        return Ok(());
    }

    let bundle = AppBundle::unpack(bundle_bytes).context("Failed to unpack bundled happ")?;
    let admin_ws = AdminWebsocket::connect((Ipv4Addr::LOCALHOST, runtime.admin_port()), None)
        .await
        .map_err(|e| anyhow!("Failed to connect to the admin websocket: {e:?}"))?;

    update_app(&admin_ws, app_id.to_string(), bundle).await?;

    record_installed_bundle_hash(data_dir, app_id, bundle_bytes)?;
    Ok(())
}

/// Diff the new bundle's coordinator zomes against each installed cell's DNA
/// definition and issue `UpdateCoordinators` for the changed (or new) ones,
/// then restart the app if anything changed.
async fn update_app(admin_ws: &AdminWebsocket, app_id: String, bundle: AppBundle) -> Result<()> {
    log::info!("Checking whether the coordinator zomes for app {app_id} need to be updated");

    let apps = admin_ws
        .list_apps(None)
        .await
        .map_err(|e| anyhow!("Failed to list apps: {e:?}"))?;

    let mut app = apps
        .into_iter()
        .find(|app| app.installed_app_id.eq(&app_id))
        .ok_or(anyhow!("App not found: {app_id}"))?;

    let new_dna_files = resolve_dna_files(bundle).await?;

    let mut updated = false;

    for (role_name, new_dna_file) in new_dna_files {
        let cells = app
            .cell_info
            .swap_remove(&role_name)
            .ok_or(anyhow!("Role {role_name} not found in app {app_id}"))?;

        for cell in cells {
            let mut zomes: Vec<ZomeManifest> = Vec::new();
            let mut resources: Vec<(String, ResourceBytes)> = Vec::new();

            let cell_id = match cell {
                CellInfo::Provisioned(c) => c.cell_id.clone(),
                CellInfo::Cloned(c) => c.cell_id.clone(),
                CellInfo::Stem(_c) => {
                    continue;
                }
            };
            let old_dna_def = admin_ws
                .get_dna_definition(cell_id.clone())
                .await
                .map_err(|e| anyhow!("Failed to get dna definition: {e:?}"))?;

            for (zome_name, coordinator_zome) in new_dna_file.dna_def().coordinator_zomes.iter() {
                let deps = coordinator_zome
                    .clone()
                    .erase_type()
                    .dependencies()
                    .to_vec();
                let dependencies: Vec<ZomeDependency> = deps
                    .into_iter()
                    .map(|name| ZomeDependency { name })
                    .collect();

                let changed = match old_dna_def
                    .coordinator_zomes
                    .iter()
                    .find(|(zome, _)| zome.eq(&zome_name))
                {
                    Some(old_zome_def) => {
                        old_zome_def.1.clone().erase_type().zome_hash()
                            != coordinator_zome.clone().erase_type().zome_hash()
                    }
                    None => true,
                };

                if changed {
                    log::info!("Updating coordinator zome {zome_name} for role {role_name}");
                    zomes.push(ZomeManifest {
                        name: zome_name.clone(),
                        hash: None,
                        path: zome_name.0.to_string(),
                        dependencies: Some(dependencies),
                    });
                    let wasm = new_dna_file.get_wasm_for_zome(zome_name)?;
                    resources.push((zome_name.0.to_string(), wasm.clone().code().to_vec().into()));
                }
            }

            if !zomes.is_empty() {
                let source: CoordinatorBundle =
                    Bundle::new(CoordinatorManifest { zomes }, resources)?.into();
                let req = UpdateCoordinatorsPayload {
                    cell_id,
                    source: holochain_types::prelude::CoordinatorSource::Bundle(Box::new(source)),
                };

                admin_ws
                    .update_coordinators(req)
                    .await
                    .map_err(|e| anyhow!("Failed to update coordinators: {e:?}"))?;
                updated = true;
            }
        }
    }

    if updated {
        // Restart the app so the new coordinator zomes are live.
        admin_ws
            .disable_app(app_id.clone())
            .await
            .map_err(|e| anyhow!("Failed to disable app: {e:?}"))?;
        admin_ws
            .enable_app(app_id.clone())
            .await
            .map_err(|e| anyhow!("Failed to re-enable app: {e:?}"))?;
        log::info!("Updated app {app_id:?}");
    }

    Ok(())
}

async fn resolve_dna_files(app_bundle: AppBundle) -> Result<BTreeMap<RoleName, DnaFile>> {
    let mut dna_files: BTreeMap<RoleName, DnaFile> = BTreeMap::new();

    let bundle = app_bundle.into_inner();

    for app_role in bundle.manifest().app_roles() {
        if let Some(location) = app_role.dna.path {
            let dna_file = resolve_location(&bundle, &location).await?;
            dna_files.insert(app_role.name.clone(), dna_file);
        }
    }

    Ok(dna_files)
}

async fn resolve_location(
    app_bundle: &Bundle<AppManifest>,
    location: &ResourceIdentifier,
) -> Result<DnaFile> {
    let bytes = app_bundle.get_resource(location).ok_or(anyhow!(
        "Resource {location} not found in bundle {}",
        app_bundle.manifest().app_name()
    ))?;
    let dna_bundle: DnaBundle = mr_bundle::Bundle::unpack(bytes.as_ref())?.into();
    let (dna_file, _original_hash) = dna_bundle.into_dna_file(Default::default()).await?;
    Ok(dna_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_bundle_hash_gates_without_connecting() {
        let dir = tempdir::TempDir::new("happ-update-test").unwrap();
        let bytes = b"not-a-real-bundle";
        record_installed_bundle_hash(dir.path(), "test-app", bytes).unwrap();
        assert_eq!(
            stored_bundle_hash(dir.path(), "test-app").as_deref(),
            Some(bundle_hash(bytes).as_str())
        );
        // A differing bundle must not match the stored hash.
        assert_ne!(
            stored_bundle_hash(dir.path(), "test-app").as_deref(),
            Some(bundle_hash(b"different").as_str())
        );
    }
}
