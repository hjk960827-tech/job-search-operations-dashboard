import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase, openDatabase } from "../lib/database.mjs";
import { currentMigrationManifest, prepareDatabase } from "../lib/database-migrations.mjs";

function temporaryDatabase(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return {
    directory,
    file: path.join(directory, "personal.sqlite"),
    backupDir: path.join(directory, "backups"),
  };
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createSyntheticVersion3(file) {
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  db.prepare(`
    INSERT INTO jobs (job_key, company_name, title, track, location, lifecycle_status, summary)
    VALUES ('preserved-role', 'Example Organization', 'Example Specialist', 'Primary', 'Remote', 'active', 'Synthetic record')
  `).run();
  const jobId = db.prepare("SELECT id FROM jobs WHERE job_key = 'preserved-role'").get().id;
  db.prepare(`
    INSERT INTO job_sources (job_id, platform, source_url, lifecycle_status, confidence)
    VALUES (?, 'direct', 'https://example.invalid/jobs/preserved-role', 'active', 90)
  `).run(jobId);
  db.prepare("UPDATE resume_profile SET job_family = 'General', summary = 'Synthetic profile' WHERE id = 1").run();

  const revisionTriggers = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'trigger' AND name LIKE 'revision_%'
  `).all();
  for (const row of revisionTriggers) db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
  db.exec(`
    DROP INDEX idx_jobs_deadline;
    DROP INDEX idx_job_sources_deadline;
    ALTER TABLE jobs DROP COLUMN deadline;
    ALTER TABLE jobs DROP COLUMN deadline_source;
    ALTER TABLE jobs DROP COLUMN reopened_at;
    ALTER TABLE jobs DROP COLUMN reopen_count;
    ALTER TABLE job_sources DROP COLUMN deadline;
    ALTER TABLE job_sources DROP COLUMN access_method;
    ALTER TABLE job_sources DROP COLUMN provenance_json;
    ALTER TABLE job_sources DROP COLUMN first_seen_at;
    ALTER TABLE job_sources DROP COLUMN last_seen_at;
    DROP TABLE resume_assets;
    DROP TABLE resume_structured_items;
    DROP TABLE local_notifications;
    DROP TABLE follow_ups;
    DROP TABLE application_events;
    DROP TABLE saved_filters;
    DROP TABLE agent_tasks;
    DROP TABLE privacy_deletion_events;
    DROP TABLE system_revisions;
    DROP TABLE schema_migrations;
    UPDATE app_meta SET value = '3' WHERE key = 'schema_version';
  `);
  db.close();
}

function createSyntheticVersion4(file) {
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  db.prepare("INSERT INTO jobs (job_key, company_name, title) VALUES ('v4-preserved', 'Example', 'Role')").run();
  for (const action of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER revision_workflow_agent_tasks_${action}`);
  db.exec(`
    DROP TABLE resume_assets;
    DROP TABLE resume_structured_items;
    DROP TABLE local_notifications;
    DROP TABLE follow_ups;
    DROP TABLE application_events;
    DROP TABLE saved_filters;
    DROP TABLE agent_tasks;
    DELETE FROM schema_migrations WHERE version IN (5, 6, 7, 8, 9);
    UPDATE app_meta SET value = '4' WHERE key = 'schema_version';
  `);
  db.close();
}

function createSyntheticVersion5(file) {
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  db.prepare("UPDATE resume_profile SET summary = 'v5 profile preserved' WHERE id = 1").run();
  for (const table of ["resume_assets", "resume_structured_items"]) {
    for (const action of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER revision_workflow_${table}_${action}`);
  }
  db.exec(`
    DROP TABLE resume_assets;
    DROP TABLE resume_structured_items;
    DROP TABLE local_notifications;
    DROP TABLE follow_ups;
    DROP TABLE application_events;
    DROP TABLE saved_filters;
    DELETE FROM schema_migrations WHERE version IN (6, 7, 8, 9);
    UPDATE app_meta SET value = '5' WHERE key = 'schema_version';
  `);
  db.close();
}

function createSyntheticVersion6(file) {
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  const jobId = db.prepare("INSERT INTO jobs (job_key, company_name, title) VALUES ('v6-role', 'Example', 'Role')").run().lastInsertRowid;
  db.prepare(`INSERT INTO job_sources (job_id, platform, source_url, lifecycle_status, confidence)
              VALUES (?, 'direct', 'https://example.invalid/v6-role', 'active', 90)`).run(jobId);
  db.exec(`
    DROP TABLE local_notifications;
    DROP TABLE follow_ups;
    DROP TABLE application_events;
    DROP TABLE saved_filters;
    DELETE FROM schema_migrations WHERE version IN (7, 8, 9);
    UPDATE app_meta SET value = '6' WHERE key = 'schema_version';
  `);
  db.close();
}

function createSyntheticVersion7(file) {
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  db.prepare("INSERT INTO jobs (job_key, company_name, title) VALUES ('v7-role', 'Example', 'Role')").run();
  db.exec(`
    DROP TABLE local_notifications;
    DROP TABLE follow_ups;
    DROP TABLE application_events;
    DROP TABLE saved_filters;
    DELETE FROM schema_migrations WHERE version IN (8, 9);
    UPDATE app_meta SET value = '7' WHERE key = 'schema_version';
  `);
  db.close();
}

function createSyntheticVersion8(file) {
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  db.prepare("INSERT INTO jobs (job_key, company_name, title) VALUES ('v8-role', 'Example', 'Role')").run();
  db.exec(`
    DROP TABLE saved_filters;
    DELETE FROM schema_migrations WHERE version = 9;
    UPDATE app_meta SET value = '8' WHERE key = 'schema_version';
  `);
  db.close();
}

test("a synthetic v0.2 database upgrades transactionally and preserves user data", () => {
  const value = temporaryDatabase("database-migration-upgrade");
  try {
    createSyntheticVersion3(value.file);
    const legacy = new DatabaseSync(value.file, { readOnly: true });
    assert.equal(legacy.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "deadline"), false);
    assert.equal(legacy.prepare("PRAGMA table_info(job_sources)").all().some((column) => column.name === "provenance_json"), false);
    legacy.close();
    const before = checksum(value.file);

    const result = prepareDatabase(value.file, { mode: "personal", backupDir: value.backupDir });
    assert.equal(result.migrated, true);
    assert.equal(result.fromVersion, 3);
    assert.equal(result.toVersion, 13);
    assert.equal(result.backup.checksum, before);
    assert.equal(checksum(result.backup.path), before);
    assert.equal(fs.statSync(result.backup.path).mode & 0o777, 0o600);

    const db = openDatabase(value.file);
    assert.deepEqual(
      currentMigrationManifest(db).map((row) => [row.version, row.source]),
      [[1, "legacy_schema_version"], [2, "legacy_schema_version"], [3, "legacy_schema_version"], [4, "native"], [5, "native"], [6, "native"], [7, "native"], [8, "native"], [9, "native"], [10, "native"], [11, "native"], [12, "native"], [13, "native"]],
    );
    assert.deepEqual(
      { ...db.prepare("SELECT job_key, company_name, title, summary FROM jobs").get() },
      { job_key: "preserved-role", company_name: "Example Organization", title: "Example Specialist", summary: "Synthetic record" },
    );
    assert.equal(db.prepare("SELECT summary FROM resume_profile WHERE id = 1").get().summary, "Synthetic profile");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a failed migration restores the exact pre-upgrade database bytes", () => {
  const value = temporaryDatabase("database-migration-rollback");
  try {
    createSyntheticVersion3(value.file);
    const before = checksum(value.file);

    assert.throws(
      () => prepareDatabase(value.file, {
        mode: "personal",
        backupDir: value.backupDir,
        beforeCommit() { throw new Error("synthetic migration failure"); },
      }),
      /synthetic migration failure/,
    );
    assert.equal(checksum(value.file), before);
    const backups = fs.readdirSync(value.backupDir).map((name) => path.join(value.backupDir, name));
    assert.equal(backups.length, 1);
    assert.equal(checksum(backups[0]), before);

    const db = new DatabaseSync(value.file, { readOnly: true });
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, "3");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").get(), undefined);
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a tampered migration name or checksum is rejected without rewriting the database", () => {
  for (const column of ["name", "checksum"]) {
    const value = temporaryDatabase(`database-migration-tampered-${column}`);
    try {
      initializeDatabase(value.file, { mode: "personal" });
      const db = openDatabase(value.file);
      db.prepare(`UPDATE schema_migrations SET ${column} = 'tampered' WHERE version = 4`).run();
      db.close();
      const before = checksum(value.file);
      assert.throws(
        () => prepareDatabase(value.file, { mode: "personal", backupDir: value.backupDir }),
        new RegExp(`migration 4 ${column} mismatch`),
      );
      assert.equal(checksum(value.file), before);
      const backupFiles = fs.readdirSync(value.backupDir).map((name) => path.join(value.backupDir, name));
      assert.equal(backupFiles.length, 1);
      assert.equal(checksum(backupFiles[0]), before);
    } finally {
      fs.rmSync(value.directory, { recursive: true, force: true });
    }
  }
});

test("a clean install records native migrations and independent revision counters", () => {
  const value = temporaryDatabase("database-migration-clean");
  try {
    initializeDatabase(value.file, { mode: "personal" });
    const db = openDatabase(value.file);
    assert.deepEqual(
      currentMigrationManifest(db).map((row) => [row.version, row.source]),
      [[1, "native"], [2, "native"], [3, "native"], [4, "native"], [5, "native"], [6, "native"], [7, "native"], [8, "native"], [9, "native"], [10, "native"], [11, "native"], [12, "native"], [13, "native"]],
    );
    const before = Object.fromEntries(db.prepare("SELECT scope, revision FROM system_revisions").all().map((row) => [row.scope, row.revision]));
    const jobId = db.prepare("INSERT INTO jobs (job_key, company_name, title) VALUES ('revision-job', 'Example', 'Role')").run().lastInsertRowid;
    const afterJob = Object.fromEntries(db.prepare("SELECT scope, revision FROM system_revisions").all().map((row) => [row.scope, row.revision]));
    assert.equal(afterJob.jobs, before.jobs + 1);
    assert.equal(afterJob.workflow, before.workflow);
    db.prepare("INSERT INTO application_state (job_id, workflow_status) VALUES (?, 'new')").run(jobId);
    const afterWorkflow = Object.fromEntries(db.prepare("SELECT scope, revision FROM system_revisions").all().map((row) => [row.scope, row.revision]));
    assert.equal(afterWorkflow.jobs, afterJob.jobs);
    assert.equal(afterWorkflow.workflow, afterJob.workflow + 1);
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a schema v4 install upgrades to the companion queue without changing existing jobs", () => {
  const value = temporaryDatabase("database-migration-v4-companion");
  try {
    createSyntheticVersion4(value.file);
    const result = prepareDatabase(value.file, { mode: "personal", backupDir: value.backupDir });
    assert.equal(result.fromVersion, 4);
    assert.equal(result.toVersion, 13);
    const db = openDatabase(value.file);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE job_key = 'v4-preserved'").get().count, 1);
    assert.notEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_tasks'").get(), undefined);
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 5").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 6").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 7").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 8").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 9").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 10").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 12").get().source, "native");
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a schema v5 install adds generic structured records without changing the existing baseline", () => {
  const value = temporaryDatabase("database-migration-v5-structured");
  try {
    createSyntheticVersion5(value.file);
    const result = prepareDatabase(value.file, { mode: "personal", backupDir: value.backupDir });
    assert.equal(result.fromVersion, 5);
    assert.equal(result.toVersion, 13);
    const db = openDatabase(value.file);
    assert.equal(db.prepare("SELECT summary FROM resume_profile WHERE id = 1").get().summary, "v5 profile preserved");
    assert.notEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'resume_assets'").get(), undefined);
    assert.notEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'resume_structured_items'").get(), undefined);
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 6").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 7").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 8").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 9").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 10").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 12").get().source, "native");
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a schema v6 install upgrades collection provenance without losing existing sources", () => {
  const value = temporaryDatabase("database-migration-v6-collection");
  try {
    createSyntheticVersion6(value.file);
    const result = prepareDatabase(value.file, { mode: "personal", backupDir: value.backupDir });
    assert.equal(result.fromVersion, 6);
    assert.equal(result.toVersion, 13);
    const db = openDatabase(value.file);
    const source = db.prepare("SELECT platform, source_url, access_method, first_seen_at, last_seen_at FROM job_sources").get();
    assert.equal(source.platform, "direct");
    assert.equal(source.source_url, "https://example.invalid/v6-role");
    assert.equal(source.access_method, "manual");
    assert.ok(source.first_seen_at);
    assert.ok(source.last_seen_at);
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 7").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 8").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 9").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 10").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 12").get().source, "native");
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a schema v7 install adds an append-only result ledger and local follow-up tables", () => {
  const value = temporaryDatabase("database-migration-v7-outcomes");
  try {
    createSyntheticVersion7(value.file);
    const result = prepareDatabase(value.file, { mode: "personal", backupDir: value.backupDir });
    assert.equal(result.fromVersion, 7);
    assert.equal(result.toVersion, 13);
    const db = openDatabase(value.file);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE job_key = 'v7-role'").get().count, 1);
    for (const table of ["application_events", "follow_ups", "local_notifications"]) {
      assert.notEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table), undefined);
    }
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 8").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 9").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 10").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 12").get().source, "native");
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a schema v8 install adds generic saved filters without changing existing jobs", () => {
  const value = temporaryDatabase("database-migration-v8-filters");
  try {
    createSyntheticVersion8(value.file);
    const result = prepareDatabase(value.file, { mode: "personal", backupDir: value.backupDir });
    assert.equal(result.fromVersion, 8);
    assert.equal(result.toVersion, 13);
    const db = openDatabase(value.file);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE job_key = 'v8-role'").get().count, 1);
    assert.notEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'saved_filters'").get(), undefined);
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 9").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 10").get().source, "native");
    assert.equal(db.prepare("SELECT source FROM schema_migrations WHERE version = 12").get().source, "native");
    db.close();
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
