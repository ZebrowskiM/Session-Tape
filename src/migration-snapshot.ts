import { closeSync, fsyncSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function verifySnapshot(path: string, version: number): void {
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = copy.prepare("PRAGMA integrity_check(1)").get();
    if (integrity?.integrity_check !== "ok") throw new Error("The snapshot failed SQLite's integrity check.");
    if (copy.prepare("PRAGMA user_version").get()?.user_version !== version) {
      throw new Error("The snapshot has an unexpected schema version.");
    }
    if (copy.prepare("PRAGMA foreign_key_check").get()) {
      throw new Error("The snapshot contains a broken record reference.");
    }
  } finally { copy.close(); }
}

// The migration connection holds BEGIN IMMEDIATE throughout the copy and schema upgrade.
// A separate reader can include committed WAL pages while that write lock excludes changes.
export function saveMigrationSnapshot(sourcePath: string, version: number): string {
  const destination = sourcePath + ".before-v" + version + "-upgrade.sqlite";
  const pending = destination + ".partial";
  try {
    // A previous process may have stopped while writing the staging database.
    rmSync(pending + "-journal", { force: true });
    rmSync(pending, { force: true });
    closeSync(openSync(pending, "wx", 0o600));
    const reader = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      reader.exec("PRAGMA synchronous = FULL");
      reader.prepare("VACUUM INTO ?").run(pending);
    } finally { reader.close(); }

    verifySnapshot(pending, version);
    renameSync(pending, destination);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(destination), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return destination;
  } catch (error) {
    // Keep the original failure if the same filesystem error also prevents cleanup.
    try { rmSync(pending, { force: true }); } catch { /* retried on the next upgrade */ }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not save and verify the pre-upgrade snapshot at ${destination}.\n${reason}`, { cause: error });
  }
}
