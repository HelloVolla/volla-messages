use crate::config::{APP_ID, HAPP_BUNDLE_BYTES};
#[cfg(target_os = "android")]
use crate::android_barcode_scanner;
use tauri::{Builder, Runtime};
use tauri_plugin_holochain_service_client::{HolochainServiceClientExt, SetupAppConfig};
use uuid::Uuid;
use std::collections::HashMap;

pub fn setup_builder<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .plugin(tauri_plugin_holochain_service_client::init())
        .setup(|app| {
            app.handle()
                .holochain_service_client()
                .setup_app_main_window(
                    SetupAppConfig {
                        app_id: APP_ID.into(),
                        happ_bundle_bytes: HAPP_BUNDLE_BYTES.into(),
                        network_seed: Uuid::new_v4().to_string(),
                        roles_settings: HashMap::new(),
                        enable_after_install: true
                    }
                )?
                .build()?;

            // Load Android-local barcode scanner plugin
            // It is necessary to load this after we have created the new 'main' webview
            //  which will be calling into it
            #[cfg(target_os = "android")]
            app.handle()
                .plugin(android_barcode_scanner::init())
                .expect("Failed to initialize android_barcode_scanner");

            // Load upstream barcode scanner plugin on non-Android mobile platforms (iOS)
            #[cfg(all(mobile, not(target_os = "android")))]
            app.handle()
                .plugin(tauri_plugin_barcode_scanner::init())
                .expect("Failed to initialize tauri_plugin_barcode_scanner");

            Ok(())
        })
}
