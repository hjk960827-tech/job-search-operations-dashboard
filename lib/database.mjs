import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertDatabaseRoleBeforeOpen, recordDatabaseRole } from "./database-role.mjs";
import { DATA_DIR, PROJECT_ROOT } from "./paths.mjs";
import { builtinSectionKey } from "./document-sections.mjs";
import { selectPrimarySource } from "./source-selection.mjs";
import { getLatestPackageForJob, publicPackage } from "./package-workflow.mjs";

const schemaPath = path.join(PROJECT_ROOT, "db", "schema.sql");
const demoJobsPath = path.join(PROJECT_ROOT, "examples", "demo", "jobs.json");
const demoApplicationsPath = path.join(PROJECT_ROOT, "examples", "demo", "applications.json");
const demoProfilePath = path.join(PROJECT_ROOT, "examples", "demo", "profile.json");
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

function ensureResumeColumns(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(resume_profile)").all().map((column) => column.name));
  const editableSectionsAdded = !existing.has("editable_sections_json");
  const additions = {
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
    editable_sections_json: `TEXT NOT NULL DEFAULT '${JSON.stringify(defaultEditableSections)}'`,
  };
  for (const [name, definition] of Object.entries(additions)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE resume_profile ADD COLUMN ${name} ${definition}`);
  }
  if (editableSectionsAdded) {
    db.prepare("UPDATE resume_profile SET editable_sections_json = ?").run(JSON.stringify(defaultEditableSections));
  }
}

function ensureJobScoreColumns(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(job_scores)").all().map((column) => column.name));
  if (!existing.has("score_mode")) db.exec("ALTER TABLE job_scores ADD COLUMN score_mode TEXT NOT NULL DEFAULT 'scalar'");
  if (!existing.has("profile_checksum")) db.exec("ALTER TABLE job_scores ADD COLUMN profile_checksum TEXT NOT NULL DEFAULT ''");
}

function ensurePackageColumns(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(application_packages)").all().map((column) => column.name));
  if (!existing.has("application_answers_path")) {
    db.exec("ALTER TABLE application_packages ADD COLUMN application_answers_path TEXT NOT NULL DEFAULT ''");
  }
}

function ensurePackageStateIntegrity(db) {
  db.exec(`
    UPDATE application_packages
    SET state = CASE
      WHEN EXISTS (
        SELECT 1 FROM package_submissions s
        WHERE s.package_id = application_packages.id AND s.status = 'submitted'
      ) THEN 'submitted'
      WHEN EXISTS (
        SELECT 1 FROM package_submissions s
        WHERE s.package_id = application_packages.id AND s.status = 'submit_ready'
      ) THEN 'submit_ready'
      WHEN approved_checksum <> '' AND resume_pdf_path <> '' THEN 'approved'
      WHEN quality_status = 'passed' THEN 'approval_pending'
      ELSE 'quality_hold'
    END
    WHERE state NOT IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted');

    CREATE TRIGGER IF NOT EXISTS application_packages_state_insert_guard
    BEFORE INSERT ON application_packages
    WHEN NEW.state NOT IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted')
    BEGIN
      SELECT RAISE(ABORT, 'invalid application package state');
    END;

    CREATE TRIGGER IF NOT EXISTS application_packages_state_update_guard
    BEFORE UPDATE OF state ON application_packages
    WHEN NEW.state NOT IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted')
    BEGIN
      SELECT RAISE(ABORT, 'invalid application package state');
    END;
  `);
}

export function openDatabase(dbPath) {
  const directory = path.dirname(dbPath);
  const directoryExisted = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const relativeToData = path.relative(path.resolve(DATA_DIR), path.resolve(directory));
  const insideReleaseData = relativeToData === "" || (!relativeToData.startsWith(`..${path.sep}`) && relativeToData !== ".." && !path.isAbsolute(relativeToData));
  if (!directoryExisted || insideReleaseData) fs.chmodSync(directory, 0o700);
  const db = new DatabaseSync(dbPath);
  try {
    fs.chmodSync(dbPath, 0o600);
    db.exec(fs.readFileSync(schemaPath, "utf8"));
    ensureResumeColumns(db);
    ensureJobScoreColumns(db);
    ensurePackageColumns(db);
    ensurePackageStateIntegrity(db);
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('instance_id', ?)").run(crypto.randomUUID());
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
      job_key, company_name, title, track, location, employment_type, lifecycle_status, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_key) DO UPDATE SET
      company_name = excluded.company_name,
      title = excluded.title,
      track = excluded.track,
      location = excluded.location,
      employment_type = excluded.employment_type,
      lifecycle_status = excluded.lifecycle_status,
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
    job.summary || "",
  );
  return db.prepare("SELECT id FROM jobs WHERE job_key = ?").get(job.jobKey).id;
}

function seedJobs(db, jobs) {
  const addSource = db.prepare(`
    INSERT INTO job_sources (
      job_id, platform, source_url, external_id, lifecycle_status, confidence, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, platform, source_url) DO UPDATE SET
      external_id = excluded.external_id,
      lifecycle_status = excluded.lifecycle_status,
      confidence = excluded.confidence,
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
        Number(source.confidence || 0),
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

export function initializeDatabase(dbPath, { mode = "demo", resetDemo = false } = {}) {
  assertDatabaseRoleBeforeOpen(dbPath, mode);
  const db = openDatabase(dbPath);
  try {
    recordDatabaseRole(db, mode);
    if (mode === "demo") {
      const alreadySeeded = db.prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded'").get();
      if (resetDemo) {
        db.exec("DELETE FROM package_submissions; DELETE FROM package_approvals; DELETE FROM package_revisions; DELETE FROM application_packages; DELETE FROM job_tailoring; DELETE FROM job_sources; DELETE FROM job_scores; DELETE FROM application_state; DELETE FROM jobs; DELETE FROM profile_facts; DELETE FROM evidence_items; DELETE FROM resume_custom_sections; DELETE FROM source_documents; DELETE FROM resume_profile;");
      }
      if (!alreadySeeded || resetDemo) {
        seedJobs(db, JSON.parse(fs.readFileSync(demoJobsPath, "utf8")));
        seedApplications(db, JSON.parse(fs.readFileSync(demoApplicationsPath, "utf8")));
        seedResume(db, JSON.parse(fs.readFileSync(demoProfilePath, "utf8")));
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
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw databaseInputError(`sources[${index}].url must be a valid URL`);
    }
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw databaseInputError("Only HTTP(S) job sources are allowed");
    }
    if (url.username || url.password) {
      throw databaseInputError("Job source URLs must not contain usernames or passwords");
    }

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

    return {
      platform,
      url: url.toString(),
      externalId: normalizedText(source.externalId, `sources[${index}].externalId`, 160),
      status: normalizedLifecycleStatus(source.status, `sources[${index}].status`),
      confidence,
      checkedAt,
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
  const sourceStatement = db.prepare(`
    SELECT
      platform,
      source_url AS url,
      external_id AS externalId,
      lifecycle_status AS status,
      confidence,
      checked_at AS checkedAt
    FROM job_sources
    WHERE job_id = ?
  `);
  return rows.map((row) => {
    const allSources = sourceStatement.all(row.id);
    const sources = allSources.filter((source) => sourcesConfig?.sources?.[source.platform]?.display !== false);
    return {
      id: row.id,
      jobKey: row.job_key,
      companyName: row.company_name,
      title: row.title,
      track: row.track,
      location: row.location,
      employmentType: row.employment_type,
      status: row.lifecycle_status,
      summary: row.summary,
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
  });
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

export function importJob(db, input, options = {}) {
  // Import is deliberately PATCH-like for optional values:
  // - omitted core fields, sources, score, or tailoring keep their stored values;
  // - null/blank optional text resets to its empty/default value;
  // - null/empty collections clear that collection, while non-empty sources merge by their unique key;
  // - null/blank score clears the scalar score without discarding breakdown_json.
  // All input is normalized before BEGIN so a client error cannot partially mutate a new or existing job.
  const normalized = normalizeJobImport(input, options);

  return inImmediateTransaction(db, () => {
    if (normalized.scoreBreakdown) {
      const knownEvidence = new Set(db.prepare("SELECT id FROM evidence_items").all().map((item) => item.id));
      const unknownEvidence = normalized.scoreBreakdown.dimensions
        .flatMap((item) => item.evidenceRefs)
        .filter((id) => !knownEvidence.has(id));
      if (unknownEvidence.length) throw databaseInputError(`Unknown evidence reference: ${[...new Set(unknownEvidence)].join(", ")}`);
    }
    const existingJob = db.prepare("SELECT * FROM jobs WHERE job_key = ?").get(normalized.jobKey);
    const job = {
      jobKey: normalized.jobKey,
      companyName: normalized.companyName,
      title: normalized.title,
      track: normalized.track ?? existingJob?.track ?? "",
      location: normalized.location ?? existingJob?.location ?? "",
      employmentType: normalized.employmentType ?? existingJob?.employment_type ?? "",
      status: normalized.status ?? existingJob?.lifecycle_status ?? "unknown",
      summary: normalized.summary ?? existingJob?.summary ?? "",
    };
    const jobId = upsertJob(db, job);

    if (normalized.sources !== undefined) {
      if (normalized.sources.length === 0) {
        db.prepare("DELETE FROM job_sources WHERE job_id = ?").run(jobId);
      } else {
        const addSource = db.prepare(`
          INSERT INTO job_sources (
            job_id, platform, source_url, external_id, lifecycle_status, confidence, checked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id, platform, source_url) DO UPDATE SET
            external_id = excluded.external_id,
            lifecycle_status = excluded.lifecycle_status,
            confidence = excluded.confidence,
            checked_at = excluded.checked_at
        `);
        for (const source of normalized.sources) {
          addSource.run(
            jobId,
            source.platform,
            source.url,
            source.externalId,
            source.status,
            source.confidence,
            source.checkedAt,
          );
        }
      }
    }

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
  const sourceDocuments = db.prepare(`
    SELECT id, kind, original_name, mime_type, size_bytes, sha256, active, created_at
    FROM source_documents WHERE active = 1 ORDER BY kind, created_at
  `).all().map((item) => ({
    id: item.id,
    kind: item.kind,
    originalName: item.original_name,
    mimeType: item.mime_type,
    size: item.size_bytes,
    sha256: item.sha256,
    createdAt: item.created_at,
  }));
  if (!row) return {
    jobFamily: "", jobRole: "", careerType: "new", yearsExperience: "", school: "", major: "",
    headline: "", summary: "", skills: [], certificates: [], experienceHighlights: [],
    achievementEvidence: "", representativeExperience: "", directScope: "",
    collaborationScope: "", careerDirection: "", editableSections: defaultEditableSections,
    careerStage: "", customSections, evidenceItems, sourceDocuments,
  };
  return {
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
    updatedAt: row.updated_at,
  };
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
  );
  if (customSections) saveCustomSections(db, customSections);
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

function saveCustomSections(db, sections) {
  inImmediateTransaction(db, () => {
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
  });
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
