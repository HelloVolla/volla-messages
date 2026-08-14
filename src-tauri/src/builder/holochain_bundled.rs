use crate::config::{APP_ID, HAPP_BUNDLE_BYTES};
#[cfg(target_os = "android")]
use crate::android_barcode_scanner;
use crate::happ_update;
use holochain_types::prelude::{AppBundleSource, InstallAppPayload};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Builder, Listener, Manager, Runtime};
use tauri_plugin_holochain::{
    vec_to_locked, HolochainExt, HolochainPluginConfig, NetworkConfig, WindowOptions, EVENT_READY,
    EVENT_SETUP_FAILED,
};
use uuid::Uuid;

pub const BOOTSTRAP_URL: &'static str = "https://relay2.volla.tech/";

pub const IROH_RELAY_URL: &'static str = "https://iroh-relay.volla.tech/";

pub fn setup_builder<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .plugin(tauri_plugin_holochain::init(
            vec_to_locked(vec![]),
            HolochainPluginConfig::new(holochain_dir(), network_config()),
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let handle_fail = app.handle().clone();
            app.handle().listen(EVENT_SETUP_FAILED, move |event| {
                log::error!("holochain setup failed: {}", event.payload());
                handle_fail.exit(1);
            });
            app.handle().listen(EVENT_READY, move |_event| {
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    setup(handle.clone()).await.expect("Failed to setup");

                    let mut window_options = WindowOptions::default();
                    #[cfg(desktop)]
                    {
                        window_options.title = Some(String::from("Volla Messages"));
                    }

                    let main_window = handle
                        .holochain()
                        .expect("Failed to get holochain")
                        .main_window_builder(String::from("main"), Some(APP_ID.into()), window_options)
                        .await
                        .expect("Failed to build window")
                        .build()
                        .expect("Failed to open main window");

                    // Open devtools for debugging
                    main_window.open_devtools();

                    #[cfg(desktop)]
                    {
                        // After it's done, close the splashscreen and display the main window
                        if let Some(splashscreen_window) = handle.get_webview_window("splashscreen")
                        {
                            let _ = splashscreen_window.close();
                        }
                    }

                    // Load barcode scanner plugin if on supported platform
                    // It is necessary to load this after we have created the new 'main' webview
                    //  which will be calling into it
                    #[cfg(target_os = "android")]
                    handle
                        .plugin(android_barcode_scanner::init())
                        .expect("Failed to initialize android_barcode_scanner");

                    #[cfg(all(mobile, not(target_os = "android")))]
                    handle
                        .plugin(tauri_plugin_barcode_scanner::init())
                        .expect("Failed to initialize tauri_plugin_barcode_scanner");
                });
            });

            Ok(())
        })
}

// Very simple setup for now:
// - On app start:
//   - If our hApp is not installed, this is the first time the app is opened: install our hApp
//   - If our hApp **is** installed, check whether the bundled hApp changed since the
//     last run and update the coordinator zomes if it did
async fn setup<R: Runtime>(handle: AppHandle<R>) -> anyhow::Result<()> {
    let runtime = handle.holochain()?.runtime();

    if !runtime.is_app_installed(APP_ID.into()).await? {
        runtime
            .setup_app(
                InstallAppPayload {
                    source: AppBundleSource::Bytes(HAPP_BUNDLE_BYTES.to_vec().into()),
                    agent_key: None,
                    installed_app_id: Some(APP_ID.into()),
                    // Generate a random network seed so every user has their own private DHT for storing contacts
                    network_seed: Some(Uuid::new_v4().to_string()),
                    roles_settings: Some(HashMap::new()),
                    ignore_genesis_failure: false,
                    restore_from_dht: false,
                },
                true,
            )
            .await?;
        happ_update::record_installed_bundle_hash(&holochain_dir(), APP_ID, HAPP_BUNDLE_BYTES)?;
    } else {
        happ_update::update_app_if_necessary(&runtime, &holochain_dir(), APP_ID, HAPP_BUNDLE_BYTES)
            .await?;
    }
    Ok(())
}

fn network_config() -> NetworkConfig {
    let mut config = NetworkConfig::default();
    config.bootstrap_url = url2::url2!("{}", BOOTSTRAP_URL);
    config.relay_url = url2::url2!("{}", IROH_RELAY_URL);
    config
}

fn holochain_dir() -> PathBuf {
    if tauri::is_dev() {
        #[cfg(target_os = "android")]
        {
            app_dirs2::app_root(
                app_dirs2::AppDataType::UserCache,
                &app_dirs2::AppInfo {
                    name: APP_ID,
                    author: std::env!("CARGO_PKG_AUTHORS"),
                },
            )
            .expect("Could not get the UserCache directory")
        }
        #[cfg(not(target_os = "android"))]
        {
            let tmp_dir =
                tempdir::TempDir::new(APP_ID).expect("Could not create temporary directory");

            // Convert `tmp_dir` into a `Path`, destroying the `TempDir`
            // without deleting the directory.
            let tmp_path = tmp_dir.into_path();
            tmp_path
        }
    } else {
        app_dirs2::app_root(
            app_dirs2::AppDataType::UserData,
            &app_dirs2::AppInfo {
                name: APP_ID,
                author: std::env!("CARGO_PKG_AUTHORS"),
            },
        )
        .expect("Could not get app root")
        .join("holochain")
        .join(get_version())
    }
}

fn get_version() -> String {
    let semver = std::env!("CARGO_PKG_VERSION");

    if semver.starts_with("0.0.") {
        return semver.to_string();
    }

    if semver.starts_with("0.") {
        let v: Vec<&str> = semver.split(".").collect();
        return format!("{}.{}", v[0], v[1]);
    }
    let v: Vec<&str> = semver.split(".").collect();
    return format!("{}", v[0]);
}
