use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_holochain::{HcAuthConfig, HcAuthStatus, HolochainExt};

use crate::config::APP_ID;
use crate::device_admission::{Admission, AdmissionStatus, DeviceAdmission};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub fn auth_config(auth_server_url: &str) -> HcAuthConfig {
    HcAuthConfig {
        auth_server_url: auth_server_url.trim_end_matches('/').to_string(),
        auth_bootstrap: true,
        auth_relay: true,
    }
}

pub async fn run<R: Runtime>(app: AppHandle<R>, auth_server_url: &'static str) {
    let admission = app.state::<DeviceAdmission>();
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => {
            log::error!("device admission: building HTTP client failed: {e}");
            return;
        }
    };
    let mut registered = false;

    loop {
        let runtime = match app.holochain().and_then(|plugin| plugin.try_runtime()) {
            Ok(runtime) => runtime,
            Err(e) => {
                log::error!("device admission: conductor unavailable: {e:?}");
                return;
            }
        };
        let current = Admission {
            status: AdmissionStatus::Checking,
            device_key: runtime.hc_auth_agent_key().map(|key| key.to_string()),
            device_code: runtime.hc_auth_raw_ed25519_b64url(),
        };

        let status = match runtime.hc_auth_status() {
            HcAuthStatus::Authorized => AdmissionStatus::Approved,
            HcAuthStatus::Pending => AdmissionStatus::Pending,
            HcAuthStatus::NotRegistered if !registered => {
                match register(&client, auth_server_url, current.device_code.as_deref()).await {
                    Ok(()) => {
                        registered = true;
                        admission.publish(&app, current.clone());
                        restart(&app, &runtime, &admission, &current).await;
                        continue;
                    }
                    Err(e) => {
                        log::warn!("device admission: registration failed: {e}");
                        AdmissionStatus::Unavailable
                    }
                }
            }
            HcAuthStatus::NotRegistered | HcAuthStatus::Blocked => AdmissionStatus::Denied,
            HcAuthStatus::Failed(reason) => {
                log::warn!("device admission: {reason}");
                AdmissionStatus::Unavailable
            }
        };

        admission.publish(&app, current.with_status(status));
        if status == AdmissionStatus::Approved {
            return;
        }

        tokio::select! {
            _ = tokio::time::sleep(recheck_interval(status)) => {}
            _ = admission.recheck_requested() => {}
        }
        admission.publish(&app, current.clone());
        restart(&app, &runtime, &admission, &current).await;
    }
}

fn recheck_interval(status: AdmissionStatus) -> Duration {
    match status {
        AdmissionStatus::Pending => Duration::from_secs(120),
        AdmissionStatus::Denied => Duration::from_secs(600),
        _ => Duration::from_secs(60),
    }
}

async fn register(
    client: &reqwest::Client,
    auth_server_url: &str,
    device_code: Option<&str>,
) -> Result<(), String> {
    let device_code = device_code.ok_or("no device key")?;
    let res = client
        .put(format!(
            "{}/request-auth/{device_code}",
            auth_server_url.trim_end_matches('/')
        ))
        .json(&json!({
            "app": APP_ID,
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("request-auth returned {}", res.status()))
    }
}

async fn restart<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &tauri_plugin_holochain::Runtime,
    admission: &DeviceAdmission,
    current: &Admission,
) {
    let result = async {
        let restarted = runtime
            .restart_with_hc_auth(super::network_config(), true, true)
            .await?;
        restarted.enable_app(APP_ID.into()).await?;
        app.holochain()?.swap_runtime(restarted).await?;
        anyhow::Ok(())
    }
    .await;
    if let Err(e) = result {
        log::error!("device admission: conductor restart failed: {e:?}");
        admission.publish(app, current.with_status(AdmissionStatus::Unavailable));
    }
}
