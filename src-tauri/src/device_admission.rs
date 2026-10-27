use std::sync::RwLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Notify;

pub const EVENT_DEVICE_ADMISSION: &str = "volla://device-admission";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AdmissionStatus {
    Disabled,
    Checking,
    Approved,
    Pending,
    Denied,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub status: AdmissionStatus,
    pub device_key: Option<String>,
    pub device_code: Option<String>,
}

impl Admission {
    pub fn with_status(&self, status: AdmissionStatus) -> Self {
        Self {
            status,
            ..self.clone()
        }
    }
}

pub struct DeviceAdmission {
    current: RwLock<Admission>,
    recheck: Notify,
}

impl Default for DeviceAdmission {
    fn default() -> Self {
        Self {
            current: RwLock::new(Admission {
                status: AdmissionStatus::Disabled,
                device_key: None,
                device_code: None,
            }),
            recheck: Notify::new(),
        }
    }
}

impl DeviceAdmission {
    pub fn current(&self) -> Admission {
        self.current.read().expect("poison").clone()
    }

    pub fn publish<R: Runtime>(&self, app: &AppHandle<R>, admission: Admission) {
        *self.current.write().expect("poison") = admission.clone();
        if let Err(e) = app.emit(EVENT_DEVICE_ADMISSION, admission) {
            log::error!("Failed to emit {EVENT_DEVICE_ADMISSION}: {e:?}");
        }
    }

    pub async fn recheck_requested(&self) {
        self.recheck.notified().await
    }
}

#[tauri::command]
pub fn device_admission(state: State<'_, DeviceAdmission>) -> Admission {
    state.current()
}

#[tauri::command]
pub fn recheck_device_admission(state: State<'_, DeviceAdmission>) {
    state.recheck.notify_one();
}
