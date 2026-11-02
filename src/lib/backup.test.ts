import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import * as backup from "./backup";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("previews a selected file without staging or relaunching, then restores those same bytes", async () => {
  const file = new File([new Uint8Array([0, 16, 255])], "selected.compassbackup");
  const getFile = vi.fn().mockResolvedValue(file);
  const picker = vi.fn().mockResolvedValue([{ getFile }]);
  vi.stubGlobal("window", { showOpenFilePicker: picker });
  vi.mocked(invoke).mockResolvedValue(undefined);

  const result = await backup.previewBackup();
  expect(result.ok).toBe(true);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("validate_backup", { hex: "0010ff" });
  expect(relaunch).not.toHaveBeenCalled();
  if (!result.ok) throw new Error(result.error);
  expect(result.preview).toMatchObject({ filename: file.name, sizeBytes: file.size });

  // Even if the file on disk changes after preview, restore must use the validated snapshot.
  getFile.mockResolvedValue(new File(["changed"], file.name));
  expect(await backup.restoreBackup(result.preview)).toEqual({ ok: true });
  expect(invoke).toHaveBeenLastCalledWith("stage_backup_restore", { hex: "0010ff" });
  expect(picker).toHaveBeenCalledTimes(1);
  expect(getFile).toHaveBeenCalledTimes(1);
  expect(relaunch).toHaveBeenCalledTimes(1);
});

it("treats cancellation of the fallback file chooser as cancellation", async () => {
  const input = {
    type: "", accept: "", files: null,
    onchange: null as null | (() => void),
    oncancel: null as null | (() => void),
    click() { this.oncancel?.(); },
  };
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { createElement: () => input });
  expect(await backup.previewBackup()).toEqual({ ok: false, error: "cancelled" });
  expect(invoke).not.toHaveBeenCalled();
  expect(relaunch).not.toHaveBeenCalled();
}, 1000);

it("does not relaunch when native staging rejects the snapshot", async () => {
  vi.mocked(invoke).mockRejectedValue("backup database integrity check failed");
  expect(await backup.restoreBackup({ filename: "chosen.compassbackup", sizeBytes: 1, hex: "00" })).toEqual({
    ok: false, error: "backup database integrity check failed", staged: false,
  });
  expect(relaunch).not.toHaveBeenCalled();
});

it("returns native validation errors without staging or relaunching", async () => {
  vi.stubGlobal("window", { showOpenFilePicker: async () => [{ getFile: async () => new File(["invalid"], "invalid.compassbackup") }] });
  vi.mocked(invoke).mockRejectedValue("backup file is truncated or corrupt");
  expect(await backup.previewBackup()).toEqual({ ok: false, error: "backup file is truncated or corrupt" });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(vi.mocked(invoke).mock.calls[0][0]).toBe("validate_backup");
  expect(relaunch).not.toHaveBeenCalled();
});

it("returns file-read errors before calling native validation", async () => {
  vi.stubGlobal("window", { showOpenFilePicker: async () => [{ getFile: async () => ({
    arrayBuffer: async () => { throw new Error("file could not be read"); },
  }) }] });
  expect(await backup.previewBackup()).toEqual({ ok: false, error: "file could not be read" });
  expect(invoke).not.toHaveBeenCalled();
});

it("handles native picker cancellation without validation", async () => {
  vi.stubGlobal("window", { showOpenFilePicker: async () => { throw new DOMException("cancelled", "AbortError"); } });
  expect(await backup.previewBackup()).toEqual({ ok: false, error: "cancelled" });
  expect(invoke).not.toHaveBeenCalled();
});

it("validates a file selected through the fallback input", async () => {
  const file = new File([new Uint8Array([1, 255])], "fallback.compassbackup");
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { createElement: () => ({
    files: [file],
    onchange: null as null | (() => void),
    click() { this.onchange?.(); },
  }) });
  vi.mocked(invoke).mockResolvedValue(undefined);
  const result = await backup.previewBackup();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.preview.filename).toBe(file.name);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("validate_backup", { hex: "01ff" });
  expect(relaunch).not.toHaveBeenCalled();
});

it("distinguishes a staged restore when relaunch fails", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(relaunch).mockRejectedValue(new Error("restart unavailable"));
  expect(await backup.restoreBackup({ filename: "chosen.compassbackup", sizeBytes: 1, hex: "00" })).toEqual({
    ok: false, error: "restart unavailable", staged: true,
  });
});
