import path from "node:path";
import process from "node:process";
import {
  RESTORE_CONFIRMATION,
  createDatabaseBackup,
  exportDatabase,
  inspectDatabaseFile,
  restoreDatabase,
  verifyRestoreCandidate,
} from "../lib/database-maintenance.mjs";
import { BACKUP_DIR, assertPathInside, databasePath, runtimeMode } from "../lib/paths.mjs";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const command = process.argv[2] || "inspect";
const mode = runtimeMode(argument("mode") || process.env.APP_MODE || "demo");
if (mode === "onboarding") throw new Error("Database maintenance requires demo or personal mode");
const dbPath = databasePath(mode);

let result;
if (command === "inspect") result = inspectDatabaseFile(dbPath);
else if (command === "backup") result = createDatabaseBackup(dbPath, { reason: argument("reason") || "manual" });
else if (command === "export") result = exportDatabase(dbPath);
else if (command === "restore") {
  const requested = argument("backup");
  if (!requested) throw new Error("Restore requires --backup=<filename>");
  const backupPath = assertPathInside(BACKUP_DIR, path.join(BACKUP_DIR, path.basename(requested)), "backup path");
  if (process.argv.includes("--write")) {
    result = restoreDatabase(dbPath, backupPath, { confirm: argument("confirm") });
  } else {
    result = verifyRestoreCandidate(dbPath, backupPath);
  }
} else {
  throw new Error("Usage: db-maintenance.mjs inspect|backup|export|restore");
}

function publicResult(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(publicResult);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "path" && typeof item === "string") return [key, path.basename(item)];
    return [key, publicResult(item)];
  }));
}

console.log(JSON.stringify(publicResult(result), null, 2));
if (command === "restore" && process.argv.includes("--write")) {
  console.error(`Restore completed only because --confirm=${RESTORE_CONFIRMATION} was supplied.`);
}
