import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertDatabaseRoleBeforeOpen, inspectExistingDatabaseRole, recordDatabaseRole } from "../lib/database-role.mjs";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";

function fixture(entries = {}, { journalMode = "delete" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "database-role-"));
  const file = path.join(directory, "fixture.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const [key, value] of Object.entries(entries)) db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run(key, value);
  if (journalMode === "wal") db.exec("PRAGMA journal_mode = WAL");
  db.close();
  return { directory, file };
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fileSnapshot(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  return {
    size: stat.size,
    mode: stat.mode & 0o777,
    mtimeMs: stat.mtimeMs,
    checksum: checksum(file),
  };
}

function databaseSnapshot(file) {
  return {
    database: fileSnapshot(file),
    shm: fileSnapshot(`${file}-shm`),
    wal: fileSnapshot(`${file}-wal`),
  };
}

test("new database paths accept either explicit role", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "database-role-new-"));
  try {
    const file = path.join(directory, "new.sqlite");
    assert.equal(assertDatabaseRoleBeforeOpen(file, "demo").role, "new");
    assert.equal(assertDatabaseRoleBeforeOpen(file, "personal").role, "new");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy demo and personal roles are inferred without mutating mismatched databases", () => {
  for (const [entries, accepted, rejected] of [
    [{ demo_seeded: "true", instance_id: crypto.randomUUID() }, "demo", "personal"],
    [{ instance_id: crypto.randomUUID() }, "personal", "demo"],
  ]) {
    const value = fixture(entries);
    try {
      const before = checksum(value.file);
      assert.equal(inspectExistingDatabaseRole(value.file).role, accepted);
      assert.equal(assertDatabaseRoleBeforeOpen(value.file, accepted).role, accepted);
      assert.throws(() => assertDatabaseRoleBeforeOpen(value.file, rejected), /role mismatch/);
      assert.equal(checksum(value.file), before);
    } finally {
      fs.rmSync(value.directory, { recursive: true, force: true });
    }
  }
});

test("read-only WAL inspection does not create SQLite sidecars or change the database", () => {
  const value = fixture({ schema_version: "2", database_role: "personal" }, { journalMode: "wal" });
  try {
    const before = databaseSnapshot(value.file);
    assert.equal(before.shm, null);
    assert.equal(before.wal, null);

    assert.deepEqual(inspectExistingDatabaseRole(value.file), { exists: true, role: "personal", explicit: true });
    assert.deepEqual(assertDatabaseRoleBeforeOpen(value.file, "personal"), { exists: true, role: "personal", explicit: true });

    assert.deepEqual(databaseSnapshot(value.file), before);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("immutable inspection preserves existing WAL sidecars byte-for-byte", () => {
  const value = fixture({ schema_version: "2", database_role: "personal" }, { journalMode: "wal" });
  let holder;
  try {
    holder = new DatabaseSync(value.file, { readOnly: true });
    holder.prepare("SELECT value FROM app_meta WHERE key = 'database_role'").get();
    const before = databaseSnapshot(value.file);
    assert.notEqual(before.shm, null);
    assert.notEqual(before.wal, null);

    assert.deepEqual(inspectExistingDatabaseRole(value.file), { exists: true, role: "personal", explicit: true });
    assert.deepEqual(assertDatabaseRoleBeforeOpen(value.file, "personal"), { exists: true, role: "personal", explicit: true });

    assert.deepEqual(databaseSnapshot(value.file), before);
  } finally {
    try { holder?.close(); } catch {}
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("uncheckpointed WAL role changes fail closed without touching database files", () => {
  const value = fixture({ schema_version: "2", database_role: "personal" });
  let writer;
  try {
    writer = new DatabaseSync(value.file);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer.prepare("UPDATE app_meta SET value = 'demo' WHERE key = 'database_role'").run();
    const before = databaseSnapshot(value.file);
    assert.ok(before.wal.size > 0);

    assert.throws(
      () => assertDatabaseRoleBeforeOpen(value.file, "personal"),
      /uncheckpointed WAL changes/,
    );
    assert.deepEqual(databaseSnapshot(value.file), before);
  } finally {
    try { writer?.close(); } catch {}
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("uncheckpointed future schemas fail closed without touching database files", () => {
  const value = fixture({ schema_version: "2", database_role: "personal" });
  let writer;
  try {
    writer = new DatabaseSync(value.file);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer.prepare("UPDATE app_meta SET value = '8' WHERE key = 'schema_version'").run();
    const before = databaseSnapshot(value.file);
    assert.ok(before.wal.size > 0);

    assert.throws(
      () => assertDatabaseRoleBeforeOpen(value.file, "personal"),
      /uncheckpointed WAL changes/,
    );
    assert.deepEqual(databaseSnapshot(value.file), before);
  } finally {
    try { writer?.close(); } catch {}
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("WAL role mismatches fail closed without changing the database or creating sidecars", () => {
  const value = fixture({ schema_version: "2", database_role: "personal" }, { journalMode: "wal" });
  try {
    const before = databaseSnapshot(value.file);
    assert.throws(() => assertDatabaseRoleBeforeOpen(value.file, "demo"), /role mismatch/);
    assert.deepEqual(databaseSnapshot(value.file), before);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("future WAL schemas fail closed without changing the database or creating sidecars", () => {
  const value = fixture({ schema_version: "12", database_role: "personal" }, { journalMode: "wal" });
  try {
    const before = databaseSnapshot(value.file);
    assert.throws(() => assertDatabaseRoleBeforeOpen(value.file, "personal"), /newer than/);
    assert.deepEqual(databaseSnapshot(value.file), before);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("recorded database role is immutable", () => {
  const value = fixture({ instance_id: crypto.randomUUID() });
  try {
    const db = new DatabaseSync(value.file);
    recordDatabaseRole(db, "personal");
    assert.throws(() => recordDatabaseRole(db, "demo"), /role mismatch/);
    db.close();
    assert.deepEqual(inspectExistingDatabaseRole(value.file), { exists: true, role: "personal", explicit: true });
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a newer schema is rejected before its role or version can be changed", () => {
  const value = fixture({ schema_version: "12", instance_id: crypto.randomUUID() });
  try {
    const before = checksum(value.file);
    assert.throws(() => assertDatabaseRoleBeforeOpen(value.file, "personal"), /newer than/);
    assert.equal(checksum(value.file), before);

    const db = new DatabaseSync(value.file);
    assert.throws(() => recordDatabaseRole(db, "personal"), /newer than/);
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, "12");
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'database_role'").get(), undefined);
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("database initialization records an immutable role before future opens", () => {
  for (const mode of ["demo", "personal"]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `database-role-${mode}-`));
    const file = path.join(directory, `${mode}.sqlite`);
    try {
      initializeDatabase(file, { mode });
      assert.deepEqual(inspectExistingDatabaseRole(file), { exists: true, role: mode, explicit: true });
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const versionDb = new DatabaseSync(file, { readOnly: true });
      assert.equal(versionDb.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, "11");
      versionDb.close();
      const before = checksum(file);
      assert.throws(
        () => initializeDatabase(file, { mode: mode === "demo" ? "personal" : "demo" }),
        /role mismatch/,
      );
      assert.equal(checksum(file), before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("legacy unreachable package states are normalized and guarded during open", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "database-state-migration-"));
  const file = path.join(directory, "legacy.sqlite");
  try {
    initializeDatabase(file, { mode: "personal" });
    let db = openDatabase(file);
    db.exec("DROP TRIGGER application_packages_state_insert_guard; DROP TRIGGER application_packages_state_update_guard; PRAGMA ignore_check_constraints = ON;");
    const jobId = db.prepare("INSERT INTO jobs (job_key, company_name, title) VALUES ('legacy-state', 'Example Company', 'Example Role')").run().lastInsertRowid;
    db.prepare(`INSERT INTO application_packages (
      job_id, state, content_checksum, artifact_directory, content_json_path, resume_markdown_path, resume_html_path
    ) VALUES (?, 'revision_requested', 'checksum', 'directory', 'content', 'markdown', 'html')`).run(jobId);
    db.close();

    initializeDatabase(file, { mode: "personal" });
    db = openDatabase(file);
    assert.equal(db.prepare("SELECT state FROM application_packages WHERE job_id = ?").get(jobId).state, "quality_hold");
    assert.throws(
      () => db.prepare("UPDATE application_packages SET state = 'approval_hold' WHERE job_id = ?").run(jobId),
      /invalid application package state/,
    );
    db.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
