mod builder;
use builder::setup_builder;
mod config;

#[allow(unused_mut)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Warn)
                .level_for("kitsune2_transport_iroh", log::LevelFilter::Debug)
                .level_for("iroh", log::LevelFilter::Debug)
                .level_for("kitsune2_gossip", log::LevelFilter::Info)
                .level_for("kitsune2_core", log::LevelFilter::Info)
                .level_for("holochain_p2p", log::LevelFilter::Info)
                .build(),
        );
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_sharesheet::init());
    }

    log::error!("VOLLA_LOG_TEST_LOG: log crate path");
    tracing::error!("VOLLA_LOG_TEST_TRACING: tracing crate path");

    setup_builder(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
