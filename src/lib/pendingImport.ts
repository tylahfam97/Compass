/**
 * Module-level shuttle for passing File objects from any page to ImportPage.
 *
 * File objects cannot be serialized through React Router state, so we store
 * them here temporarily.  ImportPage drains the queue on mount.
 */

let _pendingFiles: File[] = [];

export function setPendingImportFiles(files: File[]): void {
  _pendingFiles = files;
}

/** Returns all queued files and clears the queue. */
export function takePendingImportFiles(): File[] {
  const files = _pendingFiles;
  _pendingFiles = [];
  return files;
}
