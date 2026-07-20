import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_DIR, DATA_DIR, EXPORT_DIR, assertPathInside } from "./paths.mjs";
import {
  assertNoUncheckpointedWal,
  inspectExistingDatabaseRole,
  inspectExistingSchemaVersion,
} from "./database-role.mjs";

const RESTORE_CONFIRMATION = "RESTORE_LOCAL_DATABASE";

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeLabel(value) {
  const normalized = String(value || "backup").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 48) || "backup";
}

function checksum(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileState(filePath) {
  const stat = fs.statSync(filePath);
  return { size: stat.size, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, checksum: checksum(filePath) };
}

function assertRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file and not a symbolic link`);
  return stat;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Maintenance directory must be a real directory");
  fs.chmodSync(directory, 0o700);
  return directory;
}

export function replaceDatabaseFileAtomically(sourcePath, dbPath, options = {}) {
  const temporaryPath = path.join(path.dirname(dbPath), `.database-replace-${crypto.randomUUID()}.sqlite`);
  try {
    fs.copyFileSync(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporaryPath, options.mode || 0o600);
    if (options.atime && options.mtime) fs.utimesSync(temporaryPath, options.atime, options.mtime);
    fs.renameSync(temporaryPath, dbPath);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${temporaryPath}${suffix}`, { force: true });
  }
}

function defaultPrivateDirectory(dbPath, projectDirectory, siblingName) {
  const relative = path.relative(path.resolve(DATA_DIR), path.resolve(dbPath));
  const insideProjectData = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return insideProjectData ? projectDirectory : path.join(path.dirname(dbPath), siblingName);
}

export function inspectDatabaseFile(dbPath) {
  assertRegularFile(dbPath, "Database");
  assertNoUncheckpointedWal(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    const tables = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    return {
      ok: integrity.length === 1 && integrity[0] === "ok" && foreignKeys.length === 0,
      integrity,
      foreignKeyViolations: foreignKeys.length,
      tables,
      role: inspectExistingDatabaseRole(dbPath).role,
      schemaVersion: inspectExistingSchemaVersion(dbPath),
      ...fileState(dbPath),
    };
  } finally {
    db.close();
  }
}

export function createDatabaseBackup(dbPath, options = {}) {
  assertRegularFile(dbPath, "Database");
  assertNoUncheckpointedWal(dbPath);
  const directory = ensurePrivateDirectory(options.backupDir || defaultPrivateDirectory(dbPath, BACKUP_DIR, "backups"));
  const base = path.basename(dbPath).replace(/\.(?:sqlite|db)$/i, "") || "database";
  const destination = path.join(
    directory,
    `${base}-${safeLabel(options.reason)}-${timestamp(options.now)}-${crypto.randomUUID().slice(0, 8)}.sqlite`,
  );
  fs.copyFileSync(dbPath, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  const inspection = inspectDatabaseFile(destination);
  if (!inspection.ok) {
    fs.rmSync(destination, { force: true });
    throw new Error("Database backup failed integrity verification");
  }
  return { path: destination, ...inspection };
}

export function verifyRestoreCandidate(dbPath, backupPath) {
  assertRegularFile(dbPath, "Target database");
  assertRegularFile(backupPath, "Backup database");
  const target = inspectDatabaseFile(dbPath);
  const backup = inspectDatabaseFile(backupPath);
  if (!backup.ok) throw new Error("Backup database failed integrity verification");
  if (target.role !== backup.role) throw new Error(`Backup role mismatch: target is ${target.role}, backup is ${backup.role}`);

  const stagedPath = path.join(path.dirname(dbPath), `.restore-dry-run-${crypto.randomUUID()}.sqlite`);
  try {
    fs.copyFileSync(backupPath, stagedPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagedPath, 0o600);
    const staged = inspectDatabaseFile(stagedPath);
    if (!staged.ok || staged.checksum !== backup.checksum) throw new Error("Restore dry-run copy did not match the backup");
    return { ok: true, target, backup, staged };
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${stagedPath}${suffix}`, { force: true });
  }
}

export function restoreDatabase(dbPath, backupPath, options = {}) {
  if (options.confirm !== RESTORE_CONFIRMATION) {
    throw new Error(`Restore requires --confirm=${RESTORE_CONFIRMATION}`);
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${dbPath}${suffix}`)) throw new Error("Stop the dashboard and close database clients before restoring");
  }
  const dryRun = verifyRestoreCandidate(dbPath, backupPath);
  const safetyBackup = createDatabaseBackup(dbPath, { reason: "pre-restore", backupDir: options.backupDir });
  const previous = fileState(dbPath);
  const stagedPath = path.join(path.dirname(dbPath), `.restore-${crypto.randomUUID()}.sqlite`);
  try {
    fs.copyFileSync(backupPath, stagedPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagedPath, 0o600);
    const staged = inspectDatabaseFile(stagedPath);
    if (!staged.ok || staged.checksum !== dryRun.backup.checksum) throw new Error("Staged restore does not match the verified backup");
    fs.chmodSync(stagedPath, previous.mode || 0o600);
    fs.renameSync(stagedPath, dbPath);
    const installed = inspectDatabaseFile(dbPath);
    if (!installed.ok || installed.checksum !== dryRun.backup.checksum) throw new Error("Installed restore does not match the verified backup");
    return { ok: true, safetyBackup, installed };
  } catch (error) {
    replaceDatabaseFileAtomically(safetyBackup.path, dbPath, { mode: previous.mode || 0o600 });
    throw error;
  } finally {
    fs.rmSync(stagedPath, { force: true });
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function exportDatabase(dbPath, options = {}) {
  const inspection = inspectDatabaseFile(dbPath);
  if (!inspection.ok) throw new Error("Database export requires a valid database");
  const directory = ensurePrivateDirectory(options.exportDir || defaultPrivateDirectory(dbPath, EXPORT_DIR, "exports"));
  const outputPath = options.outputPath
    ? assertPathInside(directory, options.outputPath, "database export path")
    : path.join(directory, `local-data-export-${timestamp(options.now)}-${crypto.randomUUID().slice(0, 8)}.json`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = {};
    for (const table of inspection.tables) {
      tables[table] = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY rowid`).all();
    }
    const payload = {
      format: "job-search-operations-dashboard-export-v1",
      exportedAt: (options.now || new Date()).toISOString(),
      database: { role: inspection.role, schemaVersion: inspection.schemaVersion, checksum: inspection.checksum },
      tables,
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(outputPath, 0o600);
    return { path: outputPath, checksum: checksum(outputPath), tableCount: Object.keys(tables).length };
  } finally {
    db.close();
  }
}

export { RESTORE_CONFIRMATION };
