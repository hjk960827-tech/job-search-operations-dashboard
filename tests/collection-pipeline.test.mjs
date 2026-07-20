import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importJob,
  importJobsBatch,
  initializeDatabase,
  listJobPage,
  listJobs,
  openDatabase,
} from "../lib/database.mjs";
import {
  publishCollectionRun,
  stageCollectionBatch,
  getCollectionRun,
} from "../lib/collection-pipeline.mjs";

const sourcesConfig = {
  primary_selection: { prefer_direct_company: true, require_not_closed: true },
  sources: {
    direct: { label: "Direct", collect: true, display: true, lifecycle_check: true, priority: 0 },
    portal_a: { label: "Portal A", collect: true, display: true, lifecycle_check: true, priority: 10 },
    disabled: { label: "Disabled", collect: false, display: true, lifecycle_check: true, priority: 20 },
  },
};

function fixture(label = "collection-pipeline") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const dbPath = path.join(directory, "personal.sqlite");
  const runRoot = path.join(directory, "runs");
  initializeDatabase(dbPath, { mode: "personal" });
  return { directory, dbPath, runRoot, db: openDatabase(dbPath) };
}

function cleanup(value) {
  value.db.close();
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function envelope(overrides = {}) {
  return {
    adapterId: "generic-public-adapter",
    accessPolicy: "public_page",
    generatedAt: "2026-07-19T10:00:00.000Z",
    jobs: [{
      jobKey: "multi-source-role",
      companyName: "Example Organization",
      title: "Service Coordinator",
      status: "active",
      deadline: "2026-07-25",
      deadlineSource: "public posting",
      sources: [
        { platform: "direct", url: "https://example.invalid/direct-role", status: "active", deadline: "2026-07-25", confidence: 95 },
        { platform: "portal_a", url: "https://example.invalid/portal-role", status: "active", deadline: "2026-07-24", confidence: 80 },
      ],
    }],
    ...overrides,
  };
}

function dataState(db) {
  return {
    jobs: db.prepare("SELECT * FROM jobs ORDER BY job_key").all(),
    sources: db.prepare("SELECT * FROM job_sources ORDER BY job_id, platform, source_url").all(),
  };
}

test("batch import is atomic and preserves source-specific deadlines and provenance", () => {
  const value = fixture();
  try {
    assert.throws(() => importJobsBatch(value.db, [
      envelope().jobs[0],
      { jobKey: "invalid-second", companyName: "Example", title: "Role", deadline: "2026-02-30" },
    ]), /real calendar date/);
    assert.deepEqual(dataState(value.db), { jobs: [], sources: [] });

    importJobsBatch(value.db, envelope().jobs);
    const job = value.db.prepare("SELECT * FROM jobs WHERE job_key = 'multi-source-role'").get();
    const sources = value.db.prepare("SELECT * FROM job_sources WHERE job_id = ? ORDER BY platform").all(job.id);
    assert.equal(job.deadline, "2026-07-25");
    assert.deepEqual(sources.map((item) => item.deadline), ["2026-07-25", "2026-07-24"]);
    assert.equal(sources.every((item) => item.access_method === "import"), true);
  } finally { cleanup(value); }
});

test("a job closes only when every effective source is closed and reopens when one source becomes active", () => {
  const value = fixture();
  try {
    const job = envelope({ jobs: [{ ...envelope().jobs[0], deadline: null, sources: [
      { platform: "direct", url: "https://example.invalid/direct-role", status: "closed" },
      { platform: "portal_a", url: "https://example.invalid/portal-role", status: "active" },
    ] }] }).jobs[0];
    const jobId = importJob(value.db, job);
    assert.equal(value.db.prepare("SELECT lifecycle_status FROM jobs WHERE id = ?").get(jobId).lifecycle_status, "active");
    importJob(value.db, { ...job, sources: job.sources.map((item) => ({ ...item, status: "closed" })) });
    assert.equal(value.db.prepare("SELECT lifecycle_status FROM jobs WHERE id = ?").get(jobId).lifecycle_status, "closed");
    importJob(value.db, { ...job, sources: [{ ...job.sources[1], status: "active" }] });
    const reopened = value.db.prepare("SELECT lifecycle_status, reopened_at, reopen_count FROM jobs WHERE id = ?").get(jobId);
    assert.equal(reopened.lifecycle_status, "active");
    assert.ok(reopened.reopened_at);
    assert.equal(reopened.reopen_count, 1);
    importJob(value.db, { ...job, sources: [{ ...job.sources[1], status: "active" }] });
    assert.equal(value.db.prepare("SELECT reopen_count FROM jobs WHERE id = ?").get(jobId).reopen_count, 1);
    assert.equal(value.db.prepare("SELECT lifecycle_status FROM jobs WHERE id = ?").get(jobId).lifecycle_status, "active");
  } finally { cleanup(value); }
});

test("deadline display data derives D-day and expires a source without discarding sibling links", () => {
  const value = fixture();
  try {
    importJobsBatch(value.db, envelope().jobs);
    const [job] = listJobs(value.db, sourcesConfig, { now: new Date("2026-07-25T12:00:00Z") });
    assert.equal(job.deadline, "2026-07-25");
    assert.equal(job.deadlineDays, 0);
    assert.equal(job.sources.length, 2);
    assert.equal(job.primarySource.platform, "direct");
    const expired = listJobs(value.db, sourcesConfig, { now: new Date("2026-07-26T12:00:00Z") })[0];
    assert.equal(expired.status, "closed");
    assert.equal(expired.sources.every((item) => item.status === "closed"), true);
  } finally { cleanup(value); }
});

test("deadline filtering and detail use the same effective open-source deadline", () => {
  const value = fixture("deadline-parity");
  try {
    importJob(value.db, {
      jobKey: "mixed-source-deadlines",
      companyName: "Example Organization",
      title: "Service Coordinator",
      status: "active",
      sources: [
        { platform: "direct", url: "https://example.invalid/closed", status: "closed", deadline: "2026-07-01" },
        { platform: "portal_a", url: "https://example.invalid/open", status: "active", deadline: "2026-07-22" },
      ],
    });
    const page = listJobPage(value.db, sourcesConfig, {
      filters: { deadline: "urgent", lifecycle: "active" },
      now: new Date("2026-07-19T00:00:00Z"),
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].deadline, "2026-07-22");
    assert.equal(page.items[0].deadlineDays, 3);
    assert.equal(page.items[0].status, "active");
  } finally { cleanup(value); }
});

test("a passed job deadline closes undated sources while a later source deadline keeps the job open", () => {
  const value = fixture("job-deadline-fallback");
  try {
    const expiredId = importJob(value.db, {
      jobKey: "expired-job-deadline",
      companyName: "Example Organization",
      title: "Expired Role",
      status: "active",
      deadline: "2026-07-01",
      sources: [{ platform: "direct", url: "https://example.invalid/expired", status: "active" }],
    });
    const laterId = importJob(value.db, {
      jobKey: "later-source-deadline",
      companyName: "Example Organization",
      title: "Open Role",
      status: "active",
      deadline: "2026-07-01",
      sources: [{ platform: "portal_a", url: "https://example.invalid/later", status: "active", deadline: "2026-07-22" }],
    });
    const jobs = listJobs(value.db, sourcesConfig, { now: new Date("2026-07-19T00:00:00Z") });
    assert.equal(jobs.find((item) => item.id === expiredId).status, "closed");
    assert.equal(jobs.find((item) => item.id === laterId).status, "active");
    assert.equal(jobs.find((item) => item.id === laterId).deadline, "2026-07-22");
  } finally { cleanup(value); }
});

test("D-day uses the configured local calendar date instead of UTC", () => {
  const value = fixture("deadline-timezone");
  try {
    importJob(value.db, {
      jobKey: "timezone-boundary",
      companyName: "Example Organization",
      title: "Example Role",
      status: "active",
      deadline: "2026-07-20",
      sources: [{ platform: "direct", url: "https://example.invalid/timezone", status: "active" }],
    });
    const instant = new Date("2026-07-19T16:00:00.000Z");
    assert.equal(listJobs(value.db, sourcesConfig, { now: instant, timeZone: "Asia/Seoul" })[0].deadlineDays, 0);
    assert.equal(listJobs(value.db, sourcesConfig, { now: instant, timeZone: "America/New_York" })[0].deadlineDays, 1);
  } finally { cleanup(value); }
});

test("collection dry-run is non-mutating, coalesces duplicates, and publishes its staged diff atomically", () => {
  const value = fixture();
  try {
    const before = dataState(value.db);
    const staged = stageCollectionBatch(value.db, envelope(), { sourcesConfig, runRoot: value.runRoot });
    assert.equal(staged.run.status, "staged");
    assert.equal(staged.run.counts.create, 1);
    assert.deepEqual(dataState(value.db), before);
    const duplicate = stageCollectionBatch(value.db, envelope(), { sourcesConfig, runRoot: value.runRoot });
    assert.equal(duplicate.coalesced, true);
    assert.equal(duplicate.run.id, staged.run.id);

    const directory = path.join(value.runRoot, staged.run.id);
    assert.equal(fs.statSync(value.runRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const file of ["manifest.json", "batch.json", "staging.sqlite"]) {
      assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    }
    const published = publishCollectionRun(value.db, staged.run.id, {
      expectedChecksum: staged.run.requestChecksum,
      sourcesConfig,
      runRoot: value.runRoot,
    });
    assert.equal(published.run.status, "published");
    assert.equal(published.imported.length, 1);
    const source = value.db.prepare("SELECT * FROM job_sources").get();
    assert.equal(source.access_method, "public_page");
    assert.equal(JSON.parse(source.provenance_json).adapterId, "generic-public-adapter");
  } finally { cleanup(value); }
});

test("a manifest write failure leaves an authoritative DB publication that retries without reimporting", () => {
  const value = fixture("collection-manifest-recovery");
  try {
    const staged = stageCollectionBatch(value.db, envelope(), { sourcesConfig, runRoot: value.runRoot });
    const directory = path.join(value.runRoot, staged.run.id);
    fs.chmodSync(directory, 0o500);
    const published = publishCollectionRun(value.db, staged.run.id, {
      expectedChecksum: staged.run.requestChecksum,
      sourcesConfig,
      runRoot: value.runRoot,
    });
    assert.equal(published.run.status, "published");
    assert.equal(published.run.artifactSynchronized, false);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 1);
    assert.ok(value.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(`collection_publication:${staged.run.id}`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")).status, "staged");
    const authoritative = getCollectionRun(staged.run.id, { db: value.db, runRoot: value.runRoot });
    assert.equal(authoritative.status, "published");
    assert.equal(authoritative.artifactSynchronized, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")).status, "staged");
    assert.throws(() => publishCollectionRun(value.db, staged.run.id, {
      sourcesConfig, runRoot: value.runRoot,
    }), /checksum is stale/);

    fs.chmodSync(directory, 0o700);
    const recovered = publishCollectionRun(value.db, staged.run.id, {
      expectedChecksum: staged.run.requestChecksum,
      sourcesConfig,
      runRoot: value.runRoot,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.run.artifactSynchronized, true);
    assert.equal(getCollectionRun(staged.run.id, { db: value.db, runRoot: value.runRoot }).status, "published");
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 1);
  } finally {
    try {
      for (const name of fs.existsSync(value.runRoot) ? fs.readdirSync(value.runRoot) : []) {
        fs.chmodSync(path.join(value.runRoot, name), 0o700);
      }
    } catch {}
    cleanup(value);
  }
});

test("stale or tampered staged runs fail without publishing their jobs", () => {
  const value = fixture();
  try {
    const staged = stageCollectionBatch(value.db, envelope(), { sourcesConfig, runRoot: value.runRoot });
    importJob(value.db, {
      jobKey: "concurrent-change", companyName: "Concurrent", title: "Role",
      sources: [{ platform: "direct", url: "https://example.invalid/concurrent", status: "active" }],
    });
    assert.throws(() => publishCollectionRun(value.db, staged.run.id, {
      expectedChecksum: staged.run.requestChecksum, sourcesConfig, runRoot: value.runRoot,
    }), /Jobs changed after staging/);
    assert.equal(value.db.prepare("SELECT id FROM jobs WHERE job_key = 'multi-source-role'").get(), undefined);

    const second = stageCollectionBatch(value.db, envelope(), { sourcesConfig, runRoot: value.runRoot });
    fs.appendFileSync(path.join(value.runRoot, second.run.id, "batch.json"), " ");
    assert.throws(() => publishCollectionRun(value.db, second.run.id, {
      expectedChecksum: second.run.requestChecksum, sourcesConfig, runRoot: value.runRoot,
    }), /artifacts changed/);
    assert.equal(value.db.prepare("SELECT id FROM jobs WHERE job_key = 'multi-source-role'").get(), undefined);
  } finally { cleanup(value); }
});

test("adapter contract rejects disabled sources, account state, disallowed access, and company review fields", () => {
  const value = fixture();
  try {
    const variants = [
      envelope({ jobs: [{ ...envelope().jobs[0], sources: [{ platform: "disabled", url: "https://example.invalid/x", status: "active" }] }] }),
      { ...envelope(), accountToken: ["not", "stored"].join("-") },
      { ...envelope(), jobs: [{ ...envelope().jobs[0], companyRating: 4 }] },
      { ...envelope(), jobs: [{ ...envelope().jobs[0], sources: [{ ...envelope().jobs[0].sources[0], accessMethod: "official_api" }] }] },
      { ...envelope(), generatedAt: "not-a-date" },
    ];
    for (const input of variants) {
      assert.throws(() => stageCollectionBatch(value.db, input, { sourcesConfig, runRoot: value.runRoot }));
    }
    assert.deepEqual(dataState(value.db), { jobs: [], sources: [] });
    assert.equal(fs.existsSync(value.runRoot) ? fs.readdirSync(value.runRoot).length : 0, 0);
  } finally { cleanup(value); }
});

test("run artifacts bind to exact request and staging checksums", () => {
  const value = fixture();
  try {
    const staged = stageCollectionBatch(value.db, envelope(), { sourcesConfig, runRoot: value.runRoot });
    const manifest = JSON.parse(fs.readFileSync(path.join(value.runRoot, staged.run.id, "manifest.json"), "utf8"));
    const batch = fs.readFileSync(path.join(value.runRoot, staged.run.id, "batch.json"));
    const staging = fs.readFileSync(path.join(value.runRoot, staged.run.id, "staging.sqlite"));
    assert.equal(manifest.batchChecksum, crypto.createHash("sha256").update(batch).digest("hex"));
    assert.equal(manifest.stagingChecksum, crypto.createHash("sha256").update(staging).digest("hex"));
  } finally { cleanup(value); }
});

test("collection run lookup rejects a run directory symbolic link", () => {
  const value = fixture("collection-run-link");
  try {
    fs.mkdirSync(value.runRoot, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "collection-run-outside-"));
    const runId = crypto.randomUUID();
    fs.writeFileSync(path.join(outside, "manifest.json"), "{}\n");
    fs.symlinkSync(outside, path.join(value.runRoot, runId));
    assert.throws(
      () => getCollectionRun(runId, { db: value.db, runRoot: value.runRoot }),
      /unsafe|symbolic links/,
    );
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { cleanup(value); }
});
