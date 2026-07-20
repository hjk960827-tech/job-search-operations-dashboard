import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyCompanionResultReview,
  getCompanionResultReview,
  patchCompanionResultReview,
  prepareCompanionResultReview,
  rejectCompanionResultReview,
} from "../lib/companion-results.mjs";
import {
  claimNextCompanionTask,
  completeCompanionTask,
  createCompanionTask,
} from "../lib/companion-queue.mjs";
import { importJob, initializeDatabase, openDatabase, saveResume } from "../lib/database.mjs";
import { PACKAGE_DIR, PRIVATE_DATA_DIR, companionTaskPath } from "../lib/paths.mjs";

const context = {
  profileConfig: { location: { regions: ["Anywhere"], timezone: "Asia/Seoul" }, preferences: {} },
  searchConfig: {
    target_roles: ["Example Role"], include_keywords: [], exclude_keywords: [], target_tracks: [],
    experience: {}, company_preferences: {}, industry_preferences: {}, work_preferences: {},
  },
  sourcesConfig: { sources: { direct: { label: "Company careers", collect: true, display: true, lifecycle_check: true, priority: 0 } } },
};

function fixture(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const file = path.join(directory, "personal.sqlite");
  initializeDatabase(file, { mode: "personal" });
  return { directory, file, db: openDatabase(file), runRoot: path.join(directory, "collection-runs") };
}

function cleanup(value) {
  const taskIds = value.db.prepare("SELECT id FROM agent_tasks").all().map((row) => row.id);
  const packageDirectories = value.db.prepare("SELECT artifact_directory FROM application_packages").all().map((row) => row.artifact_directory);
  value.db.close();
  for (const id of taskIds) fs.rmSync(companionTaskPath(id), { recursive: true, force: true });
  for (const directory of packageDirectories) fs.rmSync(directory, { recursive: true, force: true });
  for (const directory of packageDirectories) {
    let current = path.dirname(directory);
    while (current.startsWith(PACKAGE_DIR) && current !== PACKAGE_DIR) {
      try { fs.rmdirSync(current); } catch { break; }
      current = path.dirname(current);
    }
  }
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function complete(db, kind, result, request = {}) {
  const task = createCompanionTask(db, { kind, ...request }, context).task;
  const claimed = claimNextCompanionTask(db, { workerId: `worker-${kind.replaceAll("_", "-")}` });
  const completed = completeCompanionTask(db, task.id, {
    workerId: `worker-${kind.replaceAll("_", "-")}`,
    requestChecksum: claimed.task.requestChecksum,
    result,
  });
  return completed;
}

test("collection results remain staged until approval and review acceptance is atomic with import", () => {
  const value = fixture("companion-review-collection");
  try {
    const task = complete(value.db, "collect_jobs", { jobs: [{
      jobKey: "reviewed-role", companyName: "Example Organization", title: "Example Role",
      sources: [{ platform: "direct", url: "https://example.invalid/jobs/reviewed-role", status: "active" }],
    }] });
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
    const prepared = prepareCompanionResultReview(value.db, task.id, {
      context, sourcesConfig: context.sourcesConfig, timeZone: "Asia/Seoul", runRoot: value.runRoot,
    });
    assert.equal(prepared.review.preview.counts.create, 1);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);

    value.db.exec(`CREATE TRIGGER block_synthetic_review_accept BEFORE UPDATE OF status ON agent_task_reviews
      WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(ABORT, 'synthetic review conflict'); END`);
    assert.throws(() => applyCompanionResultReview(value.db, task.id, {
      context, sourcesConfig: context.sourcesConfig, timeZone: "Asia/Seoul", runRoot: value.runRoot,
    }), /synthetic review conflict/);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 0);
    assert.equal(getCompanionResultReview(value.db, task.id).review.status, "awaiting_review");
    value.db.exec("DROP TRIGGER block_synthetic_review_accept");

    const applied = applyCompanionResultReview(value.db, task.id, {
      context, sourcesConfig: context.sourcesConfig, timeZone: "Asia/Seoul", runRoot: value.runRoot,
    });
    assert.equal(applied.review.status, "accepted");
    assert.equal(applied.applied.imported[0].jobKey, "reviewed-role");
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 1);
    assert.throws(() => applyCompanionResultReview(value.db, task.id, { context }), /review-pending/);
  } finally { cleanup(value); }
});

test("document analysis applies only reviewed facts, evidence, and canonical resume sections", () => {
  const value = fixture("companion-review-analysis");
  const documentDirectory = fs.mkdtempSync(path.join(PRIVATE_DATA_DIR, "review-analysis-"));
  try {
    const documentPath = path.join(documentDirectory, "source.pdf");
    const bytes = Buffer.from("%PDF-1.4 synthetic resume evidence");
    fs.writeFileSync(documentPath, bytes, { mode: 0o600 });
    value.db.prepare(`INSERT INTO source_documents
      (id, kind, original_name, internal_path, mime_type, size_bytes, sha256, active)
      VALUES ('resume-doc', 'resume', 'synthetic.pdf', ?, 'application/pdf', ?, ?, 1)`)
      .run(documentPath, bytes.length, crypto.createHash("sha256").update(bytes).digest("hex"));
    const refs = [{ documentId: "resume-doc", locator: "page 1" }];
    const task = complete(value.db, "analyze_documents", {
      facts: [{ id: "fact-one", key: "careerStage", label: "Career stage", value: "Experienced", confidence: 95, sourceRefs: refs }],
      evidence: [{ id: "evidence-one", title: "Evidence", description: "Original evidence", metrics: [], skills: [], sourceRefs: refs }],
      sections: [
        { id: "section-summary", key: "summary", label: "Summary", kind: "text", value: "Original summary", sourceRefs: refs },
        { id: "section-research", key: "research", label: "Research", kind: "list", value: ["Synthetic study"], sourceRefs: refs },
      ],
    }, { documentIds: ["resume-doc"] });
    prepareCompanionResultReview(value.db, task.id, { context });
    patchCompanionResultReview(value.db, task.id, { decisions: {
      facts: { "fact-one": { decision: "use" } },
      evidence: { "evidence-one": { decision: "exclude" } },
      sections: {
        "section-summary": { decision: "edit", value: "Reviewed generic professional summary." },
        "section-research": { decision: "use" },
      },
    } });
    const applied = applyCompanionResultReview(value.db, task.id, { context });
    assert.deepEqual(applied.applied, { facts: 1, evidence: 0, sections: 2 });
    assert.equal(applied.review.status, "accepted");
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM profile_facts").get().count, 1);
    assert.equal(value.db.prepare("SELECT protected FROM profile_facts").get().protected, 1);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM evidence_items").get().count, 0);
    assert.equal(value.db.prepare("SELECT summary FROM resume_profile WHERE id = 1").get().summary, "Reviewed generic professional summary.");
    assert.equal(value.db.prepare("SELECT section_key FROM resume_custom_sections").get().section_key, "custom:research");
  } finally {
    fs.rmSync(documentDirectory, { recursive: true, force: true });
    cleanup(value);
  }
});

test("generated package content is reviewed, source-linked, and rolled back if review acceptance fails", () => {
  const value = fixture("companion-review-package");
  try {
    saveResume(value.db, {
      jobFamily: "General", jobRole: "Example Role", careerType: "experienced", yearsExperience: 2,
      summary: "Approved synthetic professional experience that can be safely reordered for an example role.",
      editableSections: ["summary"],
    });
    const jobId = importJob(value.db, {
      jobKey: "package-review", companyName: "Example Organization", title: "Example Role",
      sources: [{ platform: "direct", url: "https://example.invalid/jobs/package-review", status: "active" }],
    });
    const task = complete(value.db, "generate_package", { sections: [{
      key: "summary", value: "Reviewed synthetic professional experience reordered for the example role without adding facts.",
      sourceRefs: ["section:summary"],
    }] }, { jobId });
    prepareCompanionResultReview(value.db, task.id, { context });
    patchCompanionResultReview(value.db, task.id, { decisions: { sections: { summary: { decision: "use" } } } });
    value.db.exec(`CREATE TRIGGER block_synthetic_package_review BEFORE UPDATE OF status ON agent_task_reviews
      WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(ABORT, 'synthetic package review conflict'); END`);
    assert.throws(() => applyCompanionResultReview(value.db, task.id, {
      context, packageOptions: { threshold: 80, maximumPages: 3 },
    }), /synthetic package review conflict/);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM application_packages").get().count, 0);
    value.db.exec("DROP TRIGGER block_synthetic_package_review");
    const applied = applyCompanionResultReview(value.db, task.id, {
      context, packageOptions: { threshold: 80, maximumPages: 3 },
    });
    assert.equal(applied.review.status, "accepted");
    assert.equal(applied.applied.content.sections[0].sourceRefs[0], "section:summary");
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM application_packages").get().count, 1);
  } finally { cleanup(value); }
});

test("stale results cannot be previewed and rejected results never mutate operational data", () => {
  const value = fixture("companion-review-stale");
  try {
    saveResume(value.db, {
      jobFamily: "General", jobRole: "Example Role", careerType: "experienced", yearsExperience: 2,
      summary: "Initial synthetic profile content long enough for generation.", editableSections: ["summary"],
    });
    const jobId = importJob(value.db, {
      jobKey: "stale-review", companyName: "Example Organization", title: "Example Role",
      sources: [{ platform: "direct", url: "https://example.invalid/jobs/stale-review", status: "active" }],
    });
    const task = complete(value.db, "generate_package", { sections: [{
      key: "summary", value: "Initial synthetic profile content long enough for generation.", sourceRefs: ["section:summary"],
    }] }, { jobId });
    saveResume(value.db, { summary: "Changed after the result was produced and before review." });
    assert.throws(() => prepareCompanionResultReview(value.db, task.id, { context }), /inputs changed/);
    const rejected = rejectCompanionResultReview(value.db, task.id, { note: "Superseded by changed local inputs" });
    assert.equal(rejected.review.status, "rejected");
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM application_packages").get().count, 0);
  } finally { cleanup(value); }
});
