import { readable } from "svelte/store";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AdmissionStatus =
  | "disabled"
  | "checking"
  | "approved"
  | "pending"
  | "denied"
  | "unavailable";

export interface DeviceAdmission {
  status: AdmissionStatus;
  deviceKey: string | null;
  deviceCode: string | null;
}

const EVENT_DEVICE_ADMISSION = "volla://device-admission";

const DISABLED: DeviceAdmission = { status: "disabled", deviceKey: null, deviceCode: null };

export function fetchDeviceAdmission(): Promise<DeviceAdmission> {
  if (!isTauri()) return Promise.resolve(DISABLED);
  return invoke<DeviceAdmission>("device_admission");
}

export function recheckDeviceAdmission(): Promise<void> {
  return invoke("recheck_device_admission");
}

export const deviceAdmission = readable<DeviceAdmission>(DISABLED, (set) => {
  if (!isTauri()) return;

  let stopped = false;
  let heard = false;
  let unlisten: (() => void) | undefined;
  listen<DeviceAdmission>(EVENT_DEVICE_ADMISSION, (event) => {
    heard = true;
    set(event.payload);
  }).then((stop) => {
    if (stopped) stop();
    else unlisten = stop;
  });
  fetchDeviceAdmission()
    .then((admission) => {
      if (!heard) set(admission);
    })
    .catch((e) => console.warn("[DeviceAdmission] status unavailable:", e));

  return () => {
    stopped = true;
    unlisten?.();
  };
});
