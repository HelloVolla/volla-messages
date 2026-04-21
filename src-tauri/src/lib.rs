mod builder;
use builder::setup_builder;
mod config;

// `VOLLA_RUST_LOG` accepts env_logger-style directives. A bare level
// sets the base filter; `module=level` pairs override per-module.
// Unset -> Warn for everything. Examples:
//   VOLLA_RUST_LOG=info
//   VOLLA_RUST_LOG=warn,kitsune2_transport_reticulum=debug,rns_transport=debug
//   VOLLA_RUST_LOG=debug
fn build_log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let mut plugin = tauri_plugin_log::Builder::default().level(log::LevelFilter::Warn);

    if let Ok(spec) = std::env::var("VOLLA_RUST_LOG") {
        for directive in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            match directive.split_once('=') {
                Some((module, level)) => {
                    if let Ok(lf) = level.trim().parse::<log::LevelFilter>() {
                        plugin = plugin.level_for(module.trim().to_string(), lf);
                    }
                }
                None => {
                    if let Ok(lf) = directive.parse::<log::LevelFilter>() {
                        plugin = plugin.level(lf);
                    }
                }
            }
        }
    }

    plugin.build()
}

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
        .plugin(build_log_plugin());
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_sharesheet::init());
    }

    setup_builder(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
