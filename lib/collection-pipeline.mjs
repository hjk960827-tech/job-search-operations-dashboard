import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importJobsBatch, openDatabase } from "./database.mjs";
import { assertPathInside, COLLECTION_RUNS_DIR, PROJECT_ROOT } from "./paths.mjs";

const ACCESS_POLICIES = new Set(["official_api", "public_page", "user_agent", "user_supplied"]);
const SECRET_KEY = /(?:api.?key|token|secret|password|cookie|session|authorization|credential)/i;
const FORBIDDEN_COMPANY_DATA = /^(?:company_?)?(?:rating|ratings|review|reviews|reputation)$/i;

function pipelineError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function checksum(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(stable(value)));
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function text(value, field, maximum = 200) {
  if (value === null || value === undefined) return "";
  if (!["string", "number"].includes(typeof value)) throw pipelineError(`${field} must be text`);
  return String(value).trim().slice(0, maximum);
}

function timestamp(value, field) {
  const parsed = new Date(value ?? Date.now());
  if (!Number.isFinite(parsed.getTime())) throw pipelineError(`${field} must be a valid timestamp`);
  return parsed.toISOString();
}

function assertSafeEnvelope(value, field = "collection") {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertSafeEnvelope(item, `${field}[${index}]`);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw pipelineError(`${field} cannot contain credentials or account state`);
    if (FORBIDDEN_COMPANY_DATA.test(key)) throw pipelineError(`${field} cannot contain company rating or review data`);
    assertSafeEnvelope(item, `${field}.${key}`);
  }
}

function normalizeEnvelope(input, sourcesConfig) {
  if (!isObject(input)) throw pipelineError("Collection result must be an object");
  assertSafeEnvelope(input);
  const adapterId = text(input.adapterId, "adapterId", 100);
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(adapterId)) throw pipelineError("adapterId is required and must be provider-neutral text");
  const accessPolicy = text(input.accessPolicy, "accessPolicy", 40);
  if (!ACCESS_POLICIES.has(accessPolicy)) throw pipelineError("accessPolicy must be official_api, public_page, user_agent, or user_supplied");
  if (!Array.isArray(input.jobs) || !input.jobs.length) throw pipelineError("jobs must be a non-empty array");
  if (input.jobs.length > 1000) throw pipelineError("jobs cannot contain more than 1000 items");
  const configured = sourcesConfig?.sources || {};
  const jobs = input.jobs.map((job, jobIndex) => {
    if (!isObject(job) || !Array.isArray(job.sources) || !job.sources.length) {
      throw pipelineError(`jobs[${jobIndex}] requires at least one source`);
    }
    const sources = job.sources.map((source, sourceIndex) => {
      const platform = text(source?.platform, `jobs[${jobIndex}].sources[${sourceIndex}].platform`, 60);
      if (!configured[platform] || configured[platform].collect !== true) {
        throw pipelineError(`Platform is not enabled for collection: ${platform}`);
      }
      const expectedMethod = accessPolicy === "official_api" ? "official_api"
        : accessPolicy === "public_page" ? "public_page"
          : accessPolicy === "user_agent" ? "user_agent" : "import";
      const suppliedMethod = text(source.accessMethod, "source.accessMethod", 40);
      const allowedMethods = accessPolicy === "user_supplied" ? new Set(["import", "manual"]) : new Set([expectedMethod]);
      if (suppliedMethod && !allowedMethods.has(suppliedMethod)) {
        throw pipelineError(`Source accessMethod does not match declared accessPolicy: ${suppliedMethod}`);
      }
      const checkedAt = timestamp(source.checkedAt || input.generatedAt, `jobs[${jobIndex}].sources[${sourceIndex}].checkedAt`);
      return {
        ...source,
        accessMethod: suppliedMethod || expectedMethod,
        checkedAt,
        provenance: {
          adapterId,
          retrievalMethod: accessPolicy,
          retrievedAt: checkedAt,
          sourceId: text(source.externalId, "source.externalId", 160),
          note: text(source.provenance?.note, "source.provenance.note", 500),
        },
      };
    });
    return { ...job, sources };
  });
  return {
    schemaVersion: 1,
    adapterId,
    accessPolicy,
    generatedAt: timestamp(input.generatedAt, "generatedAt"),
    jobs,
  };
}

function databaseIdentity(db) {
  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM app_meta WHERE key IN ('instance_id', 'database_role', 'schema_version')").all()
    .map((item) => [item.key, item.value]));
  if (meta.database_role !== "personal" || !meta.instance_id) throw pipelineError("Collection publishing requires a personal local database", 409);
  const revision = Number(db.prepare("SELECT revision FROM system_revisions WHERE scope = 'jobs'").get()?.revision || 0);
  return { instanceId: meta.instance_id, schemaVersion: Number(meta.schema_version), jobsRevision: revision };
}

function snapshotRows(db, jobKeys) {
  const result = {};
  const jobStatement = db.prepare("SELECT * FROM jobs WHERE job_key = ?");
  const sourceStatement = db.prepare("SELECT * FROM job_sources WHERE job_id = ? ORDER BY platform, source_url");
  for (const key of [...jobKeys].sort()) {
    const job = jobStatement.get(key);
    result[key] = job ? { job, sources: sourceStatement.all(job.id) } : null;
  }
  return result;
}

function diffSnapshots(before, after) {
  return Object.keys(after).sort().map((jobKey) => {
    const previous = before[jobKey];
    const next = after[jobKey];
    return {
      jobKey,
      action: !previous ? "create" : checksum(previous) === checksum(next) ? "unchanged" : "update",
      sourceCountBefore: previous?.sources?.length || 0,
      sourceCountAfter: next?.sources?.length || 0,
      deadlineBefore: previous?.job?.deadline || null,
      deadlineAfter: next?.job?.deadline || null,
      statusBefore: previous?.job?.lifecycle_status || null,
      statusAfter: next?.job?.lifecycle_status || null,
    };
  });
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function runPath(runRoot, ...segments) {
  return assertPathInside(runRoot, path.join(runRoot, ...segments), "collection run path");
}

function existingRunDirectory(runId, runRoot) {
  if (!/^[0-9a-f-]{36}$/i.test(String(runId || ""))) throw pipelineError("Collection run ID is invalid", 400);
  const directory = runPath(runRoot, runId);
  let stat;
  try { stat = fs.lstatSync(directory); } catch { throw pipelineError("Collection run not found", 404); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw pipelineError("Collection run directory is unsafe", 409);
  return directory;
}

function readManifest(runId, runRoot = COLLECTION_RUNS_DIR) {
  existingRunDirectory(runId, runRoot);
  const filePath = runPath(runRoot, runId, "manifest.json");
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { throw pipelineError("Collection run not found", 404); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw pipelineError("Collection run manifest is unsafe", 409);
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { filePath, manifest };
}

function publicRun(manifest) {
  return {
    id: manifest.id,
    status: manifest.status,
    adapterId: manifest.adapterId,
    accessPolicy: manifest.accessPolicy,
    requestChecksum: manifest.requestChecksum,
    baseRevision: manifest.database.jobsRevision,
    counts: manifest.counts,
    diff: manifest.diff,
    createdAt: manifest.createdAt,
    publishedAt: manifest.publishedAt || "",
    artifactSynchronized: manifest.artifactSynchronized !== false,
  };
}

function publicationKey(runId) {
  return `collection_publication:${runId}`;
}

function readPublication(db, runId) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(publicationKey(runId));
  if (!row) return null;
  try {
    const value = JSON.parse(row.value);
    if (value?.runId !== runId || !/^[a-f0-9]{64}$/i.test(String(value?.requestChecksum || ""))
      || !value.databaseInstanceId || !Array.isArray(value.imported)
      || value.imported.some((item) => typeof item !== "string")) {
      throw new Error("invalid publication journal fields");
    }
    return value;
  } catch {
    throw pipelineError("Collection publication journal is invalid", 409);
  }
}

function recordPublication(db, publication) {
  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(publicationKey(publication.runId), JSON.stringify(publication));
}

function publishedManifest(manifest, publication, artifactSynchronized = true) {
  return {
    ...manifest,
    status: "published",
    publishedAt: publication.publishedAt,
    publishedRevision: publication.publishedRevision,
    imported: publication.imported,
    artifactSynchronized,
  };
}

function synchronizePublishedManifest(filePath, manifest, publication) {
  const published = publishedManifest(manifest, publication, true);
  try {
    writeJson(filePath, published);
    return published;
  } catch {
    return publishedManifest(manifest, publication, false);
  }
}

function publicationArtifactIsSynchronized(manifest, publication) {
  return manifest.status === "published"
    && manifest.requestChecksum === publication.requestChecksum
    && manifest.publishedAt === publication.publishedAt
    && Number(manifest.publishedRevision) === Number(publication.publishedRevision)
    && JSON.stringify(manifest.imported || []) === JSON.stringify(publication.imported);
}

function existingCoalescedRun(requestChecksum, identity, runRoot) {
  if (!fs.existsSync(runRoot)) return null;
  for (const name of fs.readdirSync(runRoot)) {
    if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
    try {
      const { manifest } = readManifest(name, runRoot);
      if (manifest.status === "staged" && manifest.requestChecksum === requestChecksum
        && manifest.database.instanceId === identity.instanceId
        && Number(manifest.database.jobsRevision) === identity.jobsRevision) return manifest;
    } catch {}
  }
  return null;
}

export function stageCollectionBatch(db, input, { sourcesConfig, timeZone, runRoot = COLLECTION_RUNS_DIR } = {}) {
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(runRoot).isSymbolicLink()) throw pipelineError("Collection run root must not be a symbolic link", 409);
  fs.chmodSync(runRoot, 0o700);
  const envelope = normalizeEnvelope(input, sourcesConfig);
  const requestChecksum = checksum(envelope);
  const identity = databaseIdentity(db);
  const existing = existingCoalescedRun(requestChecksum, identity, runRoot);
  if (existing) return { run: publicRun(existing), coalesced: true };
  const id = crypto.randomUUID();
  const directory = runPath(runRoot, id);
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    throw pipelineError("Collection run directory is unsafe", 409);
  }
  fs.chmodSync(directory, 0o700);
  const stagingPath = runPath(runRoot, id, "staging.sqlite");
  const batchPath = runPath(runRoot, id, "batch.json");
  try {
    const escaped = stagingPath.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    fs.chmodSync(stagingPath, 0o600);
    const staging = openDatabase(stagingPath);
    let before;
    let after;
    try {
      const keys = new Set(envelope.jobs.map((job) => job.jobKey));
      before = snapshotRows(staging, keys);
      importJobsBatch(staging, envelope.jobs, { timeZone });
      after = snapshotRows(staging, keys);
      if (staging.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || staging.prepare("PRAGMA foreign_key_check").all().length) {
        throw pipelineError("Staging database integrity validation failed", 409);
      }
    } finally { staging.close(); }
    const diff = diffSnapshots(before, after);
    writeJson(batchPath, envelope);
    const manifest = {
      version: 1,
      id,
      status: "staged",
      adapterId: envelope.adapterId,
      accessPolicy: envelope.accessPolicy,
      requestChecksum,
      batchChecksum: checksum(fs.readFileSync(batchPath)),
      stagingChecksum: checksum(fs.readFileSync(stagingPath)),
      database: identity,
      counts: {
        total: diff.length,
        create: diff.filter((item) => item.action === "create").length,
        update: diff.filter((item) => item.action === "update").length,
        unchanged: diff.filter((item) => item.action === "unchanged").length,
      },
      diff,
      createdAt: new Date().toISOString(),
    };
    writeJson(runPath(runRoot, id, "manifest.json"), manifest);
    return { run: publicRun(manifest), coalesced: false };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function publishCollectionRun(db, runId, { expectedChecksum, sourcesConfig, timeZone, runRoot = COLLECTION_RUNS_DIR, afterApply } = {}) {
  const { filePath, manifest } = readManifest(runId, runRoot);
  const existingPublication = readPublication(db, runId);
  if (existingPublication) {
    if (!expectedChecksum || expectedChecksum !== existingPublication.requestChecksum) {
      throw pipelineError("Collection run checksum is stale", 409);
    }
    if (existingPublication.requestChecksum !== manifest.requestChecksum
      || existingPublication.databaseInstanceId !== databaseIdentity(db).instanceId) {
      throw pipelineError("Collection publication journal does not match this run", 409);
    }
    const repaired = synchronizePublishedManifest(filePath, manifest, existingPublication);
    return {
      run: publicRun(repaired),
      imported: existingPublication.imported.map((jobKey) => ({ jobKey })),
      recovered: true,
    };
  }
  if (manifest.status !== "staged") throw pipelineError("Only a staged collection run can be published", 409);
  if (!expectedChecksum || expectedChecksum !== manifest.requestChecksum) throw pipelineError("Collection run checksum is stale", 409);
  const identity = databaseIdentity(db);
  if (identity.instanceId !== manifest.database.instanceId || identity.jobsRevision !== Number(manifest.database.jobsRevision)) {
    throw pipelineError("Jobs changed after staging; create a new dry-run before publishing", 409);
  }
  const batchPath = runPath(runRoot, runId, "batch.json");
  const stagingPath = runPath(runRoot, runId, "staging.sqlite");
  if (checksum(fs.readFileSync(batchPath)) !== manifest.batchChecksum || checksum(fs.readFileSync(stagingPath)) !== manifest.stagingChecksum) {
    throw pipelineError("Collection run artifacts changed after staging", 409);
  }
  const staging = new DatabaseSync(stagingPath, { readOnly: true });
  try {
    if (staging.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" || staging.prepare("PRAGMA foreign_key_check").all().length) {
      throw pipelineError("Staging database no longer passes integrity validation", 409);
    }
  } finally { staging.close(); }
  const envelope = JSON.parse(fs.readFileSync(batchPath, "utf8"));
  const normalized = normalizeEnvelope(envelope, sourcesConfig);
  if (checksum(normalized) !== manifest.requestChecksum) throw pipelineError("Collection batch semantic checksum changed", 409);
  let publication;
  const imported = importJobsBatch(db, normalized.jobs, {
    timeZone,
    afterApply(items) {
      publication = {
        version: 1,
        runId,
        requestChecksum: manifest.requestChecksum,
        databaseInstanceId: identity.instanceId,
        baseRevision: identity.jobsRevision,
        publishedRevision: databaseIdentity(db).jobsRevision,
        imported: items.map((item) => item.jobKey),
        publishedAt: new Date().toISOString(),
      };
      recordPublication(db, publication);
      if (typeof afterApply === "function") afterApply(items, publication);
    },
  });
  const published = synchronizePublishedManifest(filePath, manifest, publication);
  return { run: publicRun(published), imported };
}

export function getCollectionRun(runId, { db = null, runRoot = COLLECTION_RUNS_DIR } = {}) {
  const { manifest } = readManifest(runId, runRoot);
  const publication = db ? readPublication(db, runId) : null;
  return publicRun(publication
    ? publishedManifest(manifest, publication, publicationArtifactIsSynchronized(manifest, publication))
    : manifest);
}

export function collectionAdapterContract() {
  return {
    schemaVersion: 1,
    note: "Use only official APIs, public pages, or user-supplied facts. Do not include credentials, private APIs, CAPTCHA bypasses, company ratings, or company reviews.",
    required: ["adapterId", "accessPolicy", "generatedAt", "jobs"],
    accessPolicies: [...ACCESS_POLICIES],
    projectRelativeRunRoot: path.relative(PROJECT_ROOT, COLLECTION_RUNS_DIR),
  };
}
