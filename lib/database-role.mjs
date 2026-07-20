import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const CURRENT_SCHEMA_VERSION = 11;

function modeError(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function readMeta(db, key) {
  return db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key)?.value;
}

function parseSchemaVersion(value) {
  if (value === undefined) return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) throw modeError("Database schema version is invalid");
  return Number(normalized);
}

export function assertNoUncheckpointedWal(dbPath) {
  const walPath = `${dbPath}-wal`;
  let stat;
  try {
    stat = fs.lstatSync(walPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw modeError(`Database WAL state could not be verified safely: ${error?.message || error}`);
  }
  if (!stat.isFile() || stat.size > 0) {
    throw modeError("Database has uncheckpointed WAL changes and cannot be verified safely; close other database processes and retry");
  }
}

function openImmutableDatabase(dbPath) {
  // Immutable reads avoid creating -wal/-shm files, but they intentionally do
  // not consume pending WAL frames. Refuse those frames instead of inspecting
  // a stale main database and accidentally accepting the wrong role/version.
  assertNoUncheckpointedWal(dbPath);
  const databaseUrl = pathToFileURL(path.resolve(dbPath));
  databaseUrl.searchParams.set("mode", "ro");
  databaseUrl.searchParams.set("immutable", "1");
  return new DatabaseSync(databaseUrl, { readOnly: true });
}

export function inspectExistingSchemaVersion(dbPath) {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return null;
  let db;
  try {
    db = openImmutableDatabase(dbPath);
    const hasMeta = Boolean(db.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get());
    return hasMeta ? parseSchemaVersion(readMeta(db, "schema_version")) : null;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw modeError(`Database schema version could not be verified safely: ${error?.message || error}`);
  } finally {
    try { db?.close(); } catch {}
  }
}

function assertSupportedSchemaVersion(version) {
  if (version !== null && version > CURRENT_SCHEMA_VERSION) {
    throw modeError(`Database schema version ${version} is newer than this application supports (${CURRENT_SCHEMA_VERSION})`);
  }
}

export function inspectExistingDatabaseRole(dbPath) {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return { exists: false, role: "new", explicit: false };
  let db;
  try {
    db = openImmutableDatabase(dbPath);
    const hasMeta = Boolean(db.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get());
    if (!hasMeta) return { exists: true, role: "unknown", explicit: false };
    const explicit = String(readMeta(db, "database_role") || "").trim().toLowerCase();
    if (new Set(["demo", "personal"]).has(explicit)) return { exists: true, role: explicit, explicit: true };
    if (readMeta(db, "demo_seeded") === "true") return { exists: true, role: "demo", explicit: false };
    if (readMeta(db, "instance_id")) return { exists: true, role: "personal", explicit: false };
    return { exists: true, role: "unknown", explicit: false };
  } catch (error) {
    throw modeError(`Database role could not be verified safely: ${error?.message || error}`);
  } finally {
    try { db?.close(); } catch {}
  }
}

export function assertDatabaseRoleBeforeOpen(dbPath, requestedMode) {
  if (!new Set(["demo", "personal"]).has(requestedMode)) throw new Error("Database role must be demo or personal");
  assertSupportedSchemaVersion(inspectExistingSchemaVersion(dbPath));
  const current = inspectExistingDatabaseRole(dbPath);
  if (!current.exists || current.role === "new") return current;
  if (current.role === "unknown") {
    throw modeError("Existing database has no trusted demo/personal identity; use a new database path or migrate it explicitly");
  }
  if (current.role !== requestedMode) {
    throw modeError(`Database role mismatch: requested ${requestedMode}, existing database is ${current.role}`);
  }
  return current;
}

export function recordDatabaseRole(db, mode) {
  if (!new Set(["demo", "personal"]).has(mode)) throw new Error("Database role must be demo or personal");
  const schemaVersion = parseSchemaVersion(readMeta(db, "schema_version"));
  assertSupportedSchemaVersion(schemaVersion);
  const existing = String(readMeta(db, "database_role") || "").trim().toLowerCase();
  if (existing && existing !== mode) throw modeError(`Database role mismatch: requested ${mode}, existing database is ${existing}`);
  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES ('database_role', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(mode);
  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES ('schema_version', '${CURRENT_SCHEMA_VERSION}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run();
}
