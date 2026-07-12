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
      headline: "Sample headline",
      summary: "Sample summary",
      skills: ["One", "Two"],
      experienceHighlights: ["Result"],
      filenamePattern: "{name}_{company}.pdf",
    });
    assert.deepEqual(getResume(db).skills, ["One", "Two"]);
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
