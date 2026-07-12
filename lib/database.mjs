import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROJECT_ROOT } from "./paths.mjs";
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

function ensurePackageColumns(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(application_packages)").all().map((column) => column.name));
  if (!existing.has("application_answers_path")) {
    db.exec("ALTER TABLE application_packages ADD COLUMN application_answers_path TEXT NOT NULL DEFAULT ''");
  }
}

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  ensureResumeColumns(db);
  ensurePackageColumns(db);
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('instance_id', ?)").run(crypto.randomUUID());
  return db;
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
      id, job_family, job_role, career_type, years_experience, school, major,
      headline, summary, skills_json, certificates_json, experience_highlights_json,
      achievement_evidence, representative_experience, direct_scope, collaboration_scope,
      career_direction, editable_sections_json, filename_pattern
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      job_family = excluded.job_family,
      job_role = excluded.job_role,
      career_type = excluded.career_type,
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
      filename_pattern = excluded.filename_pattern,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    profile.jobFamily || "",
    profile.jobRole || "",
    profile.careerType === "experienced" ? "experienced" : "new",
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
    profile.filenamePattern || "{name}_resume_{company}.pdf",
  );
}

export function initializeDatabase(dbPath, { mode = "demo", resetDemo = false } = {}) {
  const db = openDatabase(dbPath);
  try {
    if (mode === "demo") {
      const alreadySeeded = db.prepare("SELECT value FROM app_meta WHERE key = 'demo_seeded'").get();
      if (resetDemo) {
        db.exec("DELETE FROM package_submissions; DELETE FROM package_approvals; DELETE FROM package_revisions; DELETE FROM application_packages; DELETE FROM job_tailoring; DELETE FROM job_sources; DELETE FROM job_scores; DELETE FROM application_state; DELETE FROM jobs; DELETE FROM resume_profile;");
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

export function listJobs(db, sourcesConfig) {
  const rows = db.prepare(`
    SELECT
      j.*,
      s.total_score,
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
      sources,
      primarySource: selectPrimarySource(allSources, sourcesConfig),
      application: {
        favorite: Boolean(row.favorite),
        workflowStatus: row.workflow_status,
        note: row.note,
      },
      package: publicPackage(getLatestPackageForJob(db, row.id)),
    };
  });
}

export function updateApplicationState(db, jobId, patch) {
  const current = db.prepare(`
    SELECT COALESCE(favorite, 0) AS favorite, COALESCE(workflow_status, 'new') AS workflow_status,
           COALESCE(note, '') AS note
    FROM jobs j LEFT JOIN application_state a ON a.job_id = j.id WHERE j.id = ?
  `).get(jobId);
  if (!current) throw new Error("Job not found");
  const allowedStatuses = new Set(["new", "reviewing", "skipped", "applied", "interview", "offer", "rejected"]);
  const workflowStatus = patch.workflowStatus ?? current.workflow_status;
  if (!allowedStatuses.has(workflowStatus)) throw new Error("Unsupported workflow status");
  const note = String(patch.note ?? current.note).slice(0, 2000);
  const favorite = patch.favorite === undefined ? Boolean(current.favorite) : Boolean(patch.favorite);
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

export function importJob(db, input) {
  const required = ["jobKey", "companyName", "title"];
  for (const key of required) {
    if (!String(input[key] || "").trim()) throw new Error(`Missing required field: ${key}`);
  }
  const job = {
    jobKey: String(input.jobKey).trim().slice(0, 180),
    companyName: String(input.companyName).trim().slice(0, 200),
    title: String(input.title).trim().slice(0, 240),
    track: String(input.track || "").trim().slice(0, 120),
    location: String(input.location || "").trim().slice(0, 160),
    employmentType: String(input.employmentType || "").trim().slice(0, 80),
    status: String(input.status || "unknown").trim().slice(0, 40),
    summary: String(input.summary || "").trim().slice(0, 5000),
  };
  const jobId = upsertJob(db, job);
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
  for (const source of Array.isArray(input.sources) ? input.sources.slice(0, 20) : []) {
    const url = new URL(String(source.url || ""));
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Only HTTP(S) job sources are allowed");
    addSource.run(
      jobId,
      String(source.platform || "unknown").trim().slice(0, 60),
      url.toString(),
      String(source.externalId || "").trim().slice(0, 160),
      String(source.status || "unknown").trim().slice(0, 40),
      Math.max(0, Math.min(100, Number(source.confidence || 0))),
      source.checkedAt || new Date().toISOString(),
    );
  }
  if (input.score !== undefined && input.score !== null) {
    const score = Math.max(0, Math.min(100, Number(input.score)));
    if (!Number.isFinite(score)) throw new Error("Score must be a number between 0 and 100");
    db.prepare(`
      INSERT INTO job_scores (job_id, total_score) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET total_score = excluded.total_score, updated_at = CURRENT_TIMESTAMP
    `).run(jobId, score);
  }
  const existingTailoring = db.prepare("SELECT * FROM job_tailoring WHERE job_id = ?").get(jobId);
  const focusSections = Object.hasOwn(input, "tailoringFocus")
    ? (Array.isArray(input.tailoringFocus)
      ? input.tailoringFocus.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30)
      : [])
    : safeJson(existingTailoring?.focus_sections_json, []);
  const applicationQuestions = Object.hasOwn(input, "applicationQuestions")
    ? (Array.isArray(input.applicationQuestions) ? input.applicationQuestions.slice(0, 20).map((question, index) => ({
        id: String(question?.id || `question-${index + 1}`).trim().slice(0, 80),
        label: String(question?.label || question?.question || "").trim().slice(0, 300),
        required: question?.required !== false,
        maxLength: Math.max(100, Math.min(10000, Number(question?.maxLength || 2000))),
      })).filter((question) => question.label) : [])
    : safeJson(existingTailoring?.application_questions_json, []);
  db.prepare(`
    INSERT INTO job_tailoring (job_id, focus_sections_json, application_questions_json)
    VALUES (?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      focus_sections_json = excluded.focus_sections_json,
      application_questions_json = excluded.application_questions_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(jobId, JSON.stringify(focusSections), JSON.stringify(applicationQuestions));
  return jobId;
}

export function getResume(db) {
  const row = db.prepare("SELECT * FROM resume_profile WHERE id = 1").get();
  if (!row) return {
    jobFamily: "", jobRole: "", careerType: "new", yearsExperience: "", school: "", major: "",
    headline: "", summary: "", skills: [], certificates: [], experienceHighlights: [],
    achievementEvidence: "", representativeExperience: "", directScope: "",
    collaborationScope: "", careerDirection: "", editableSections: defaultEditableSections,
    filenamePattern: "{name}_resume_{company}.pdf",
  };
  return {
    jobFamily: row.job_family,
    jobRole: row.job_role,
    careerType: row.career_type === "experienced" ? "experienced" : "new",
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
    filenamePattern: row.filename_pattern,
    updatedAt: row.updated_at,
  };
}

export function saveResume(db, input) {
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
  const filenamePattern = String(input.filenamePattern || "{name}_resume_{company}.pdf").slice(0, 160);
  const careerType = input.careerType === "experienced" ? "experienced" : "new";
  const suppliedYears = optionalFiniteNumber(input.yearsExperience);
  const yearsExperience = careerType === "experienced" && suppliedYears !== null
    ? Math.max(0, Math.min(80, suppliedYears))
    : null;
  db.prepare(`
    INSERT INTO resume_profile (
      id, job_family, job_role, career_type, years_experience, school, major,
      headline, summary, skills_json, certificates_json, experience_highlights_json,
      achievement_evidence, representative_experience, direct_scope, collaboration_scope,
      career_direction, editable_sections_json, filename_pattern
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      job_family = excluded.job_family,
      job_role = excluded.job_role,
      career_type = excluded.career_type,
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
      filename_pattern = excluded.filename_pattern,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    String(input.jobFamily || "").slice(0, 160),
    String(input.jobRole || "").slice(0, 160),
    careerType,
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
    filenamePattern,
  );
  return getResume(db);
}
