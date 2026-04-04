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
                .level_for("holochain", log::LevelFilter::Info)
                .level_for("holochain_p2p", log::LevelFilter::Debug)
                .level_for("holochain_runtime", log::LevelFilter::Info)
                .level_for("tauri_plugin_holochain", log::LevelFilter::Debug)
                .level_for("kitsune2_gossip", log::LevelFilter::Debug)
                .level_for("kitsune2_dht", log::LevelFilter::Debug)
                .level_for("kitsune2_core", log::LevelFilter::Debug)
                .level_for("kitsune2_api", log::LevelFilter::Debug)
                .level_for("kitsune2_bootstrap_client", log::LevelFilter::Debug)
                .level_for("kitsune2_transport_iroh", log::LevelFilter::Info)
                .level_for("iroh", log::LevelFilter::Warn)
                .build(),
        );
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_sharesheet::init());
    }

    setup_builder(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
