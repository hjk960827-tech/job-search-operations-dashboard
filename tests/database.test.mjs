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
      filenamePattern: "{name}_{company}.pdf",
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
