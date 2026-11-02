import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";

// Minimal File System Access API surface used here - not in lib.dom.d.ts yet in this TS
// target, so declared locally (same approach TransactionsPage's CSV export already relies on
// implicitly via `any`/window casts).
interface FsFileHandleLike {
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}
type ShowSaveFilePicker = (opts: unknown) => Promise<FsFileHandleLike>;
type ShowOpenFilePicker = (opts: unknown) => Promise<FsFileHandleLike[]>;

function bytesToHex(bytes: Uint8Array): string {
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i].toString(16).padStart(2, "0");
  return out.join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

export type BackupResult = { ok: true } | { ok: false; error: string };

const LAST_BACKUP_KEY = "compass_last_backup_at";

/** ISO timestamp of the last successful export, or null if one has never completed on this
 *  device - used to nudge the user if it's been a while since their data was last backed up. */
export function getLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LAST_BACKUP_KEY);
  } catch {
    return null;
  }
}

function backupFilename(): string {
  return `compass-backup-${new Date().toISOString().slice(0, 10)}.compassbackup`;
}

/**
 * Prompts the user to save a self-contained encrypted backup (database + its encryption key
 * in one file) via the browser's native File System Access API - the same mechanism already
 * used for CSV export on the Transactions page, so no extra Tauri plugin/capability is needed.
 * Falls back to a plain download if that API isn't available (e.g. an older WebView).
 */
export async function exportBackup(): Promise<BackupResult> {
  try {
    const hex = await invoke<string>("export_backup_bytes");
    const bytes = hexToBytes(hex);
    const filename = backupFilename();

    const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
    if (picker) {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: "Compass Backup", accept: { "application/octet-stream": [".compassbackup"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    } else {
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
    try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch { /* non-critical */ }
    return { ok: true };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false, error: "cancelled" };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Kept only in memory until confirmation/cancellation; never persist or log backup bytes.
export interface BackupPreview {
  filename: string;
  sizeBytes: number;
  hex: string;
}

type BackupPreviewResult = { ok: true; preview: BackupPreview } | { ok: false; error: string };

/** Select and validate a snapshot without staging a restore or changing live data. */
export async function previewBackup(): Promise<BackupPreviewResult> {
  try {
    const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
    let file: File;
    if (picker) {
      const [handle] = await picker({
        types: [{ description: "Compass Backup", accept: { "application/octet-stream": [".compassbackup"] } }],
      });
      file = await handle.getFile();
    } else {
      file = await new Promise<File>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".compassbackup";
        const cancel = () => reject(new DOMException("No file selected", "AbortError"));
        input.onchange = () => (input.files?.[0] ? resolve(input.files[0]) : cancel());
        input.oncancel = cancel;
        input.click();
      });
    }
    const buf = await file.arrayBuffer();
    const hex = bytesToHex(new Uint8Array(buf));
    await invoke("validate_backup", { hex });
    return { ok: true, preview: { filename: file.name, sizeBytes: file.size, hex } };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false, error: "cancelled" };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Stage the previewed snapshot (revalidated by Rust), then relaunch for the startup swap. */
export async function restoreBackup(preview: BackupPreview): Promise<{ ok: true } | { ok: false; error: string; staged: boolean }> {
  let staged = false;
  try {
    await invoke("stage_backup_restore", { hex: preview.hex });
    staged = true;
    await relaunch();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), staged };
  }
}
