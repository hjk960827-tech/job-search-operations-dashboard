import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configStatus } from "./config.mjs";
import { CURRENT_SCHEMA_VERSION } from "./database-role.mjs";
import { inspectDatabaseFile } from "./database-maintenance.mjs";
import { inspectMigrationManifest } from "./database-migrations.mjs";
import { CONFIG_DIR, DATA_DIR, PROJECT_ROOT, databasePath, runtimeMode } from "./paths.mjs";
import { runtimeHost, runtimePort } from "./runtime.mjs";

function check(id, ok, message, detail = undefined) {
  return { id, ok: Boolean(ok), message, ...(detail === undefined ? {} : { detail }) };
}

function realDirectory(directory, label, { allowMissing = false } = {}) {
  try {
    const stat = fs.lstatSync(directory);
    return check(`path:${label}`, stat.isDirectory() && !stat.isSymbolicLink(), `${label} is a real directory`);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      return check(`path:${label}`, true, `${label} is not initialized yet`, "will be created locally on first use");
    }
    return check(`path:${label}`, false, `${label} is unavailable`, error?.code || "unknown");
  }
}

function nodeVersionCheck(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 13);
  return check("runtime:node", ok, "Node.js 22.13 or newer is required", version);
}

function migrationCheck(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const inspection = inspectMigrationManifest(db);
    return check(
      "database:migrations",
      inspection.ok,
      "Database migration names and checksums match this release",
      inspection.ok ? inspection.rows.map((row) => Number(row.version)) : inspection.issues,
    );
  } catch (error) {
    return check("database:migrations", false, "Database migration history is unavailable", error?.message || "unknown");
  } finally {
    db.close();
  }
}

export function runDoctor(options = {}) {
  const mode = runtimeMode(options.mode || process.env.APP_MODE || "demo");
  const env = options.env || process.env;
  const directories = options.directories || {
    projectRoot: PROJECT_ROOT,
    data: DATA_DIR,
    config: CONFIG_DIR,
  };
  const checks = [
    nodeVersionCheck(options.nodeVersion),
    realDirectory(directories.projectRoot, "project-root"),
    realDirectory(directories.data, "data", { allowMissing: true }),
    realDirectory(directories.config, "config"),
  ];
  try {
    const host = runtimeHost(env);
    checks.push(check("runtime:host", host === "127.0.0.1" || host === "localhost" || host === "::1", "Runtime host is loopback-only", host));
  } catch (error) {
    checks.push(check("runtime:host", false, "Runtime host configuration is invalid", error?.message));
  }
  try {
    const port = runtimePort(env);
    checks.push(check("runtime:port", port !== 8765, "Runtime port does not use the protected personal port", port));
  } catch (error) {
    checks.push(check("runtime:port", false, "Runtime port configuration is invalid", error?.message));
  }

  const setup = options.configStatus || configStatus();
  checks.push(check(
    "config:mode",
    mode !== "personal" || setup.complete,
    mode === "personal" ? "Personal configuration is complete" : "Demo/onboarding does not require personal configuration",
  ));

  if (mode !== "onboarding") {
    try {
      const dbPath = options.databasePath || databasePath(mode, env);
      if (!fs.existsSync(dbPath)) {
        checks.push(check("database:present", mode === "demo", "Database is not initialized yet", path.basename(dbPath)));
      } else {
        const inspection = inspectDatabaseFile(dbPath);
        checks.push(check("database:integrity", inspection.ok, "Database integrity and foreign keys are valid"));
        checks.push(check("database:role", inspection.role === mode, "Database role matches runtime mode", inspection.role));
        checks.push(check("database:version", inspection.schemaVersion === CURRENT_SCHEMA_VERSION, "Database schema is current", inspection.schemaVersion));
        checks.push(check("database:permissions", inspection.mode === 0o600, "Database permissions are owner-only", inspection.mode.toString(8)));
        checks.push(migrationCheck(dbPath));
      }
    } catch (error) {
      checks.push(check("database:inspection", false, "Database could not be inspected safely", error?.message));
    }
  }
  return { ok: checks.every((item) => item.ok), mode, checks };
}
