import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";
import {
  RESTORE_CONFIRMATION,
  createDatabaseBackup,
  exportDatabase,
  inspectDatabaseFile,
  restoreDatabase,
  verifyRestoreCandidate,
} from "../lib/database-maintenance.mjs";

function fixture(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const file = path.join(directory, "personal.sqlite");
  initializeDatabase(file, { mode: "personal" });
  return {
    directory,
    file,
    backupDir: path.join(directory, "backups"),
    exportDir: path.join(directory, "exports"),
  };
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function insertJob(file, key) {
  const db = openDatabase(file);
  db.prepare("INSERT INTO jobs (job_key, company_name, title) VALUES (?, 'Example Organization', 'Example Role')").run(key);
  db.close();
}

test("database backup is an owner-only exact copy that passes integrity checks", () => {
  const value = fixture("database-backup");
  try {
    insertJob(value.file, "before-backup");
    const sourceChecksum = checksum(value.file);
    const backup = createDatabaseBackup(value.file, { backupDir: value.backupDir, reason: "test" });
    assert.equal(backup.ok, true);
    assert.equal(backup.checksum, sourceChecksum);
    assert.equal(checksum(backup.path), sourceChecksum);
    assert.equal(fs.statSync(backup.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(value.backupDir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("restore dry-run is non-mutating and confirmed restore creates a safety backup", () => {
  const value = fixture("database-restore");
  try {
    insertJob(value.file, "restore-point");
    const restorePoint = createDatabaseBackup(value.file, { backupDir: value.backupDir, reason: "restore-point" });
    insertJob(value.file, "later-change");
    const changedChecksum = checksum(value.file);
    const changedInode = fs.statSync(value.file).ino;

    const dryRun = verifyRestoreCandidate(value.file, restorePoint.path);
    assert.equal(dryRun.ok, true);
    assert.equal(checksum(value.file), changedChecksum);
    assert.throws(() => restoreDatabase(value.file, restorePoint.path, { backupDir: value.backupDir }), /requires --confirm/);
    assert.equal(checksum(value.file), changedChecksum);

    const result = restoreDatabase(value.file, restorePoint.path, {
      backupDir: value.backupDir,
      confirm: RESTORE_CONFIRMATION,
    });
    assert.equal(result.ok, true);
    assert.equal(checksum(value.file), restorePoint.checksum);
    assert.notEqual(fs.statSync(value.file).ino, changedInode);
    assert.equal(result.safetyBackup.checksum, changedChecksum);
    assert.deepEqual(fs.readdirSync(value.directory).filter((name) => name.startsWith(".restore-") || name.startsWith(".database-replace-")), []);
    const db = openDatabase(value.file);
    assert.deepEqual(db.prepare("SELECT job_key FROM jobs ORDER BY job_key").all().map((row) => row.job_key), ["restore-point"]);
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("local JSON export contains the database role and all tables without changing the database", () => {
  const value = fixture("database-export");
  try {
    insertJob(value.file, "exported-job");
    const before = checksum(value.file);
    const result = exportDatabase(value.file, { exportDir: value.exportDir, now: new Date("2026-01-02T03:04:05.000Z") });
    assert.equal(checksum(value.file), before);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
    const payload = JSON.parse(fs.readFileSync(result.path, "utf8"));
    assert.equal(payload.format, "job-search-operations-dashboard-export-v1");
    assert.equal(payload.exportedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(payload.database.role, "personal");
    assert.equal(payload.database.schemaVersion, 13);
    assert.equal(payload.tables.jobs[0].job_key, "exported-job");
    assert.equal(result.tableCount, Object.keys(payload.tables).length);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("database maintenance rejects symbolic-link inputs", () => {
  const value = fixture("database-symlink");
  try {
    const link = path.join(value.directory, "linked.sqlite");
    fs.symlinkSync(value.file, link);
    assert.throws(() => inspectDatabaseFile(link), /regular file.*symbolic link/);
    assert.throws(() => createDatabaseBackup(link, { backupDir: value.backupDir }), /regular file.*symbolic link/);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
