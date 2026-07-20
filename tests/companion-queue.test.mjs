import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cancelCompanionTask,
  claimNextCompanionTask,
  completeCompanionTask,
  createCompanionTask,
  failCompanionTask,
  heartbeatCompanionTask,
  listCompanionTasks,
  recoverStaleCompanionTasks,
  retryCompanionTask,
} from "../lib/companion-queue.mjs";
import { importJob, initializeDatabase, openDatabase, saveResume } from "../lib/database.mjs";
import { PRIVATE_DATA_DIR, companionTaskPath } from "../lib/paths.mjs";

const context = {
  profileConfig: {
    location: { regions: ["Remote"] },
    preferences: {
      employment_types: ["Full-time"],
      work_modes: ["Hybrid"],
      salary: { currency: "USD", minimum: 50000, target: 70000 },
    },
  },
  searchConfig: {
    target_roles: ["Example Role"],
    include_keywords: ["systems"],
    exclude_keywords: ["unrelated"],
    target_tracks: ["primary"],
    experience: { minimum_years: 1, maximum_years: 5 },
    company_preferences: { include: ["Example Organization"], exclude: ["Excluded Organization"] },
    industry_preferences: { include: ["Technology"], exclude: ["Restricted Industry"] },
    work_preferences: { desired: ["analysis"], avoided: ["cold outreach"] },
  },
  sourcesConfig: {
    sources: {
      direct: { label: "Company careers", collect: true, lifecycle_check: true, priority: 0 },
      optional: { label: "Optional source", collect: false, lifecycle_check: false, priority: 10 },
    },
  },
};

function fixture(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const file = path.join(directory, "personal.sqlite");
  initializeDatabase(file, { mode: "personal" });
  return { directory, file, db: openDatabase(file) };
}

function cleanup(value) {
  const ids = value.db.prepare("SELECT id FROM agent_tasks").all().map((row) => row.id);
  value.db.close();
  for (const id of ids) fs.rmSync(companionTaskPath(id), { recursive: true, force: true });
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function addJob(db, key) {
  return importJob(db, {
    jobKey: key,
    companyName: "Example Organization",
    title: "Example Role",
    status: "active",
    sources: [{ platform: "direct", url: `https://example.invalid/jobs/${key}`, status: "active" }],
  });
}

function addResume(db) {
  saveResume(db, {
    jobFamily: "General",
    jobRole: "Example Role",
    careerType: "experienced",
    yearsExperience: 2,
    summary: "Approved synthetic experience that can be adapted without inventing a new fact.",
    editableSections: ["summary"],
  });
}

test("equivalent active requests coalesce into one owner-only provider-neutral request file", () => {
  const value = fixture("companion-dedupe");
  try {
    const first = createCompanionTask(value.db, { kind: "collect_jobs" }, context);
    const second = createCompanionTask(value.db, { kind: "collect_jobs" }, context);
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.task.id, first.task.id);
    assert.equal(listCompanionTasks(value.db).length, 1);
    const requestPath = companionTaskPath(first.task.id, "request.json");
    assert.equal(fs.statSync(path.dirname(requestPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(requestPath).mode & 0o777, 0o600);
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    assert.equal(request.kind, "collect_jobs");
    assert.deepEqual(request.input.sources.map((item) => item.key), ["direct"]);
    assert.deepEqual(request.input.search, {
      targetRoles: ["Example Role"],
      includeKeywords: ["systems"],
      excludeKeywords: ["unrelated"],
      targetTracks: ["primary"],
      regions: ["Remote"],
      employmentTypes: ["Full-time"],
      workModes: ["Hybrid"],
      experience: { minimumYears: 1, maximumYears: 5 },
      salary: { currency: "USD", minimum: 50000, target: 70000 },
      companyPreferences: { include: ["Example Organization"], exclude: ["Excluded Organization"] },
      industryPreferences: { include: ["Technology"], exclude: ["Restricted Industry"] },
      workPreferences: { desired: ["analysis"], avoided: ["cold outreach"] },
    });
    assert.equal(JSON.stringify(request).includes("Codex"), false);
    assert.equal(JSON.stringify(request).includes("Claude"), false);
    assert.throws(
      () => createCompanionTask(value.db, {
        kind: "collect_jobs",
        [["access", "Token"].join("")]: ["must", "not", "be", "stored"].join("-"),
      }, context),
      /cannot contain credentials/,
    );
  } finally {
    cleanup(value);
  }
});

test("only one package-generation task can run while independent queued work remains", () => {
  const value = fixture("companion-single-generation");
  try {
    addResume(value.db);
    const taskIds = [addJob(value.db, "generation-one"), addJob(value.db, "generation-two")]
      .map((jobId) => createCompanionTask(value.db, { kind: "generate_package", jobId }, context).task.id);
    const first = claimNextCompanionTask(value.db, { workerId: "local-worker-a" });
    assert.ok(taskIds.includes(first.task.id));
    assert.equal(claimNextCompanionTask(value.db, { workerId: "local-worker-b" }), null);
    cancelCompanionTask(value.db, first.task.id);
    const second = claimNextCompanionTask(value.db, { workerId: "local-worker-b" });
    assert.ok(taskIds.includes(second.task.id));
    assert.notEqual(second.task.id, first.task.id);
  } finally {
    cleanup(value);
  }
});

test("failed tasks retry explicitly, running tasks cancel cooperatively, and cancelled work cannot complete", () => {
  const value = fixture("companion-retry-cancel");
  try {
    const created = createCompanionTask(value.db, { kind: "collect_jobs" }, context).task;
    const first = claimNextCompanionTask(value.db, { workerId: "local-worker" });
    assert.equal(first.task.id, created.id);
    const heartbeat = heartbeatCompanionTask(value.db, created.id, { workerId: "local-worker", leaseSeconds: 600 });
    assert.equal(heartbeat.status, "running");
    assert.ok(Date.parse(heartbeat.leaseExpiresAt) > Date.now());
    const failed = failCompanionTask(value.db, created.id, { workerId: "local-worker", code: "adapter_failed", message: "Synthetic adapter failure" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.attemptCount, 1);
    assert.equal(retryCompanionTask(value.db, created.id).status, "queued");
    const second = claimNextCompanionTask(value.db, { workerId: "local-worker" });
    assert.equal(second.task.attemptCount, 2);
    assert.equal(cancelCompanionTask(value.db, created.id).status, "cancelled");
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-worker",
        requestChecksum: second.task.requestChecksum,
        result: { jobs: [] },
      }),
      /not running/,
    );
  } finally {
    cleanup(value);
  }
});

test("expired leases return to the queue and become terminal after the retry limit", () => {
  const value = fixture("companion-stale");
  try {
    const created = createCompanionTask(value.db, { kind: "collect_jobs" }, context).task;
    const started = new Date("2026-07-19T00:00:00.000Z");
    claimNextCompanionTask(value.db, { workerId: "local-worker", leaseSeconds: 30, now: started });
    assert.equal(recoverStaleCompanionTasks(value.db, { now: new Date("2026-07-19T00:00:31.000Z") }), 1);
    assert.equal(listCompanionTasks(value.db)[0].status, "queued");
    value.db.prepare("UPDATE agent_tasks SET max_attempts = 2 WHERE id = ?").run(created.id);
    claimNextCompanionTask(value.db, { workerId: "local-worker", leaseSeconds: 30, now: new Date("2026-07-19T00:01:00.000Z") });
    assert.equal(recoverStaleCompanionTasks(value.db, { now: new Date("2026-07-19T00:01:31.000Z") }), 1);
    const terminal = listCompanionTasks(value.db)[0];
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.error.code, "stale_lease");
  } finally {
    cleanup(value);
  }
});

test("package results require the current request checksum and approved local references", () => {
  const value = fixture("companion-generation-result");
  try {
    addResume(value.db);
    const jobId = addJob(value.db, "generation-result");
    const created = createCompanionTask(value.db, { kind: "generate_package", jobId }, context).task;
    const claimed = claimNextCompanionTask(value.db, { workerId: "local-generator" });
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-generator", requestChecksum: "stale", result: { sections: [] },
      }),
      /checksum is stale/,
    );
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-generator",
        requestChecksum: claimed.task.requestChecksum,
        result: { sections: [{ key: "summary", value: "Unsupported claim", sourceRefs: ["evidence:unknown"] }] },
      }),
      /cite only approved/,
    );
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-generator",
        requestChecksum: claimed.task.requestChecksum,
        result: { sections: [{ key: "summary", value: "Invented improvement of 99%", sourceRefs: ["section:summary"] }] },
      }),
      /numeric claim/,
    );
    const completed = completeCompanionTask(value.db, created.id, {
      workerId: "local-generator",
      requestChecksum: claimed.task.requestChecksum,
      result: {
        sections: [{
          key: "summary",
          value: "Approved synthetic experience, reordered for the example role without adding a new fact.",
          sourceRefs: ["section:summary"],
        }],
      },
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.review.status, "awaiting_review");
    assert.match(completed.resultChecksum, /^[0-9a-f]{64}$/);
    const resultPath = companionTaskPath(created.id, "result.json");
    assert.equal(fs.statSync(resultPath).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(stored.requestChecksum, claimed.task.requestChecksum);
    assert.equal(stored.resultChecksum, completed.resultChecksum);
    const review = value.db.prepare("SELECT status, result_checksum FROM agent_task_reviews WHERE task_id = ?").get(created.id);
    assert.deepEqual({ ...review }, { status: "awaiting_review", result_checksum: completed.resultChecksum });
    const duplicate = createCompanionTask(value.db, { kind: "generate_package", jobId }, context);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.task.id, created.id);
  } finally {
    cleanup(value);
  }
});

test("numeric claim validation compares normalized values instead of substrings", () => {
  const value = fixture("companion-numeric-claims");
  try {
    saveResume(value.db, {
      jobFamily: "General",
      jobRole: "Example Role",
      careerType: "experienced",
      yearsExperience: 2,
      summary: "Handled 1,000 records and improved completion by 20 percent.",
      editableSections: ["summary"],
    });
    const jobId = addJob(value.db, "numeric-claims");
    const created = createCompanionTask(value.db, { kind: "generate_package", jobId }, context).task;
    const claimed = claimNextCompanionTask(value.db, { workerId: "local-generator" });
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-generator",
        requestChecksum: claimed.task.requestChecksum,
        result: { sections: [{ key: "summary", value: "Handled 100 records.", sourceRefs: ["section:summary"] }] },
      }),
      /numeric claim/,
    );
    const completed = completeCompanionTask(value.db, created.id, {
      workerId: "local-generator",
      requestChecksum: claimed.task.requestChecksum,
      result: { sections: [{ key: "summary", value: "Handled 1000 records and improved completion by 20%.", sourceRefs: ["section:summary"] }] },
    });
    assert.equal(completed.status, "succeeded");

    saveResume(value.db, {
      jobRole: "Example Specialist", careerStage: "experienced", yearsExperience: 20,
      summary: "Handled work for 20 years.", editableSections: ["summary"],
    });
    const unitTask = createCompanionTask(value.db, { kind: "generate_package", jobId }, context).task;
    const claimedUnitTask = claimNextCompanionTask(value.db, { workerId: "local-generator" });
    assert.equal(claimedUnitTask.task.id, unitTask.id);
    assert.throws(
      () => completeCompanionTask(value.db, unitTask.id, {
        workerId: "local-generator",
        requestChecksum: claimedUnitTask.task.requestChecksum,
        result: { sections: [{ key: "summary", value: "Improved the result by 20%.", sourceRefs: ["section:summary"] }] },
      }),
      /numeric claim/,
    );
  } finally {
    cleanup(value);
  }
});

test("collection results reject credential-like query and fragment parameters", () => {
  const credentialKeys = [["access", "token"].join("_"), ["api", "key"].join("_")];
  for (const [index, key] of credentialKeys.entries()) {
    const suffix = `${index === 0 ? "?" : "#"}${key}=synthetic-value`;
    const value = fixture("companion-public-url");
    try {
      const created = createCompanionTask(value.db, { kind: "collect_jobs" }, context).task;
      const claimed = claimNextCompanionTask(value.db, { workerId: "local-collector" });
      assert.throws(
        () => completeCompanionTask(value.db, created.id, {
          workerId: "local-collector",
          requestChecksum: claimed.task.requestChecksum,
          result: { jobs: [{
            jobKey: "unsafe-url",
            companyName: "Example Organization",
            title: "Example Role",
            sources: [{ platform: "direct", url: `https://example.invalid/job${suffix}` }],
          }] },
        }),
        /credential-like/,
      );
    } finally {
      cleanup(value);
    }
  }
});

test("completion fails closed when the local request file no longer matches its checksum", () => {
  const value = fixture("companion-request-tamper");
  try {
    const created = createCompanionTask(value.db, { kind: "collect_jobs" }, context).task;
    const claimed = claimNextCompanionTask(value.db, { workerId: "local-collector" });
    const requestPath = companionTaskPath(created.id, "request.json");
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    request.input.search.targetRoles = ["Changed after claim"];
    fs.writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-collector",
        requestChecksum: claimed.task.requestChecksum,
        result: { jobs: [] },
      }),
      /request checksum mismatch/,
    );
    assert.equal(listCompanionTasks(value.db)[0].status, "running");
  } finally {
    cleanup(value);
  }
});

test("document analysis accepts only unchanged private documents with locators and rejects age content", () => {
  const value = fixture("companion-document-analysis");
  const documentDirectory = fs.mkdtempSync(path.join(PRIVATE_DATA_DIR, "companion-analysis-fixture-"));
  try {
    const documentPath = path.join(documentDirectory, "source.pdf");
    const contents = Buffer.from("%PDF-1.4 synthetic local document");
    fs.writeFileSync(documentPath, contents, { mode: 0o600 });
    const documentChecksum = crypto.createHash("sha256").update(contents).digest("hex");
    value.db.prepare(`
      INSERT INTO source_documents (id, kind, internal_path, mime_type, size_bytes, sha256, active)
      VALUES ('document-1', 'manual', ?, 'application/pdf', ?, ?, 1)
    `).run(documentPath, contents.length, documentChecksum);
    const created = createCompanionTask(value.db, { kind: "analyze_documents", documentIds: ["document-1"] }, context).task;
    const claimed = claimNextCompanionTask(value.db, { workerId: "local-analyzer" });
    const reference = [{ documentId: "document-1", locator: "page 1" }];
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-analyzer",
        requestChecksum: claimed.task.requestChecksum,
        result: {
          facts: [{ id: "fact-1", key: "birth", value: "date of birth: 1990", sourceDocumentId: "document-1", sourceLocator: "page 1" }],
          evidence: [{ id: "evidence-1", sourceRefs: reference }],
          sections: [{ id: "section-1", sourceRefs: reference }],
        },
      }),
      /age or date of birth/i,
    );
    assert.throws(
      () => completeCompanionTask(value.db, created.id, {
        workerId: "local-analyzer",
        requestChecksum: claimed.task.requestChecksum,
        result: {
          facts: [],
          evidence: [],
          sections: [{ id: "section-skills", key: "skills", label: "Skills", kind: "text", value: "Synthetic skill", sourceRefs: reference }],
        },
      }),
      /skills.*list/i,
    );
    const completed = completeCompanionTask(value.db, created.id, {
      workerId: "local-analyzer",
      requestChecksum: claimed.task.requestChecksum,
      result: {
        facts: [{ id: "fact-1", key: "skill", label: "Skill", value: "Synthetic skill", confidence: 90, sourceDocumentId: "document-1", sourceLocator: "page 1" }],
        evidence: [{ id: "evidence-1", title: "Synthetic evidence", description: "Synthetic evidence description", sourceRefs: reference }],
        sections: [{ id: "section-1", key: "summary", label: "Summary", kind: "text", value: "Synthetic summary", sourceRefs: reference }],
      },
    });
    assert.equal(completed.status, "succeeded");
  } finally {
    cleanup(value);
    fs.rmSync(documentDirectory, { recursive: true, force: true });
  }
});
