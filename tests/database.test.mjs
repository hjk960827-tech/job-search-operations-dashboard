import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getResume,
  importJob,
  initializeDatabase,
  listJobs,
  openDatabase,
  saveResume,
  updateApplicationState,
} from "../lib/database.mjs";

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-search-operations-"));
  return { directory, file: path.join(directory, "test.sqlite") };
}

function importState(db) {
  const tables = ["jobs", "job_sources", "job_scores", "job_tailoring"];
  return Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function assertClientError(operation, expectedStatus = 400) {
  assert.throws(operation, (error) => {
    assert.equal(error.statusCode, expectedStatus);
    return true;
  });
}

const sources = {
  primary_selection: { prefer_direct_company: true, require_not_closed: true },
  sources: {
    direct: { display: true, priority: 0 },
    wanted: { display: true, priority: 10 },
    linkedin: { display: true, priority: 20 },
    jobkorea: { display: true, priority: 30 },
    hidden: { display: false, priority: 1 },
  },
};

test("demo seed creates canonical jobs and preserves multiple sources", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "demo", resetDemo: true });
    const db = openDatabase(temp.file);
    const jobs = listJobs(db, sources);
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].sources.length, 2);
    const designer = jobs.find((job) => job.track === "Design");
    assert.equal(designer.primarySource.platform, "jobkorea");
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("application state and resume edits remain in the selected database", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    const jobId = importJob(db, {
      jobKey: "test-role",
      companyName: "Sample Company",
      title: "Sample Role",
      sources: [{ platform: "direct", url: "https://example.invalid/job", status: "active", confidence: 100 }],
    });
    updateApplicationState(db, jobId, { favorite: true, workflowStatus: "reviewing", note: "review" });
    assertClientError(() => updateApplicationState(db, jobId, { favorite: "false" }));
    const jobs = listJobs(db, sources);
    assert.equal(jobs[0].application.favorite, true);
    assert.equal(jobs[0].application.workflowStatus, "reviewing");

    saveResume(db, {
      jobFamily: "Engineering",
      jobRole: "Platform Engineer",
      careerType: "experienced",
      yearsExperience: 2.5,
      school: "Sample University",
      major: "Computer Science",
      headline: "Sample headline",
      summary: "Sample summary",
      skills: ["One", "Two"],
      certificates: ["Sample Certificate"],
      experienceHighlights: ["Result"],
      achievementEvidence: "Verified result",
      representativeExperience: "Representative project",
      directScope: "Direct contribution",
      collaborationScope: "Cross-functional work",
      careerDirection: "Document decisions and verify results",
      editableSections: ["summary", "skills", "representative_experience"],
    });
    const resume = getResume(db);
    assert.deepEqual(resume.skills, ["One", "Two"]);
    assert.equal(resume.jobRole, "Platform Engineer");
    assert.equal(resume.yearsExperience, "2.5");
    assert.deepEqual(resume.certificates, ["Sample Certificate"]);
    assert.deepEqual(resume.editableSections, ["summary", "skills", "representative_experience"]);
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("sources disabled for display are excluded from dashboard payload", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    importJob(db, {
      jobKey: "source-visibility",
      companyName: "Sample Company",
      title: "Sample Role",
      sources: [
        { platform: "wanted", url: "https://example.invalid/visible", status: "active" },
        { platform: "hidden", url: "https://example.invalid/hidden", status: "active" },
      ],
    });
    const jobs = listJobs(db, sources);
    assert.deepEqual(jobs[0].sources.map((source) => source.platform), ["wanted"]);
    assert.equal(jobs[0].primarySource.platform, "wanted");
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("reimport without tailoring fields preserves existing focus and questions", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    const jobId = importJob(db, {
      jobKey: "preserve-tailoring",
      companyName: "Sample Company",
      title: "Sample Role",
      tailoringFocus: ["summary", "skills"],
      applicationQuestions: [{ id: "fit", label: "직무 적합성을 설명해 주세요.", required: true }],
      sources: [{ platform: "direct", url: "https://example.invalid/preserve", status: "active" }],
    });
    importJob(db, {
      jobKey: "preserve-tailoring",
      companyName: "Sample Company Updated",
      title: "Sample Role Updated",
      sources: [{ platform: "direct", url: "https://example.invalid/preserve", status: "active" }],
    });
    const tailoring = db.prepare("SELECT * FROM job_tailoring WHERE job_id = ?").get(jobId);
    assert.deepEqual(JSON.parse(tailoring.focus_sections_json), ["summary", "skills"]);
    assert.deepEqual(JSON.parse(tailoring.application_questions_json), [
      { id: "fit", label: "직무 적합성을 설명해 주세요.", required: true, maxLength: 2000 },
    ]);
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("job import validates every field before writing a new job", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    const invalidImports = [
      {
        jobKey: "invalid-url",
        companyName: "Sample Company",
        title: "Sample Role",
        sources: [{ platform: "direct", url: "file:///tmp/job" }],
      },
      {
        jobKey: "invalid-score",
        companyName: "Sample Company",
        title: "Sample Role",
        score: 101,
      },
      {
        jobKey: "credential-url",
        companyName: "Sample Company",
        title: "Sample Role",
        sources: [{ platform: "direct", url: ["https://user:password", "example.invalid/job"].join("@") }],
      },
      {
        jobKey: "invalid-source",
        companyName: "Sample Company",
        title: "Sample Role",
        sources: ["https://example.invalid/job"],
      },
      {
        jobKey: "invalid-question",
        companyName: "Sample Company",
        title: "Sample Role",
        applicationQuestions: [{ id: "missing-label", maxLength: 2000 }],
      },
      {
        jobKey: "invalid-lifecycle",
        companyName: "Sample Company",
        title: "Sample Role",
        status: "draft",
      },
    ];
    const before = importState(db);
    for (const value of invalidImports) {
      assertClientError(() => importJob(db, value));
      assert.deepEqual(importState(db), before);
    }
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("job and source lifecycle aliases are normalized to a closed enum", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    const jobId = importJob(db, {
      jobKey: "normalized-lifecycle",
      companyName: "Sample Company",
      title: "Sample Role",
      status: "OPEN",
      sources: [{ platform: "direct", url: "https://example.invalid/normalized", status: "EXPIRED" }],
    });
    assert.equal(db.prepare("SELECT lifecycle_status FROM jobs WHERE id = ?").get(jobId).lifecycle_status, "active");
    assert.equal(db.prepare("SELECT lifecycle_status FROM job_sources WHERE job_id = ?").get(jobId).lifecycle_status, "closed");
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("invalid reimport leaves the existing job and all related records unchanged", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    importJob(db, {
      jobKey: "atomic-existing",
      companyName: "Original Company",
      title: "Original Role",
      track: "Original Track",
      location: "Original Location",
      score: 84,
      tailoringFocus: ["summary"],
      applicationQuestions: [{ id: "fit", label: "Explain the fit.", maxLength: 1200 }],
      sources: [{
        platform: "direct",
        url: "https://example.invalid/original",
        status: "active",
        confidence: 95,
        checkedAt: "2026-07-13T00:00:00.000Z",
      }],
    });
    const before = importState(db);

    assertClientError(() => importJob(db, {
      jobKey: "atomic-existing",
      companyName: "Mutated Company",
      title: "Mutated Role",
      score: 22,
      sources: [
        { platform: "wanted", url: "https://example.invalid/new", confidence: 80 },
        { platform: "broken", url: "not-a-url", confidence: 80 },
      ],
    }));
    assert.deepEqual(importState(db), before);

    assertClientError(() => importJob(db, {
      jobKey: "atomic-existing",
      companyName: "Mutated Company",
      title: "Mutated Role",
      score: 22,
      sources: [{ platform: "wanted", url: "https://example.invalid/new", confidence: 80 }],
      applicationQuestions: [{ id: "broken", label: "Broken", maxLength: "many" }],
    }));
    assert.deepEqual(importState(db), before);
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("omitted import values are preserved while explicit null or empty values clear them", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    const jobId = importJob(db, {
      jobKey: "patch-semantics",
      companyName: "Original Company",
      title: "Original Role",
      track: "Engineering",
      location: "Seoul",
      employmentType: "full-time",
      status: "active",
      summary: "Original summary",
      score: 91,
      sources: [{ platform: "direct", url: "https://example.invalid/patch", confidence: 100 }],
      tailoringFocus: ["summary", "skills"],
      applicationQuestions: [{ id: "fit", label: "Explain the fit." }],
    });

    importJob(db, {
      jobKey: "patch-semantics",
      companyName: "Updated Company",
      title: "Updated Role",
    });
    const preservedJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    assert.equal(preservedJob.company_name, "Updated Company");
    assert.equal(preservedJob.title, "Updated Role");
    assert.equal(preservedJob.track, "Engineering");
    assert.equal(preservedJob.location, "Seoul");
    assert.equal(preservedJob.employment_type, "full-time");
    assert.equal(preservedJob.lifecycle_status, "active");
    assert.equal(preservedJob.summary, "Original summary");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM job_sources WHERE job_id = ?").get(jobId).count, 1);
    assert.equal(db.prepare("SELECT total_score FROM job_scores WHERE job_id = ?").get(jobId).total_score, 91);
    db.prepare("UPDATE job_scores SET breakdown_json = ? WHERE job_id = ?").run('{"evidence":12}', jobId);
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT focus_sections_json FROM job_tailoring WHERE job_id = ?").get(jobId).focus_sections_json),
      ["summary", "skills"],
    );

    importJob(db, {
      jobKey: "patch-semantics",
      companyName: "Updated Company",
      title: "Updated Role",
      track: null,
      location: "   ",
      employmentType: null,
      status: "",
      summary: null,
      sources: [],
      score: " ",
      tailoringFocus: null,
      applicationQuestions: [],
    });
    const clearedJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    assert.equal(clearedJob.track, "");
    assert.equal(clearedJob.location, "");
    assert.equal(clearedJob.employment_type, "");
    assert.equal(clearedJob.lifecycle_status, "unknown");
    assert.equal(clearedJob.summary, "");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM job_sources WHERE job_id = ?").get(jobId).count, 0);
    const clearedScore = db.prepare("SELECT total_score, breakdown_json FROM job_scores WHERE job_id = ?").get(jobId);
    assert.equal(clearedScore.total_score, null);
    assert.equal(clearedScore.breakdown_json, '{"evidence":12}');
    const tailoring = db.prepare("SELECT * FROM job_tailoring WHERE job_id = ?").get(jobId);
    assert.deepEqual(JSON.parse(tailoring.focus_sections_json), []);
    assert.deepEqual(JSON.parse(tailoring.application_questions_json), []);
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("database state errors expose client-safe status codes", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    assertClientError(() => updateApplicationState(db, 999999, {}), 404);
    const jobId = importJob(db, {
      jobKey: "state-errors",
      companyName: "Sample Company",
      title: "Sample Role",
    });
    assertClientError(() => updateApplicationState(db, jobId, { workflowStatus: "unsupported" }));
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});

test("blank experience years remain unset instead of becoming zero", () => {
  const temp = temporaryDatabase();
  try {
    initializeDatabase(temp.file, { mode: "personal" });
    const db = openDatabase(temp.file);
    saveResume(db, {
      careerType: "experienced",
      yearsExperience: "   ",
      editableSections: [],
    });
    assert.equal(getResume(db).yearsExperience, "");
    assert.equal(db.prepare("SELECT years_experience FROM resume_profile WHERE id = 1").get().years_experience, null);
    db.close();
  } finally {
    fs.rmSync(temp.directory, { recursive: true, force: true });
  }
});
