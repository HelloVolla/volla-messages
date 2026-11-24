import { invoke } from "@tauri-apps/api/core";
import { getIdentifier } from "@tauri-apps/api/app";
import { downloadDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

/** Volla Messages Lite, whose Holochain runs (and logs) in a separate app. */
const LITE_IDENTIFIER = "com.volla.messages";

/**
 * Whether this installation can hand out its logs. A confined Ubuntu Touch app
 * may only write into its own folders, where the user could not reach the file.
 */
export async function canExportLogs(): Promise<boolean> {
  try {
    return (await invoke<string>("install_kind")) !== "ubuntu-touch";
  } catch {
    return false;
  }
}

export async function isLite(): Promise<boolean> {
  try {
    return (await getIdentifier()) === LITE_IDENTIFIER;
  } catch {
    return false;
  }
}

/**
 * Ask where to save, then write all log files there as one text file.
 * Resolves to false when the user cancelled the save dialog.
 *
 * The save dialog also works on Android, where it returns a content:// location
 * the fs plugin can write to.
 */
export async function exportLogs(dialogTitle: string): Promise<boolean> {
  const now = new Date();
  const fileName = `volla-messages-logs-${now.toISOString().slice(0, 10)}.txt`;

  let defaultPath = fileName;
  try {
    defaultPath = `${await downloadDir()}/${fileName}`;
  } catch {
    // No Downloads folder known: suggest the name only.
  }

  const path = await save({
    title: dialogTitle,
    defaultPath,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!path) return false;

  // Read after choosing, so the file also covers the time the dialog was open.
  const text = await invoke<string>("read_logs", { exportedAt: now.toISOString() });
  await writeFile(path, new TextEncoder().encode(text));
  return true;
}
