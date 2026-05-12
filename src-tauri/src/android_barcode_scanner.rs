use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(feature = "holochain_service")]
const PLUGIN_IDENTIFIER: &str = "com.volla.messages";

#[cfg(all(feature = "holochain_bundled", not(feature = "holochain_service")))]
const PLUGIN_IDENTIFIER: &str = "com.volla.messages.bundled";

pub struct BarcodeScanner<R: Runtime>(PluginHandle<R>);

pub trait BarcodeScannerExt<R: Runtime> {
    fn barcode_scanner(&self) -> &BarcodeScanner<R>;
}

impl<R: Runtime, T: Manager<R>> BarcodeScannerExt<R> for T {
    fn barcode_scanner(&self) -> &BarcodeScanner<R> {
        self.state::<BarcodeScanner<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("barcode-scanner")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "ZxingScannerPlugin")?;
            app.manage(BarcodeScanner(handle));
            Ok(())
        })
        .build()
}
