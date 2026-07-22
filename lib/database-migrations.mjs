import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CURRENT_SCHEMA_VERSION,
  assertDatabaseRoleBeforeOpen,
  inspectExistingSchemaVersion,
  recordDatabaseRole,
} from "./database-role.mjs";
import {
  createDatabaseBackup,
  inspectDatabaseFile,
  replaceDatabaseFileAtomically,
} from "./database-maintenance.mjs";
import { PROJECT_ROOT } from "./paths.mjs";

const schemaPath = path.join(PROJECT_ROOT, "db", "schema.sql");
const MIGRATIONS = [
  [1, "legacy_core_schema"],
  [2, "legacy_package_workflow"],
  [3, "legacy_onboarding_and_database_roles"],
  [4, "migration_safety_revisions_and_privacy_retention"],
  [5, "provider_neutral_companion_queue"],
  [6, "generic_resume_assets_and_structured_profile"],
  [7, "multisource_deadlines_and_collection_provenance"],
  [8, "application_outcomes_followups_and_local_inbox"],
  [9, "paginated_job_views_and_saved_filters"],
  [10, "companion_result_review_contracts"],
  [11, "outcome_corrections_and_job_reopen_signals"],
  [12, "package_review_controls_and_private_outcome_evidence"],
  [13, "structured_resume_engagement_and_portfolio_links"],
];
const JOBS_REVISION_TABLES = ["jobs", "job_sources", "job_scores", "job_tailoring"];
const WORKFLOW_REVISION_TABLES = [
  "application_state", "resume_profile", "source_documents", "resume_assets", "resume_structured_items", "profile_facts", "evidence_items",
  "resume_custom_sections", "application_packages", "package_revisions", "package_approvals",
  "package_submissions", "privacy_deletion_events",
  "agent_tasks", "agent_task_reviews", "application_events", "follow_ups", "local_notifications", "saved_filters",
  "package_review_states", "outcome_evidence_files",
];

function migrationChecksum(version, name) {
  return crypto.createHash("sha256").update(`${version}:${name}`).digest("hex");
}

export const MIGRATION_MANIFEST = Object.freeze(MIGRATIONS.map(([version, name]) => Object.freeze({
  version,
  name,
  checksum: migrationChecksum(version, name),
})));

export function inspectMigrationManifest(db) {
  let rows;
  try {
    rows = db.prepare("SELECT version, name, checksum, source FROM schema_migrations ORDER BY version").all();
  } catch (error) {
    return { ok: false, rows: [], issues: [`migration history unavailable: ${error?.message || "unknown"}`] };
  }
  const expectedByVersion = new Map(MIGRATION_MANIFEST.map((item) => [item.version, item]));
  const actualByVersion = new Map(rows.map((item) => [Number(item.version), item]));
  const issues = [];
  for (const expected of MIGRATION_MANIFEST) {
    const actual = actualByVersion.get(expected.version);
    if (!actual) {
      issues.push(`missing migration ${expected.version}`);
      continue;
    }
    if (actual.name !== expected.name) issues.push(`migration ${expected.version} name mismatch`);
    if (actual.checksum !== expected.checksum) issues.push(`migration ${expected.version} checksum mismatch`);
    if (!new Set(["native", "legacy_schema_version"]).has(actual.source)) {
      issues.push(`migration ${expected.version} source is invalid`);
    }
  }
  for (const version of actualByVersion.keys()) {
    if (!expectedByVersion.has(version)) issues.push(`unexpected migration ${version}`);
  }
  return { ok: issues.length === 0 && rows.length === MIGRATION_MANIFEST.length, rows, issues };
}

function assertMigrationManifest(db) {
  const inspection = inspectMigrationManifest(db);
  if (!inspection.ok) throw new Error(`Database migration manifest verification failed: ${inspection.issues.join("; ")}`);
}

function schemaWithoutPragmas() {
  return fs.readFileSync(schemaPath, "utf8").replace(/^PRAGMA .*;\s*$/gm, "");
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 AS value FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

function ensureLegacyColumns(db) {
  const editableSections = [
    "headline", "summary", "skills", "experience_highlights", "achievement_evidence",
    "representative_experience", "direct_scope", "collaboration_scope", "career_direction",
  ];
  if (tableExists(db, "resume_profile")) {
    const resume = columns(db, "resume_profile");
    const resumeAdditions = {
      job_family: "TEXT NOT NULL DEFAULT ''",
      job_role: "TEXT NOT NULL DEFAULT ''",
      career_type: "TEXT NOT NULL DEFAULT 'new'",
      career_stage: "TEXT NOT NULL DEFAULT ''",
      years_experience: "REAL",
      school: "TEXT NOT NULL DEFAULT ''",
      major: "TEXT NOT NULL DEFAULT ''",
      certificates_json: "TEXT NOT NULL DEFAULT '[]'",
      achievement_evidence: "TEXT NOT NULL DEFAULT ''",
      representative_experience: "TEXT NOT NULL DEFAULT ''",
      direct_scope: "TEXT NOT NULL DEFAULT ''",
      collaboration_scope: "TEXT NOT NULL DEFAULT ''",
      career_direction: "TEXT NOT NULL DEFAULT ''",
      editable_sections_json: `TEXT NOT NULL DEFAULT '${JSON.stringify(editableSections)}'`,
    };
    const editableAdded = !resume.has("editable_sections_json");
    for (const [name, definition] of Object.entries(resumeAdditions)) {
      if (!resume.has(name)) db.exec(`ALTER TABLE resume_profile ADD COLUMN ${name} ${definition}`);
    }
    if (editableAdded) db.prepare("UPDATE resume_profile SET editable_sections_json = ?").run(JSON.stringify(editableSections));
  }

  if (tableExists(db, "job_scores")) {
    const scores = columns(db, "job_scores");
    if (!scores.has("score_mode")) db.exec("ALTER TABLE job_scores ADD COLUMN score_mode TEXT NOT NULL DEFAULT 'scalar'");
    if (!scores.has("profile_checksum")) db.exec("ALTER TABLE job_scores ADD COLUMN profile_checksum TEXT NOT NULL DEFAULT ''");
  }
  if (tableExists(db, "application_packages")) {
    const packages = columns(db, "application_packages");
    if (!packages.has("application_answers_path")) {
      db.exec("ALTER TABLE application_packages ADD COLUMN application_answers_path TEXT NOT NULL DEFAULT ''");
    }
  }
  if (tableExists(db, "jobs")) {
    const jobs = columns(db, "jobs");
    if (!jobs.has("deadline")) db.exec("ALTER TABLE jobs ADD COLUMN deadline TEXT");
    if (!jobs.has("deadline_source")) db.exec("ALTER TABLE jobs ADD COLUMN deadline_source TEXT NOT NULL DEFAULT ''");
    if (!jobs.has("reopened_at")) db.exec("ALTER TABLE jobs ADD COLUMN reopened_at TEXT");
    if (!jobs.has("reopen_count")) db.exec("ALTER TABLE jobs ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0");
  }
  if (tableExists(db, "job_sources")) {
    const sources = columns(db, "job_sources");
    const sourceAdditions = {
      deadline: "TEXT",
      access_method: "TEXT NOT NULL DEFAULT 'manual'",
      provenance_json: "TEXT NOT NULL DEFAULT '{}'",
      first_seen_at: "TEXT NOT NULL DEFAULT ''",
      last_seen_at: "TEXT NOT NULL DEFAULT ''",
    };
    for (const [name, definition] of Object.entries(sourceAdditions)) {
      if (!sources.has(name)) db.exec(`ALTER TABLE job_sources ADD COLUMN ${name} ${definition}`);
    }
    db.exec("UPDATE job_sources SET first_seen_at = checked_at WHERE first_seen_at = ''; UPDATE job_sources SET last_seen_at = checked_at WHERE last_seen_at = '';");
  }

  if (tableExists(db, "application_events")) {
    const events = columns(db, "application_events");
    if (!events.has("correction_of_event_id")) db.exec("ALTER TABLE application_events ADD COLUMN correction_of_event_id INTEGER REFERENCES application_events(id)");
    if (!events.has("correction_reason")) db.exec("ALTER TABLE application_events ADD COLUMN correction_reason TEXT NOT NULL DEFAULT ''");
  }
  if (tableExists(db, "resume_structured_items")) {
    const items = columns(db, "resume_structured_items");
    if (!items.has("engagement_type")) db.exec("ALTER TABLE resume_structured_items ADD COLUMN engagement_type TEXT NOT NULL DEFAULT ''");
    if (!items.has("portfolio_links_json")) db.exec("ALTER TABLE resume_structured_items ADD COLUMN portfolio_links_json TEXT NOT NULL DEFAULT '[]'");
  }
}

function ensurePackageStateIntegrity(db) {
  db.exec(`
    UPDATE application_packages
    SET state = CASE
      WHEN EXISTS (SELECT 1 FROM package_submissions s WHERE s.package_id = application_packages.id AND s.status = 'submitted') THEN 'submitted'
      WHEN EXISTS (SELECT 1 FROM package_submissions s WHERE s.package_id = application_packages.id AND s.status = 'submit_ready') THEN 'submit_ready'
      WHEN approved_checksum <> '' AND resume_pdf_path <> '' THEN 'approved'
      WHEN quality_status = 'passed' THEN 'approval_pending'
      ELSE 'quality_hold'
    END
    WHERE state NOT IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted');

    CREATE TRIGGER IF NOT EXISTS application_packages_state_insert_guard
    BEFORE INSERT ON application_packages
    WHEN NEW.state NOT IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted')
    BEGIN SELECT RAISE(ABORT, 'invalid application package state'); END;

    CREATE TRIGGER IF NOT EXISTS application_packages_state_update_guard
    BEFORE UPDATE OF state ON application_packages
    WHEN NEW.state NOT IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted')
    BEGIN SELECT RAISE(ABORT, 'invalid application package state'); END;
  `);
}

function ensureCompanionReviews(db) {
  db.exec(`
    INSERT OR IGNORE INTO agent_task_reviews (task_id, status, result_checksum)
    SELECT id, 'awaiting_review', result_checksum
    FROM agent_tasks
    WHERE status = 'succeeded' AND result_checksum <> '';
  `);
}

function installRevisionTriggers(db) {
  db.exec("INSERT OR IGNORE INTO system_revisions (scope, revision) VALUES ('jobs', 0), ('workflow', 0)");
  for (const [scope, tables] of [["jobs", JOBS_REVISION_TABLES], ["workflow", WORKFLOW_REVISION_TABLES]]) {
    for (const table of tables) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const trigger = `revision_${scope}_${table}_${action.toLowerCase()}`;
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS ${trigger}
          AFTER ${action} ON ${table}
          BEGIN
            UPDATE system_revisions SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE scope = '${scope}';
          END;
        `);
      }
    }
  }
}

function recordMigration(db, version, name, source) {
  db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(version) DO NOTHING
  `).run(version, name, migrationChecksum(version, name), source);
}

export function applySchemaMigrations(db, { startingVersion = 0, mode, beforeCommit } = {}) {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
  try {
    // Existing releases can lack columns referenced by indexes in the current schema.
    // Add those columns before SQLite evaluates CREATE INDEX statements, then run the
    // same compatibility pass again after new tables have been installed.
    ensureLegacyColumns(db);
    db.exec(schemaWithoutPragmas());
    ensureLegacyColumns(db);
    ensurePackageStateIntegrity(db);
    ensureCompanionReviews(db);
    for (const [version, name] of MIGRATIONS) {
      recordMigration(db, version, name, startingVersion >= version ? "legacy_schema_version" : "native");
    }
    installRevisionTriggers(db);
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('instance_id', ?)").run(crypto.randomUUID());
    recordDatabaseRole(db, mode);
    if (typeof beforeCommit === "function") beforeCommit(db);
    assertMigrationManifest(db);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function restoreFailedUpgrade(dbPath, backup, originalStat) {
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  replaceDatabaseFileAtomically(backup.path, dbPath, {
    mode: originalStat.mode & 0o777,
    atime: originalStat.atime,
    mtime: originalStat.mtime,
  });
}

function databaseNeedsRepair(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const invalidState = db.prepare(`
      SELECT 1 AS value FROM application_packages
      WHERE state NOT IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted')
      LIMIT 1
    `).get();
    const requiredTables = [
      "schema_migrations", "system_revisions", "privacy_deletion_events", "agent_tasks", "agent_task_reviews",
      "resume_assets", "resume_structured_items", "application_events", "follow_ups", "local_notifications", "saved_filters",
      "package_review_states", "outcome_evidence_files",
    ];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
    const revisionTriggers = [["jobs", JOBS_REVISION_TABLES], ["workflow", WORKFLOW_REVISION_TABLES]]
      .flatMap(([scope, tableNames]) => tableNames.flatMap((table) => ["insert", "update", "delete"]
        .map((action) => `revision_${scope}_${table}_${action}`)));
    const requiredTriggers = [
      "application_packages_state_insert_guard",
      "application_packages_state_update_guard",
      "application_events_update_guard",
      "application_events_delete_guard",
      ...revisionTriggers,
    ];
    const triggers = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all().map((row) => row.name));
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all().map((row) => row.name));
    const requiredIndexes = [
      "idx_agent_tasks_status_created", "idx_agent_tasks_active_dedupe", "idx_agent_tasks_single_generation",
      "idx_agent_task_reviews_status_updated",
      "idx_resume_assets_status", "idx_resume_structured_kind_order",
      "idx_jobs_deadline", "idx_job_sources_deadline",
      "idx_application_events_job_occurred", "idx_follow_ups_job_due",
      "idx_application_events_correction",
      "idx_follow_ups_pending_dedupe", "idx_local_notifications_unread",
      "idx_saved_filters_default_name",
    ];
    const migrationManifestOk = tables.has("schema_migrations") && inspectMigrationManifest(db).ok;
    return Boolean(invalidState)
      || requiredTables.some((table) => !tables.has(table))
      || requiredTriggers.some((trigger) => !triggers.has(trigger))
      || requiredIndexes.some((index) => !indexes.has(index))
      || !migrationManifestOk;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

export function prepareDatabase(dbPath, { mode, beforeCommit, backupDir } = {}) {
  if (!new Set(["demo", "personal"]).has(mode)) throw new Error("Database role must be demo or personal");
  const existed = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  let startingVersion = null;
  let backup = null;
  let originalStat = null;
  if (existed) {
    assertDatabaseRoleBeforeOpen(dbPath, mode);
    startingVersion = inspectExistingSchemaVersion(dbPath) ?? 0;
    if (startingVersion === CURRENT_SCHEMA_VERSION && !databaseNeedsRepair(dbPath)) {
      return { migrated: false, fromVersion: startingVersion, toVersion: startingVersion, backup: null };
    }
    originalStat = fs.statSync(dbPath);
    backup = createDatabaseBackup(dbPath, { reason: `pre-migration-v${startingVersion}-to-v${CURRENT_SCHEMA_VERSION}`, backupDir });
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(dbPath);
  try {
    fs.chmodSync(dbPath, 0o600);
    applySchemaMigrations(db, { startingVersion: startingVersion ?? 0, mode, beforeCommit });
  } catch (error) {
    try { db.close(); } catch {}
    if (backup) restoreFailedUpgrade(dbPath, backup, originalStat);
    else for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    throw error;
  }
  db.close();
  const inspection = inspectDatabaseFile(dbPath);
  if (!inspection.ok || inspection.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    if (backup) restoreFailedUpgrade(dbPath, backup, originalStat);
    else for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    throw new Error("Migrated database failed verification");
  }
  return { migrated: true, fromVersion: startingVersion, toVersion: CURRENT_SCHEMA_VERSION, backup, inspection };
}

export function currentMigrationManifest(db) {
  return db.prepare("SELECT version, name, checksum, source, applied_at AS appliedAt FROM schema_migrations ORDER BY version").all();
}
