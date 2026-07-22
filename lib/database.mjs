import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION } from "./database-role.mjs";
import { prepareDatabase } from "./database-migrations.mjs";
import { DATA_DIR, PROJECT_ROOT } from "./paths.mjs";
import { builtinSectionKey } from "./document-sections.mjs";
import { selectPrimarySource } from "./source-selection.mjs";
import { normalizePublicHttpUrl } from "./public-url.mjs";
import { getLatestPackageForJob, publicPackage } from "./package-workflow.mjs";
import { deriveJobAllowedActions, deriveJobWorkflow } from "./workflow.mjs";
import { dateKey, deriveJobDeadline, deriveJobLifecycle, effectiveSource, normalizeDeadline } from "./deadlines.mjs";
import { normalizeJobFilters } from "./saved-filters.mjs";
import { appendApplicationEvent, createFollowUp } from "./outcome-ledger.mjs";
import {
  getStructuredResumeItems,
  listResumeAssets,
  normalizeStructuredItems,
  replaceStructuredResumeItems,
  resumeReadiness,
} from "./structured-records.mjs";

const demoJobsPath = path.join(PROJECT_ROOT, "examples", "demo", "jobs.json");
const demoApplicationsPath = path.join(PROJECT_ROOT, "examples", "demo", "applications.json");
const demoProfilePath = path.join(PROJECT_ROOT, "examples", "demo", "profile.json");
const demoOutcomesPath = path.join(PROJECT_ROOT, "examples", "demo", "outcomes.json");
const CLOSED_LIFECYCLE_STATUSES = new Set(["closed", "expired", "ended"]);
const defaultEditableSections = [
  "headline",
  "summary",
  "skills",
  "experience_highlights",
  "achievement_evidence",
  "representative_experience",
  "direct_scope",
  "collaboration_scope",
  "career_direction",
];

export function openDatabase(dbPath) {
  const directory = path.dirname(dbPath);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const relativeToData = path.relative(path.resolve(DATA_DIR), path.resolve(directory));
  const insideReleaseData = relativeToData === "" || (!relativeToData.startsWith(`..${path.sep}`) && relativeToData !== ".." && !path.isAbsolute(relativeToData));
  if (!directoryExisted || insideReleaseData) fs.chmodSync(directory, 0o700);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    fs.chmodSync(dbPath, 0o600);
    const versionValue = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get()?.value;
    const version = /^\d+$/.test(String(versionValue || "")) ? Number(versionValue) : null;
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`Database must be initialized before opening (expected schema ${CURRENT_SCHEMA_VERSION}, found ${version ?? "none"})`);
    }
    fs.chmodSync(dbPath, 0o600);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function upsertJob(db, job) {
  db.prepare(`
    INSERT INTO jobs (
      job_key, company_name, title, track, location, employment_type, lifecycle_status, deadline, deadline_source, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_key) DO UPDATE SET
      company_name = excluded.company_name,
      title = excluded.title,
      track = excluded.track,
      location = excluded.location,
      employment_type = excluded.employment_type,
      lifecycle_status = excluded.lifecycle_status,
      deadline = excluded.deadline,
      deadline_source = excluded.deadline_source,
      summary = excluded.summary,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    job.jobKey,
    job.companyName,
    job.title,
    job.track || "",
    job.location || "",
    job.employmentType || "",
    job.status || "unknown",
    job.deadline ?? null,
    job.deadlineSource || "",
    job.summary || "",
  );
  return db.prepare("SELECT id FROM jobs WHERE job_key = ?").get(job.jobKey).id;
}

function seedJobs(db, jobs) {
  const addSource = db.prepare(`
    INSERT INTO job_sources (
      job_id, platform, source_url, external_id, lifecycle_status, deadline, confidence,
      access_method, provenance_json, first_seen_at, last_seen_at, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', '{}', ?, ?, ?)
    ON CONFLICT(job_id, platform, source_url) DO UPDATE SET
      external_id = excluded.external_id,
      lifecycle_status = excluded.lifecycle_status,
      deadline = excluded.deadline,
      confidence = excluded.confidence,
      last_seen_at = excluded.last_seen_at,
      checked_at = excluded.checked_at
  `);
  const addScore = db.prepare(`
    INSERT INTO job_scores (job_id, total_score, breakdown_json)
    VALUES (?, ?, '{}')
    ON CONFLICT(job_id) DO UPDATE SET total_score = excluded.total_score, updated_at = CURRENT_TIMESTAMP
  `);
  const addTailoring = db.prepare(`
    INSERT INTO job_tailoring (job_id, focus_sections_json, application_questions_json)
    VALUES (?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      focus_sections_json = excluded.focus_sections_json,
      application_questions_json = excluded.application_questions_json,
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const job of jobs) {
    const jobId = upsertJob(db, job);
    for (const source of job.sources || []) {
      addSource.run(
        jobId,
        source.platform,
        source.url,
        source.externalId || "",
        source.status || "unknown",
        source.deadline || null,
        Number(source.confidence || 0),
        source.checkedAt || new Date().toISOString(),
        source.checkedAt || new Date().toISOString(),
        source.checkedAt || new Date().toISOString(),
      );
    }
    addScore.run(jobId, Number.isFinite(Number(job.score)) ? Number(job.score) : null);
    addTailoring.run(jobId, JSON.stringify(job.tailoringFocus || []), JSON.stringify(job.applicationQuestions || []));
  }
}

function seedApplications(db, applications) {
  const statement = db.prepare(`
    INSERT INTO application_state (job_id, favorite, workflow_status, note)
    SELECT id, ?, ?, ? FROM jobs WHERE job_key = ?
    ON CONFLICT(job_id) DO UPDATE SET
      favorite = excluded.favorite,
      workflow_status = excluded.workflow_status,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const item of applications) {
    statement.run(item.favorite ? 1 : 0, item.workflowStatus || "new", item.note || "", item.jobKey);
  }
}

function seedResume(db, profile) {
  db.prepare(`
    INSERT INTO resume_profile (
      id, job_family, job_role, career_type, career_stage, years_experience, school, major,
      headline, summary, skills_json, certificates_json, experience_highlights_json,
      achievement_evidence, representative_experience, direct_scope, collaboration_scope,
      career_direction, editable_sections_json
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      job_family = excluded.job_family,
      job_role = excluded.job_role,
      career_type = excluded.career_type,
      career_stage = excluded.career_stage,
      years_experience = excluded.years_experience,
      school = excluded.school,
      major = excluded.major,
      headline = excluded.headline,
      summary = excluded.summary,
      skills_json = excluded.skills_json,
      certificates_json = excluded.certificates_json,
      experience_highlights_json = excluded.experience_highlights_json,
      achievement_evidence = excluded.achievement_evidence,
      representative_experience = excluded.representative_experience,
      direct_scope = excluded.direct_scope,
      collaboration_scope = excluded.collaboration_scope,
      career_direction = excluded.career_direction,
      editable_sections_json = excluded.editable_sections_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    profile.jobFamily || "",
    profile.jobRole || "",
    profile.careerType === "experienced" ? "experienced" : "new",
    profile.careerStage || "",
    optionalFiniteNumber(profile.yearsExperience),
    profile.school || "",
    profile.major || "",
    profile.headline || "",
    profile.summary || "",
    JSON.stringify(profile.skills || []),
    JSON.stringify(profile.certificates || []),
    JSON.stringify(profile.experienceHighlights || []),
    profile.achievementEvidence || "",
    profile.representativeExperience || "",
    profile.directScope || "",
    profile.collaborationScope || "",
    profile.careerDirection || "",
    JSON.stringify(profile.editableSections || defaultEditableSections),
  );
}

function seedOutcomes(db, input = {}) {
  const eventIds = new Map();
  for (const item of Array.isArray(input.events) ? input.events : []) {
    const job = db.prepare("SELECT id FROM jobs WHERE job_key = ?").get(item.jobKey);
    if (!job) continue;
    const result = appendApplicationEvent(db, Number(job.id), item);
    eventIds.set(item.eventKey, result.event.id);
  }
  for (const item of Array.isArray(input.followUps) ? input.followUps : []) {
    const job = db.prepare("SELECT id FROM jobs WHERE job_key = ?").get(item.jobKey);
    const sourceEventId = eventIds.get(item.sourceEventKey);
    if (!job || !sourceEventId) continue;
    createFollowUp(db, Number(job.id), {
      title: item.title,
      sourceEventId,
      offsetDays: item.offsetDays,
    }, { timeZone: "Asia/Seoul", now: new Date("2026-07-20T00:00:00.000Z") });
  }
}

export function initializeDatabase(dbPath, { mode = "demo", resetDemo = false } = {}) {
  prepareDatabase(dbPath, { mode });
  const db = openDatabase(dbPath);
  try {
    if (mode === "demo") {
      const alreadySeeded = db.prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded'").get();
      if (resetDemo) {
        db.exec("DELETE FROM local_notifications; DELETE FROM follow_ups; DELETE FROM application_events; DELETE FROM agent_task_reviews; DELETE FROM agent_tasks; DELETE FROM saved_filters; DELETE FROM package_submissions; DELETE FROM package_approvals; DELETE FROM package_revisions; DELETE FROM application_packages; DELETE FROM job_tailoring; DELETE FROM job_sources; DELETE FROM job_scores; DELETE FROM application_state; DELETE FROM jobs; DELETE FROM profile_facts; DELETE FROM evidence_items; DELETE FROM resume_custom_sections; DELETE FROM resume_structured_items; DELETE FROM source_documents; DELETE FROM resume_profile;");
      }
      if (!alreadySeeded || resetDemo) {
        seedJobs(db, JSON.parse(fs.readFileSync(demoJobsPath, "utf8")));
        seedApplications(db, JSON.parse(fs.readFileSync(demoApplicationsPath, "utf8")));
        seedResume(db, JSON.parse(fs.readFileSync(demoProfilePath, "utf8")));
        seedOutcomes(db, JSON.parse(fs.readFileSync(demoOutcomesPath, "utf8")));
        db.prepare(`
          INSERT INTO app_meta (key, value) VALUES ('demo_seeded', 'true')
          ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = CURRENT_TIMESTAMP
        `).run();
      }
    } else {
      db.prepare("INSERT OR IGNORE INTO resume_profile (id) VALUES (1)").run();
    }
  } finally {
    db.close();
  }
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function databaseInputError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function databaseNotFoundError(message) {
  return Object.assign(new Error(message), { statusCode: 404 });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value, field, maximumLength, { fallback = "" } = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string" && typeof value !== "number") {
    throw databaseInputError(`${field} must be text`);
  }
  return String(value).trim().slice(0, maximumLength);
}

const LIFECYCLE_STATUS_ALIASES = new Map([
  ["active", "active"],
  ["open", "active"],
  ["published", "active"],
  ["closed", "closed"],
  ["expired", "closed"],
  ["ended", "closed"],
  ["unknown", "unknown"],
]);

function normalizedLifecycleStatus(value, field, { fallback = "unknown" } = {}) {
  const raw = normalizedText(value, field, 40, { fallback }).toLowerCase() || fallback;
  const normalized = LIFECYCLE_STATUS_ALIASES.get(raw);
  if (!normalized) throw databaseInputError(`${field} must be active, closed, or unknown`);
  return normalized;
}

function normalizeSourceProvenance(value, index) {
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) throw databaseInputError(`sources[${index}].provenance must be an object`);
  const allowed = new Set(["adapterId", "retrievalMethod", "retrievedAt", "sourceId", "note"]);
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw databaseInputError(`sources[${index}].provenance contains unsupported field: ${key}`);
    result[key] = normalizedText(raw, `sources[${index}].provenance.${key}`, key === "note" ? 500 : 160);
  }
  return result;
}

function normalizeImportSources(input) {
  if (!Object.hasOwn(input, "sources")) return undefined;
  if (input.sources === null) return [];
  if (!Array.isArray(input.sources)) throw databaseInputError("sources must be an array or null");
  if (input.sources.length > 20) throw databaseInputError("sources cannot contain more than 20 items");

  const now = new Date().toISOString();
  return input.sources.map((source, index) => {
    if (!isPlainObject(source)) throw databaseInputError(`sources[${index}] must be an object`);
    const platform = normalizedText(source.platform, `sources[${index}].platform`, 60);
    if (!platform) throw databaseInputError(`sources[${index}].platform is required`);

    const rawUrl = normalizedText(source.url, `sources[${index}].url`, 4000);
    if (!rawUrl) throw databaseInputError(`sources[${index}].url is required`);
    const url = normalizePublicHttpUrl(rawUrl, `sources[${index}].url`);

    let confidence = 0;
    if (source.confidence !== null && source.confidence !== undefined && String(source.confidence).trim() !== "") {
      if (typeof source.confidence === "boolean") {
        throw databaseInputError(`sources[${index}].confidence must be a number between 0 and 100`);
      }
      confidence = Number(source.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
        throw databaseInputError(`sources[${index}].confidence must be a number between 0 and 100`);
      }
    }

    let checkedAt = now;
    if (source.checkedAt !== null && source.checkedAt !== undefined && String(source.checkedAt).trim() !== "") {
      const timestamp = Date.parse(String(source.checkedAt));
      if (!Number.isFinite(timestamp)) throw databaseInputError(`sources[${index}].checkedAt must be a valid date`);
      checkedAt = new Date(timestamp).toISOString();
    }

    const accessMethod = normalizedText(source.accessMethod, `sources[${index}].accessMethod`, 40, { fallback: "import" }) || "import";
    if (!new Set(["official_api", "public_page", "manual", "user_agent", "import"]).has(accessMethod)) {
      throw databaseInputError(`sources[${index}].accessMethod is unsupported`);
    }
    return {
      platform,
      url,
      externalId: normalizedText(source.externalId, `sources[${index}].externalId`, 160),
      status: normalizedLifecycleStatus(source.status, `sources[${index}].status`),
      confidence,
      checkedAt,
      deadline: normalizeDeadline(source.deadline, `sources[${index}].deadline`, { allowUndefined: true }),
      accessMethod,
      provenance: normalizeSourceProvenance(source.provenance, index),
    };
  });
}

function normalizeImportScore(input) {
  if (!Object.hasOwn(input, "score")) return undefined;
  if (input.score === null || (typeof input.score === "string" && !input.score.trim())) return null;
  if (typeof input.score === "boolean") throw databaseInputError("Score must be a number between 0 and 100");
  const score = Number(input.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw databaseInputError("Score must be a number between 0 and 100");
  }
  return score;
}

function normalizeImportScoreBreakdown(input, scoringProfile) {
  if (!Object.hasOwn(input, "scoreBreakdown")) return undefined;
  if (input.scoreBreakdown === null) return null;
  if (!isPlainObject(input.scoreBreakdown)) throw databaseInputError("scoreBreakdown must be an object or null");
  if (!scoringProfile?.configured || !Array.isArray(scoringProfile.dimensions) || !scoringProfile.dimensions.length) {
    throw databaseInputError("Configure a scoring profile before importing scoreBreakdown");
  }
  const profileChecksum = normalizedText(input.scoreBreakdown.profileChecksum, "scoreBreakdown.profileChecksum", 128);
  if (!profileChecksum || profileChecksum !== scoringProfile.checksum) {
    throw Object.assign(new Error("Scoring profile changed; refresh the profile before importing scoreBreakdown"), { statusCode: 409 });
  }
  if (!Array.isArray(input.scoreBreakdown.dimensions)) {
    throw databaseInputError("scoreBreakdown.dimensions must be an array");
  }
  const expected = new Map(scoringProfile.dimensions.map((item) => [item.id, item]));
  const seen = new Set();
  const dimensions = input.scoreBreakdown.dimensions.map((item, index) => {
    if (!isPlainObject(item)) throw databaseInputError(`scoreBreakdown.dimensions[${index}] must be an object`);
    const id = normalizedText(item.id, `scoreBreakdown.dimensions[${index}].id`, 100);
    if (!expected.has(id)) throw databaseInputError(`Unknown scoring dimension: ${id}`);
    if (seen.has(id)) throw databaseInputError(`Duplicate scoring dimension: ${id}`);
    seen.add(id);
    if (typeof item.score === "boolean") throw databaseInputError(`scoreBreakdown.dimensions[${index}].score must be between 0 and 100`);
    const score = Number(item.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw databaseInputError(`scoreBreakdown.dimensions[${index}].score must be between 0 and 100`);
    }
    if (!Array.isArray(item.evidenceRefs)) throw databaseInputError(`scoreBreakdown.dimensions[${index}].evidenceRefs must be an array`);
    if (!Array.isArray(item.gaps)) throw databaseInputError(`scoreBreakdown.dimensions[${index}].gaps must be an array`);
    const evidenceRefs = item.evidenceRefs
      .map((value) => normalizedText(value, `scoreBreakdown.dimensions[${index}].evidenceRefs`, 120)).filter(Boolean).slice(0, 30);
    const gaps = item.gaps
      .map((value) => normalizedText(value, `scoreBreakdown.dimensions[${index}].gaps`, 300)).filter(Boolean).slice(0, 20);
    const reason = normalizedText(item.reason, `scoreBreakdown.dimensions[${index}].reason`, 2000);
    if (!reason) throw databaseInputError(`scoreBreakdown.dimensions[${index}].reason is required`);
    return {
      id,
      label: expected.get(id).label,
      weight: Number(expected.get(id).weight),
      score,
      reason,
      evidenceRefs,
      gaps,
    };
  });
  const missing = [...expected.keys()].filter((id) => !seen.has(id));
  if (missing.length) throw databaseInputError(`Missing scoring dimensions: ${missing.join(", ")}`);
  const total = dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) / 100;
  return { profileChecksum, dimensions, total: Math.round(total * 100) / 100 };
}

function normalizeTailoringFocus(input) {
  if (!Object.hasOwn(input, "tailoringFocus")) return undefined;
  if (input.tailoringFocus === null) return [];
  if (!Array.isArray(input.tailoringFocus)) {
    throw databaseInputError("tailoringFocus must be an array or null");
  }
  if (input.tailoringFocus.length > 30) {
    throw databaseInputError("tailoringFocus cannot contain more than 30 items");
  }
  const normalized = [];
  for (const [index, value] of input.tailoringFocus.entries()) {
    if (typeof value !== "string") throw databaseInputError(`tailoringFocus[${index}] must be text`);
    const section = value.trim();
    if (section && !normalized.includes(section)) normalized.push(section);
  }
  return normalized;
}

function normalizeApplicationQuestions(input) {
  if (!Object.hasOwn(input, "applicationQuestions")) return undefined;
  if (input.applicationQuestions === null) return [];
  if (!Array.isArray(input.applicationQuestions)) {
    throw databaseInputError("applicationQuestions must be an array or null");
  }
  if (input.applicationQuestions.length > 20) {
    throw databaseInputError("applicationQuestions cannot contain more than 20 items");
  }

  const questionIds = new Set();
  return input.applicationQuestions.map((question, index) => {
    if (!isPlainObject(question)) {
      throw databaseInputError(`applicationQuestions[${index}] must be an object`);
    }
    const id = normalizedText(question.id, `applicationQuestions[${index}].id`, 80)
      || `question-${index + 1}`;
    if (questionIds.has(id)) throw databaseInputError(`Duplicate application question id: ${id}`);
    questionIds.add(id);

    const labelValue = question.label ?? question.question;
    const label = normalizedText(labelValue, `applicationQuestions[${index}].label`, 300);
    if (!label) throw databaseInputError(`applicationQuestions[${index}].label is required`);
    if (question.required !== undefined && question.required !== null && typeof question.required !== "boolean") {
      throw databaseInputError(`applicationQuestions[${index}].required must be a boolean`);
    }

    let maxLength = 2000;
    if (question.maxLength !== undefined && question.maxLength !== null && String(question.maxLength).trim() !== "") {
      if (typeof question.maxLength === "boolean") {
        throw databaseInputError(`applicationQuestions[${index}].maxLength must be an integer between 100 and 10000`);
      }
      maxLength = Number(question.maxLength);
      if (!Number.isInteger(maxLength) || maxLength < 100 || maxLength > 10000) {
        throw databaseInputError(`applicationQuestions[${index}].maxLength must be an integer between 100 and 10000`);
      }
    }

    return { id, label, required: question.required !== false, maxLength };
  });
}

function normalizeJobImport(input, options = {}) {
  if (!isPlainObject(input)) throw databaseInputError("Job import body must be an object");
  const required = {
    jobKey: 180,
    companyName: 200,
    title: 240,
  };
  const normalized = {};
  for (const [field, maximumLength] of Object.entries(required)) {
    normalized[field] = normalizedText(input[field], field, maximumLength);
    if (!normalized[field]) throw databaseInputError(`Missing required field: ${field}`);
  }

  const optional = {
    track: { maximumLength: 120, fallback: "" },
    location: { maximumLength: 160, fallback: "" },
    employmentType: { maximumLength: 80, fallback: "" },
    summary: { maximumLength: 5000, fallback: "" },
  };
  for (const [field, options] of Object.entries(optional)) {
    if (!Object.hasOwn(input, field)) continue;
    normalized[field] = normalizedText(input[field], field, options.maximumLength, { fallback: options.fallback });
  }
  if (Object.hasOwn(input, "status")) normalized.status = normalizedLifecycleStatus(input.status, "status");
  normalized.deadline = normalizeDeadline(input.deadline, "deadline", { allowUndefined: true });
  if (Object.hasOwn(input, "deadlineSource")) normalized.deadlineSource = normalizedText(input.deadlineSource, "deadlineSource", 160);

  normalized.sources = normalizeImportSources(input);
  if (Object.hasOwn(input, "score") && Object.hasOwn(input, "scoreBreakdown")) {
    throw databaseInputError("Provide either score or scoreBreakdown, not both");
  }
  normalized.score = normalizeImportScore(input);
  normalized.scoreBreakdown = normalizeImportScoreBreakdown(input, options.scoringProfile);
  normalized.tailoringFocus = normalizeTailoringFocus(input);
  normalized.applicationQuestions = normalizeApplicationQuestions(input);
  return normalized;
}

function inImmediateTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original failure; a rollback error cannot make it more actionable.
    }
    throw error;
  }
}

export function listJobs(db, sourcesConfig, packageOptions = {}) {
  const rows = db.prepare(`
    SELECT
      j.*,
      s.total_score,
      s.breakdown_json,
      COALESCE(s.score_mode, 'none') AS score_mode,
      COALESCE(s.profile_checksum, '') AS score_profile_checksum,
      COALESCE(a.favorite, 0) AS favorite,
      COALESCE(a.workflow_status, 'new') AS workflow_status,
      COALESCE(a.note, '') AS note
    FROM jobs j
    LEFT JOIN job_scores s ON s.job_id = j.id
    LEFT JOIN application_state a ON a.job_id = j.id
    ORDER BY COALESCE(s.total_score, -1) DESC, j.company_name, j.title
  `).all();
  return rows.map((row) => hydrateJob(db, row, sourcesConfig, packageOptions));
}

function hydrateJob(db, row, sourcesConfig, packageOptions = {}) {
  const sourceStatement = db.prepare(`
    SELECT
      platform,
      source_url AS url,
      external_id AS externalId,
      lifecycle_status AS status,
      deadline,
      confidence,
      access_method AS accessMethod,
      provenance_json AS provenanceJson,
      first_seen_at AS firstSeenAt,
      last_seen_at AS lastSeenAt,
      checked_at AS checkedAt
    FROM job_sources
    WHERE job_id = ?
  `);
  const allSources = sourceStatement.all(row.id).map((source) => effectiveSource({
      ...source,
      provenance: safeJson(source.provenanceJson, {}),
    }, packageOptions.now, packageOptions.timeZone));
    const sources = allSources.filter((source) => sourcesConfig?.sources?.[source.platform]?.display !== false);
  const job = {
      id: row.id,
      jobKey: row.job_key,
      companyName: row.company_name,
      title: row.title,
      track: row.track,
      location: row.location,
      employmentType: row.employment_type,
      status: deriveJobLifecycle(row.lifecycle_status, allSources, row.deadline, packageOptions.now, packageOptions.timeZone),
      ...deriveJobDeadline(row.deadline, allSources, packageOptions.now, packageOptions.timeZone),
      deadlineSource: row.deadline_source || "",
      summary: row.summary,
      discovery: {
        isNew: row.workflow_status === "new",
        isReopened: Number(row.reopen_count || 0) > 0,
        reopenedAt: row.reopened_at || "",
        reopenCount: Number(row.reopen_count || 0),
        firstSeenAt: row.created_at,
      },
      score: row.total_score,
      scoreMode: row.score_mode,
      scoreBreakdown: row.score_mode === "breakdown" ? safeJson(row.breakdown_json, null) : null,
      scoreProfileChecksum: row.score_profile_checksum,
      sources,
      primarySource: selectPrimarySource(allSources, sourcesConfig),
      application: {
        favorite: Boolean(row.favorite),
        workflowStatus: row.workflow_status,
        note: row.note,
      },
      package: publicPackage(getLatestPackageForJob(db, row.id, packageOptions)),
  };
  job.workflow = deriveJobWorkflow(job);
  job.allowedActions = deriveJobAllowedActions(job);
  return job;
}

function selectJobRow(db, jobId) {
  return db.prepare(`
    SELECT
      j.*,
      s.total_score,
      s.breakdown_json,
      COALESCE(s.score_mode, 'none') AS score_mode,
      COALESCE(s.profile_checksum, '') AS score_profile_checksum,
      COALESCE(a.favorite, 0) AS favorite,
      COALESCE(a.workflow_status, 'new') AS workflow_status,
      COALESCE(a.note, '') AS note
    FROM jobs j
    LEFT JOIN job_scores s ON s.job_id = j.id
    LEFT JOIN application_state a ON a.job_id = j.id
    WHERE j.id = ?
  `).get(jobId);
}

export function getJobDetail(db, jobId, sourcesConfig, packageOptions = {}) {
  const row = selectJobRow(db, jobId);
  if (!row) throw databaseNotFoundError("Job not found");
  return hydrateJob(db, row, sourcesConfig, packageOptions);
}

export function publicJobSummary(job) {
  return {
    id: job.id,
    jobKey: job.jobKey,
    companyName: job.companyName,
    title: job.title,
    track: job.track,
    location: job.location,
    employmentType: job.employmentType,
    status: job.status,
    deadline: job.deadline,
    deadlineDays: job.deadlineDays,
    deadlineSource: job.deadlineSource,
    summary: job.summary,
    discovery: job.discovery,
    score: job.score,
    scoreMode: job.scoreMode,
    application: job.application,
    sources: job.sources.map((source) => ({
      platform: source.platform,
      status: source.status,
      deadline: source.deadline,
      checkedAt: source.checkedAt,
    })),
    sourceCount: job.sources.length,
    primarySource: job.primarySource ? {
      platform: job.primarySource.platform,
      status: job.primarySource.status,
    } : null,
    package: job.package ? {
      id: job.package.id,
      version: job.package.version,
      state: job.package.state,
      quality: {
        status: job.package.quality?.status || "review",
        score: Number(job.package.quality?.score || 0),
      },
      pdf: { available: Boolean(job.package.pdf?.available) },
      refreshRequired: job.package.refreshRequired,
      refreshAvailable: job.package.refreshAvailable,
      updatedAt: job.package.updatedAt,
    } : null,
    workflow: job.workflow,
    allowedActions: job.allowedActions,
  };
}

function effectivePageExpressions(today) {
  const effectiveDeadline = (alias) => `COALESCE(${alias}.deadline, j.deadline)`;
  const activeSource = `EXISTS (
    SELECT 1 FROM job_sources active_source
    WHERE active_source.job_id = j.id
      AND active_source.lifecycle_status = 'active'
      AND (${effectiveDeadline("active_source")} IS NULL OR ${effectiveDeadline("active_source")} >= '${today}')
  )`;
  const nonClosedSource = `EXISTS (
    SELECT 1 FROM job_sources open_source
    WHERE open_source.job_id = j.id
      AND open_source.lifecycle_status <> 'closed'
      AND (${effectiveDeadline("open_source")} IS NULL OR ${effectiveDeadline("open_source")} >= '${today}')
  )`;
  const hasSources = "EXISTS (SELECT 1 FROM job_sources any_source WHERE any_source.job_id = j.id)";
  const unknownOpenDeadline = `EXISTS (
    SELECT 1 FROM job_sources unknown_deadline_source
    WHERE unknown_deadline_source.job_id = j.id
      AND unknown_deadline_source.lifecycle_status <> 'closed'
      AND ${effectiveDeadline("unknown_deadline_source")} IS NULL
  )`;
  const openDeadline = `(SELECT MAX(${effectiveDeadline("open_deadline_source")}) FROM job_sources open_deadline_source
    WHERE open_deadline_source.job_id = j.id
      AND open_deadline_source.lifecycle_status <> 'closed'
      AND (${effectiveDeadline("open_deadline_source")} IS NULL OR ${effectiveDeadline("open_deadline_source")} >= '${today}'))`;
  const finalDeadline = `(SELECT MAX(${effectiveDeadline("final_deadline_source")}) FROM job_sources final_deadline_source
    WHERE final_deadline_source.job_id = j.id)`;
  return {
    deadline: `CASE
      WHEN ${nonClosedSource} AND ${unknownOpenDeadline} THEN NULL
      WHEN ${nonClosedSource} THEN ${openDeadline}
      WHEN ${hasSources} THEN ${finalDeadline}
      ELSE j.deadline END`,
    lifecycle: `CASE
      WHEN ${activeSource} THEN 'active'
      WHEN ${hasSources} AND NOT ${nonClosedSource} THEN 'closed'
      WHEN NOT ${hasSources} AND j.deadline < '${today}' THEN 'closed'
      ELSE j.lifecycle_status END`,
  };
}

export function databaseRevisions(db) {
  return Object.fromEntries(db.prepare("SELECT scope, revision FROM system_revisions ORDER BY scope").all()
    .map((row) => [row.scope, Number(row.revision)]));
}

export function listJobPage(db, sourcesConfig, options = {}) {
  const filters = normalizeJobFilters(options.filters || {});
  const page = Math.max(1, Number.isInteger(Number(options.page)) ? Number(options.page) : 1);
  const pageSize = Math.max(1, Math.min(100, Number.isInteger(Number(options.pageSize)) ? Number(options.pageSize) : 30));
  const now = options.now instanceof Date ? options.now : new Date();
  const today = dateKey(now, options.timeZone);
  const urgent = new Date(`${today}T00:00:00.000Z`);
  urgent.setUTCDate(urgent.getUTCDate() + 7);
  const urgentEnd = urgent.toISOString().slice(0, 10);
  const expressions = effectivePageExpressions(today);
  const conditions = [];
  const values = [];
  if (filters.search) {
    conditions.push("LOWER(j.company_name || ' ' || j.title || ' ' || j.summary) LIKE ?");
    values.push(`%${filters.search.toLowerCase()}%`);
  }
  if (filters.track) { conditions.push("j.track = ?"); values.push(filters.track); }
  if (filters.region) { conditions.push("LOWER(j.location) LIKE ?"); values.push(`%${filters.region.toLowerCase()}%`); }
  if (filters.score === "unset") conditions.push("s.total_score IS NULL");
  else if (filters.score) { conditions.push("s.total_score >= ?"); values.push(Number(filters.score)); }
  if (filters.platform) {
    conditions.push("EXISTS (SELECT 1 FROM job_sources platform_source WHERE platform_source.job_id = j.id AND platform_source.platform = ?)");
    values.push(filters.platform);
  }
  if (filters.status) { conditions.push("COALESCE(a.workflow_status, 'new') = ?"); values.push(filters.status); }
  if (filters.favorite) conditions.push("COALESCE(a.favorite, 0) = 1");
  if (filters.lifecycle === "active") {
    conditions.push(`${expressions.lifecycle} NOT IN ('closed', 'expired', 'ended')`);
    conditions.push("COALESCE(a.workflow_status, 'new') NOT IN ('skipped', 'rejected')");
  } else if (filters.lifecycle === "archive") {
    conditions.push(`(${expressions.lifecycle} IN ('closed', 'expired', 'ended') OR COALESCE(a.workflow_status, 'new') IN ('skipped', 'rejected'))`);
  }
  if (filters.deadline === "urgent") conditions.push(`${expressions.deadline} BETWEEN '${today}' AND '${urgentEnd}'`);
  else if (filters.deadline === "overdue") conditions.push(`${expressions.deadline} < '${today}'`);
  else if (filters.deadline === "none") conditions.push(`${expressions.deadline} IS NULL`);
  if (filters.condition === "remote") conditions.push("(LOWER(j.location || ' ' || j.employment_type) LIKE '%remote%' OR j.location LIKE '%원격%')");
  else if (filters.condition === "fulltime") conditions.push("(LOWER(j.employment_type) LIKE '%full%' OR j.employment_type LIKE '%정규%')");
  else if (filters.condition === "contract") conditions.push("(LOWER(j.employment_type) LIKE '%contract%' OR j.employment_type LIKE '%계약%')");
  else if (filters.condition === "entry") conditions.push("(LOWER(j.title || ' ' || j.summary) LIKE '%entry%' OR LOWER(j.title || ' ' || j.summary) LIKE '%junior%' OR (j.title || ' ' || j.summary) LIKE '%신입%' OR (j.title || ' ' || j.summary) LIKE '%경력 무관%')");
  else if (filters.condition === "experienced") conditions.push("(LOWER(j.title || ' ' || j.summary) LIKE '%experienced%' OR LOWER(j.title || ' ' || j.summary) LIKE '%senior%' OR LOWER(j.title || ' ' || j.summary) LIKE '%lead%' OR (j.title || ' ' || j.summary) LIKE '%경력%')");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = filters.sort === "deadline"
    ? `${expressions.deadline} IS NULL, ${expressions.deadline}, j.company_name, j.id`
    : filters.sort === "recent"
      ? `(SELECT MAX(checked_at) FROM job_sources recent_source WHERE recent_source.job_id = j.id) DESC, j.company_name, j.id`
      : filters.sort === "company"
        ? "j.company_name, j.title, j.id"
        : `COALESCE(s.total_score, -1) DESC, j.company_name, j.title, j.id`;
  const joins = "LEFT JOIN job_scores s ON s.job_id = j.id LEFT JOIN application_state a ON a.job_id = j.id";
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM jobs j ${joins} ${where}`).get(...values).count);
  const ids = db.prepare(`SELECT j.id FROM jobs j ${joins} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...values, pageSize, (page - 1) * pageSize).map((row) => Number(row.id));
  const items = ids.map((jobId) => publicJobSummary(getJobDetail(db, jobId, sourcesConfig, { ...options, now })));
  const displayPlatforms = new Set(Object.entries(sourcesConfig?.sources || {})
    .filter(([, source]) => source.display !== false).map(([key]) => key));
  const trackCounts = Object.fromEntries(db.prepare("SELECT track, COUNT(*) AS count FROM jobs WHERE track <> '' GROUP BY track ORDER BY track")
    .all().map((row) => [row.track, Number(row.count)]));
  const summaryCounts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(a.favorite, 0) = 1 THEN 1 ELSE 0 END) AS favorite,
      SUM(CASE WHEN COALESCE(a.workflow_status, 'new') IN ('applied', 'interview', 'offer') THEN 1 ELSE 0 END) AS applied,
      SUM(CASE WHEN COALESCE(a.workflow_status, 'new') IN ('skipped', 'rejected') THEN 1 ELSE 0 END) AS skipped
    FROM jobs j LEFT JOIN application_state a ON a.job_id = j.id
  `).get();
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    filters,
    facets: {
      tracks: db.prepare("SELECT DISTINCT track FROM jobs WHERE track <> '' ORDER BY track").all().map((row) => row.track),
      locations: db.prepare("SELECT DISTINCT location FROM jobs WHERE location <> '' ORDER BY location").all().map((row) => row.location),
      platforms: db.prepare("SELECT DISTINCT platform FROM job_sources ORDER BY platform").all()
        .map((row) => row.platform).filter((platform) => displayPlatforms.has(platform)),
      counts: {
        total: Number(summaryCounts.total || 0), favorite: Number(summaryCounts.favorite || 0),
        applied: Number(summaryCounts.applied || 0), skipped: Number(summaryCounts.skipped || 0), track: trackCounts,
      },
    },
    revisions: databaseRevisions(db),
  };
}

export function updateApplicationState(db, jobId, patch) {
  const current = db.prepare(`
    SELECT COALESCE(favorite, 0) AS favorite, COALESCE(workflow_status, 'new') AS workflow_status,
           COALESCE(note, '') AS note
    FROM jobs j LEFT JOIN application_state a ON a.job_id = j.id WHERE j.id = ?
  `).get(jobId);
  if (!current) throw databaseNotFoundError("Job not found");
  if (!isPlainObject(patch)) throw databaseInputError("Application state patch must be an object");
  const allowedStatuses = new Set(["new", "reviewing", "skipped", "applied", "interview", "offer", "rejected"]);
  const workflowStatus = patch.workflowStatus ?? current.workflow_status;
  if (!allowedStatuses.has(workflowStatus)) throw databaseInputError("Unsupported workflow status");
  if (patch.favorite !== undefined && typeof patch.favorite !== "boolean") {
    throw databaseInputError("Favorite must be true or false");
  }
  const note = String(patch.note ?? current.note).slice(0, 2000);
  const favorite = patch.favorite === undefined ? Boolean(current.favorite) : patch.favorite;
  db.prepare(`
    INSERT INTO application_state (job_id, favorite, workflow_status, note)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      favorite = excluded.favorite,
      workflow_status = excluded.workflow_status,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `).run(jobId, favorite ? 1 : 0, workflowStatus, note);
}

function applyNormalizedJob(db, normalized, options = {}) {
    if (normalized.scoreBreakdown) {
      const knownEvidence = new Set(db.prepare("SELECT id FROM evidence_items").all().map((item) => item.id));
      const unknownEvidence = normalized.scoreBreakdown.dimensions
        .flatMap((item) => item.evidenceRefs)
        .filter((id) => !knownEvidence.has(id));
      if (unknownEvidence.length) throw databaseInputError(`Unknown evidence reference: ${[...new Set(unknownEvidence)].join(", ")}`);
    }
    const existingJob = db.prepare("SELECT * FROM jobs WHERE job_key = ?").get(normalized.jobKey);
    const previousSources = existingJob ? db.prepare("SELECT lifecycle_status AS status, deadline FROM job_sources WHERE job_id = ?")
      .all(existingJob.id).map((source) => effectiveSource(source, options.now, options.timeZone)) : [];
    const previousLifecycle = existingJob
      ? deriveJobLifecycle(existingJob.lifecycle_status, previousSources, existingJob.deadline, options.now, options.timeZone)
      : null;
    const job = {
      jobKey: normalized.jobKey,
      companyName: normalized.companyName,
      title: normalized.title,
      track: normalized.track ?? existingJob?.track ?? "",
      location: normalized.location ?? existingJob?.location ?? "",
      employmentType: normalized.employmentType ?? existingJob?.employment_type ?? "",
      status: normalized.status ?? existingJob?.lifecycle_status ?? "unknown",
      deadline: normalized.deadline === undefined ? existingJob?.deadline ?? null : normalized.deadline,
      deadlineSource: normalized.deadlineSource ?? existingJob?.deadline_source ?? "",
      summary: normalized.summary ?? existingJob?.summary ?? "",
    };
    const jobId = upsertJob(db, job);

    if (normalized.sources !== undefined) {
      if (normalized.sources.length === 0) {
        db.prepare("DELETE FROM job_sources WHERE job_id = ?").run(jobId);
      } else {
        const addSource = db.prepare(`
          INSERT INTO job_sources (
            job_id, platform, source_url, external_id, lifecycle_status, deadline, confidence,
            access_method, provenance_json, first_seen_at, last_seen_at, checked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id, platform, source_url) DO UPDATE SET
            external_id = excluded.external_id,
            lifecycle_status = excluded.lifecycle_status,
            deadline = excluded.deadline,
            confidence = excluded.confidence,
            access_method = excluded.access_method,
            provenance_json = excluded.provenance_json,
            last_seen_at = excluded.last_seen_at,
            checked_at = excluded.checked_at
        `);
        for (const source of normalized.sources) {
          const existingSource = db.prepare(`
            SELECT deadline, first_seen_at FROM job_sources
            WHERE job_id = ? AND platform = ? AND source_url = ?
          `).get(jobId, source.platform, source.url);
          addSource.run(
            jobId,
            source.platform,
            source.url,
            source.externalId,
            source.status,
            source.deadline === undefined ? existingSource?.deadline ?? null : source.deadline,
            source.confidence,
            source.accessMethod,
            JSON.stringify(source.provenance),
            existingSource?.first_seen_at || source.checkedAt,
            source.checkedAt,
            source.checkedAt,
          );
        }
      }
    }
    const currentSources = db.prepare("SELECT lifecycle_status AS status, deadline FROM job_sources WHERE job_id = ?")
      .all(jobId).map((source) => effectiveSource(source, options.now, options.timeZone));
    const currentLifecycle = deriveJobLifecycle(job.status, currentSources, job.deadline, options.now, options.timeZone);
    const reopened = Boolean(existingJob) && CLOSED_LIFECYCLE_STATUSES.has(previousLifecycle) && currentLifecycle === "active";
    db.prepare(`UPDATE jobs SET lifecycle_status = ?,
      reopened_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE reopened_at END,
      reopen_count = reopen_count + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(currentLifecycle, reopened ? 1 : 0, reopened ? 1 : 0, jobId);

    if (normalized.score !== undefined) {
      db.prepare(`
        INSERT INTO job_scores (job_id, total_score, score_mode, profile_checksum) VALUES (?, ?, ?, '')
        ON CONFLICT(job_id) DO UPDATE SET
          total_score = excluded.total_score,
          score_mode = excluded.score_mode,
          profile_checksum = '',
          updated_at = CURRENT_TIMESTAMP
      `).run(jobId, normalized.score, normalized.score === null ? "none" : "scalar");
    }

    if (normalized.scoreBreakdown !== undefined) {
      const value = normalized.scoreBreakdown;
      db.prepare(`
        INSERT INTO job_scores (job_id, total_score, breakdown_json, score_mode, profile_checksum)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          total_score = excluded.total_score,
          breakdown_json = excluded.breakdown_json,
          score_mode = excluded.score_mode,
          profile_checksum = excluded.profile_checksum,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        jobId,
        value?.total ?? null,
        JSON.stringify(value ? { dimensions: value.dimensions } : {}),
        value ? "breakdown" : "none",
        value?.profileChecksum || "",
      );
    }

    if (normalized.tailoringFocus !== undefined || normalized.applicationQuestions !== undefined) {
      const existingTailoring = db.prepare("SELECT * FROM job_tailoring WHERE job_id = ?").get(jobId);
      const focusSections = normalized.tailoringFocus
        ?? safeJson(existingTailoring?.focus_sections_json, []);
      const applicationQuestions = normalized.applicationQuestions
        ?? safeJson(existingTailoring?.application_questions_json, []);
      db.prepare(`
        INSERT INTO job_tailoring (job_id, focus_sections_json, application_questions_json)
        VALUES (?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          focus_sections_json = excluded.focus_sections_json,
          application_questions_json = excluded.application_questions_json,
          updated_at = CURRENT_TIMESTAMP
      `).run(jobId, JSON.stringify(focusSections), JSON.stringify(applicationQuestions));
    }
  return jobId;
}

export function importJob(db, input, options = {}) {
  // Import is deliberately PATCH-like for optional values. Every value is
  // normalized before the writer transaction so client errors cannot leave a
  // partial job/source/score/tailoring update.
  const normalized = normalizeJobImport(input, options);
  return inImmediateTransaction(db, () => applyNormalizedJob(db, normalized, options));
}

export function importJobsBatch(db, inputs, options = {}) {
  if (!Array.isArray(inputs) || !inputs.length) throw databaseInputError("jobs must be a non-empty array");
  if (inputs.length > 1000) throw databaseInputError("jobs cannot contain more than 1000 items");
  const normalized = inputs.map((input) => normalizeJobImport(input, options));
  const keys = new Set();
  for (const job of normalized) {
    if (keys.has(job.jobKey)) throw databaseInputError(`Duplicate jobKey in batch: ${job.jobKey}`);
    keys.add(job.jobKey);
  }
  return inImmediateTransaction(db, () => {
    const imported = normalized.map((job) => ({ jobKey: job.jobKey, jobId: applyNormalizedJob(db, job, options) }));
    if (typeof options.afterApply === "function") options.afterApply(imported);
    return imported;
  });
}

export function getResume(db) {
  const row = db.prepare("SELECT * FROM resume_profile WHERE id = 1").get();
  const customSections = db.prepare(`
    SELECT id, section_key, label, kind, value_json, display_order, editable, source_refs_json, updated_at
    FROM resume_custom_sections ORDER BY display_order, section_key
  `).all().map((item) => ({
    id: item.id,
    key: item.section_key,
    label: item.label,
    kind: item.kind,
    value: safeJson(item.value_json, item.kind === "list" ? [] : ""),
    displayOrder: item.display_order,
    editable: Boolean(item.editable),
    sourceRefs: safeJson(item.source_refs_json, []),
    updatedAt: item.updated_at,
  }));
  const evidenceItems = db.prepare(`
    SELECT id, title, description, metrics_json, skills_json, source_refs_json, updated_at
    FROM evidence_items ORDER BY created_at, id
  `).all().map((item) => ({
    id: item.id,
    title: item.title,
    description: item.description,
    metrics: safeJson(item.metrics_json, []),
    skills: safeJson(item.skills_json, []),
    sourceRefs: safeJson(item.source_refs_json, []),
    updatedAt: item.updated_at,
  }));
  const assets = listResumeAssets(db);
  const sourceDocuments = assets.filter((item) => item.active);
  const structuredItems = getStructuredResumeItems(db);
  if (!row) {
    const empty = {
    jobFamily: "", jobRole: "", careerType: "new", yearsExperience: "", school: "", major: "",
    headline: "", summary: "", skills: [], certificates: [], experienceHighlights: [],
    achievementEvidence: "", representativeExperience: "", directScope: "",
    collaborationScope: "", careerDirection: "", editableSections: defaultEditableSections,
    careerStage: "", customSections, evidenceItems, sourceDocuments, assets, structuredItems,
    };
    return { ...empty, readiness: resumeReadiness(empty) };
  }
  const resume = {
    jobFamily: row.job_family,
    jobRole: row.job_role,
    careerType: row.career_type === "experienced" ? "experienced" : "new",
    careerStage: row.career_stage || "",
    yearsExperience: row.years_experience === null ? "" : String(row.years_experience),
    school: row.school,
    major: row.major,
    headline: row.headline,
    summary: row.summary,
    skills: safeJson(row.skills_json, []),
    certificates: safeJson(row.certificates_json, []),
    experienceHighlights: safeJson(row.experience_highlights_json, []),
    achievementEvidence: row.achievement_evidence,
    representativeExperience: row.representative_experience,
    directScope: row.direct_scope,
    collaborationScope: row.collaboration_scope,
    careerDirection: row.career_direction,
    editableSections: safeJson(row.editable_sections_json, defaultEditableSections),
    customSections,
    evidenceItems,
    sourceDocuments,
    assets,
    structuredItems,
    updatedAt: row.updated_at,
  };
  return { ...resume, readiness: resumeReadiness(resume) };
}

export function saveResume(db, input) {
  const customSections = Array.isArray(input.customSections)
    ? normalizedCustomSections(input.customSections)
    : null;
  const skills = Array.isArray(input.skills) ? input.skills.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30) : [];
  const highlights = Array.isArray(input.experienceHighlights)
    ? input.experienceHighlights.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30)
    : [];
  const certificates = Array.isArray(input.certificates)
    ? input.certificates.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30)
    : [];
  const editableSections = Array.isArray(input.editableSections)
    ? input.editableSections.map(String).filter((value) => defaultEditableSections.includes(value))
    : defaultEditableSections;
  const requestedCareerType = input.careerType === "experienced" ? "experienced" : "new";
  const careerStage = String(input.careerStage || (requestedCareerType === "new" ? "entry" : "experienced")).trim().slice(0, 40);
  if (!new Set(["entry", "experienced", "career_change", "returning"]).has(careerStage)) {
    throw databaseInputError("careerStage must be entry, experienced, career_change, or returning");
  }
  const careerType = careerStage === "entry" ? "new" : "experienced";
  const suppliedYears = optionalFiniteNumber(input.yearsExperience);
  const yearsExperience = careerType === "experienced" && suppliedYears !== null
    ? Math.max(0, Math.min(80, suppliedYears))
    : null;
  const structuredItems = Object.hasOwn(input, "structuredItems")
    ? normalizeStructuredItems(input.structuredItems, db)
    : null;
  const profileValues = [
    String(input.jobFamily || "").slice(0, 160),
    String(input.jobRole || "").slice(0, 160),
    careerType,
    careerStage,
    yearsExperience,
    String(input.school || "").slice(0, 240),
    String(input.major || "").slice(0, 240),
    String(input.headline || "").slice(0, 300),
    String(input.summary || "").slice(0, 5000),
    JSON.stringify(skills),
    JSON.stringify(certificates),
    JSON.stringify(highlights),
    String(input.achievementEvidence || "").slice(0, 6000),
    String(input.representativeExperience || "").slice(0, 6000),
    String(input.directScope || "").slice(0, 6000),
    String(input.collaborationScope || "").slice(0, 6000),
    String(input.careerDirection || "").slice(0, 6000),
    JSON.stringify(editableSections),
  ];
  inImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO resume_profile (
        id, job_family, job_role, career_type, career_stage, years_experience, school, major,
        headline, summary, skills_json, certificates_json, experience_highlights_json,
        achievement_evidence, representative_experience, direct_scope, collaboration_scope,
        career_direction, editable_sections_json
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        job_family = excluded.job_family,
        job_role = excluded.job_role,
        career_type = excluded.career_type,
        career_stage = excluded.career_stage,
        years_experience = excluded.years_experience,
        school = excluded.school,
        major = excluded.major,
        headline = excluded.headline,
        summary = excluded.summary,
        skills_json = excluded.skills_json,
        certificates_json = excluded.certificates_json,
        experience_highlights_json = excluded.experience_highlights_json,
        achievement_evidence = excluded.achievement_evidence,
        representative_experience = excluded.representative_experience,
        direct_scope = excluded.direct_scope,
        collaboration_scope = excluded.collaboration_scope,
        career_direction = excluded.career_direction,
        editable_sections_json = excluded.editable_sections_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(...profileValues);
    if (customSections) replaceCustomSections(db, customSections);
    if (structuredItems) replaceStructuredResumeItems(db, structuredItems);
  });
  return getResume(db);
}

function normalizedCustomSections(input) {
  if (!Array.isArray(input)) throw databaseInputError("customSections must be an array");
  if (input.length > 30) throw databaseInputError("customSections cannot contain more than 30 items");
  const ids = new Set();
  const keys = new Set();
  return input.map((item, index) => {
    if (!isPlainObject(item)) throw databaseInputError(`customSections[${index}] must be an object`);
    const id = normalizedText(item.id, `customSections[${index}].id`, 80) || `custom-section-${index + 1}`;
    const key = normalizedText(item.key, `customSections[${index}].key`, 100);
    if (!key.startsWith("custom:")) throw databaseInputError(`customSections[${index}].key must start with custom:`);
    const label = normalizedText(item.label, `customSections[${index}].label`, 200) || key.slice(7);
    const duplicateBuiltin = builtinSectionKey(key, label);
    if (duplicateBuiltin) {
      throw databaseInputError(`customSections[${index}] duplicates built-in section: ${duplicateBuiltin}`);
    }
    if (ids.has(id) || keys.has(key)) throw databaseInputError("Custom section ids and keys must be unique");
    ids.add(id);
    keys.add(key);
    const kind = item.kind === "list" ? "list" : "text";
    const value = kind === "list"
      ? (Array.isArray(item.value) ? item.value.map((value) => normalizedText(value, `customSections[${index}].value`, 1000)).filter(Boolean).slice(0, 50) : [])
      : normalizedText(item.value, `customSections[${index}].value`, 8000);
    const displayOrder = Number(item.displayOrder ?? index + 1);
    if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 1000) {
      throw databaseInputError(`customSections[${index}].displayOrder must be an integer between 0 and 1000`);
    }
    return {
      id,
      key,
      label,
      kind,
      value,
      displayOrder,
      editable: item.editable !== false,
      sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs.slice(0, 30) : [],
    };
  });
}

function replaceCustomSections(db, sections) {
  db.prepare("DELETE FROM resume_custom_sections").run();
  const insert = db.prepare(`
    INSERT INTO resume_custom_sections (
      id, section_key, label, kind, value_json, display_order, editable, source_refs_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of sections) {
    insert.run(item.id, item.key, item.label, item.kind, JSON.stringify(item.value), item.displayOrder,
      item.editable ? 1 : 0, JSON.stringify(item.sourceRefs));
  }
}

export function saveOnboardingProfileData(db, input) {
  const documents = Array.isArray(input.documents) ? input.documents : [];
  const facts = Array.isArray(input.facts) ? input.facts : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const customSections = normalizedCustomSections(input.customSections || []);
  inImmediateTransaction(db, () => {
    db.prepare("DELETE FROM profile_facts").run();
    db.prepare("DELETE FROM evidence_items").run();
    db.prepare("DELETE FROM resume_custom_sections").run();
    db.prepare("DELETE FROM resume_assets").run();
    db.prepare("DELETE FROM source_documents").run();
    const addDocument = db.prepare(`
      INSERT INTO source_documents (id, kind, original_name, internal_path, mime_type, size_bytes, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of documents) {
      addDocument.run(
        normalizedText(item.id, "document.id", 80),
        item.kind === "portfolio" ? "portfolio" : "resume",
        normalizedText(item.originalName, "document.originalName", 240),
        normalizedText(item.relativePath, "document.relativePath", 1000),
        normalizedText(item.mimeType, "document.mimeType", 160),
        Math.max(0, Number(item.size || 0)),
        normalizedText(item.sha256, "document.sha256", 128),
      );
      db.prepare("INSERT INTO resume_assets (document_id, label, status) VALUES (?, ?, 'active')")
        .run(normalizedText(item.id, "document.id", 80), normalizedText(item.originalName, "document.originalName", 240));
    }
    const addFact = db.prepare(`
      INSERT INTO profile_facts (
        id, fact_key, label, value, source_document_id, source_locator, confidence, protected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of facts) {
      addFact.run(
        normalizedText(item.id, "fact.id", 80),
        normalizedText(item.key, "fact.key", 100),
        normalizedText(item.label, "fact.label", 200),
        normalizedText(item.value, "fact.value", 4000),
        normalizedText(item.sourceDocumentId, "fact.sourceDocumentId", 80) || null,
        normalizedText(item.sourceLocator, "fact.sourceLocator", 300),
        Math.max(0, Math.min(100, Number(item.confidence || 0))),
        item.protected === true ? 1 : 0,
      );
    }
    const addEvidence = db.prepare(`
      INSERT INTO evidence_items (id, title, description, metrics_json, skills_json, source_refs_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of evidence) {
      addEvidence.run(
        normalizedText(item.id, "evidence.id", 80),
        normalizedText(item.title, "evidence.title", 240),
        normalizedText(item.description, "evidence.description", 6000),
        JSON.stringify(Array.isArray(item.metrics) ? item.metrics.slice(0, 30) : []),
        JSON.stringify(Array.isArray(item.skills) ? item.skills.slice(0, 50) : []),
        JSON.stringify(Array.isArray(item.sourceRefs) ? item.sourceRefs.slice(0, 30) : []),
      );
    }
    const addSection = db.prepare(`
      INSERT INTO resume_custom_sections (
        id, section_key, label, kind, value_json, display_order, editable, source_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of customSections) {
      addSection.run(item.id, item.key, item.label, item.kind, JSON.stringify(item.value), item.displayOrder,
        item.editable ? 1 : 0, JSON.stringify(item.sourceRefs));
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('career_stage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
      .run(normalizedText(input.careerStage, "careerStage", 40));
  });
}
