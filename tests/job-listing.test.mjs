import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  getJobDetail,
  importJobsBatch,
  initializeDatabase,
  listJobPage,
  listJobs,
  openDatabase,
  publicJobSummary,
} from "../lib/database.mjs";

const sourcesConfig = {
  primary_selection: { prefer_direct_company: true, require_not_closed: true },
  sources: {
    direct: { label: "Direct", collect: true, display: true, lifecycle_check: true, priority: 0 },
    portal: { label: "Portal", collect: true, display: true, lifecycle_check: true, priority: 10 },
  },
};

function fixture(count = 320) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-listing-"));
  const file = path.join(directory, "personal.sqlite");
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  const jobs = Array.from({ length: count }, (_, index) => ({
    jobKey: `synthetic-${String(index).padStart(4, "0")}`,
    companyName: `Organization ${String(index).padStart(4, "0")}`,
    title: index % 2 ? "Systems Specialist" : "Service Coordinator",
    track: index % 3 ? "Operations" : "Engineering",
    location: index % 2 ? "Remote" : "Hybrid",
    employmentType: "Full-time",
    status: index < 5 ? "closed" : "active",
    deadline: `2099-12-${String((index % 28) + 1).padStart(2, "0")}`,
    summary: `Synthetic generic job summary ${index} ${"detail ".repeat(8)}`,
    score: 100 - (index % 101),
    sources: [{
      platform: index % 2 ? "portal" : "direct",
      url: `https://example.invalid/jobs/${index}`,
      status: index < 5 ? "closed" : "active",
      deadline: `2099-12-${String((index % 28) + 1).padStart(2, "0")}`,
      confidence: 80,
      provenance: { adapterId: "synthetic-adapter", retrievalMethod: "public_page" },
    }],
  }));
  importJobsBatch(db, jobs);
  return { directory, db };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test("paginated summaries and lazy details preserve legacy result parity", () => {
  const value = fixture(140);
  const now = new Date("2026-07-19T12:00:00.000Z");
  try {
    const legacy = listJobs(value.db, sourcesConfig, { now });
    const page = listJobPage(value.db, sourcesConfig, { page: 1, pageSize: 25, filters: { lifecycle: "all", sort: "score" }, now });
    assert.equal(page.items.length, 25);
    assert.equal(page.total, 140);
    assert.equal(page.totalPages, 6);
    assert.deepEqual(page.items, legacy.slice(0, 25).map(publicJobSummary));
    const detail = getJobDetail(value.db, page.items[0].id, sourcesConfig, { now });
    assert.deepEqual(detail, legacy.find((job) => job.id === page.items[0].id));
    assert.equal(Object.hasOwn(page.items[0].sources[0], "url"), false);
    assert.equal(detail.sources[0].url.startsWith("https://"), true);

    const second = listJobPage(value.db, sourcesConfig, { page: 2, pageSize: 25, filters: { lifecycle: "all", sort: "score" }, now });
    assert.equal(second.items.some((item) => page.items.some((first) => first.id === item.id)), false);
    const engineering = listJobPage(value.db, sourcesConfig, { page: 1, pageSize: 100, filters: { lifecycle: "all", track: "Engineering" }, now });
    assert.equal(engineering.items.every((item) => item.track === "Engineering"), true);
    const archived = listJobPage(value.db, sourcesConfig, { page: 1, pageSize: 100, filters: { lifecycle: "archive" }, now });
    assert.equal(archived.total, 5);
    assert.equal(archived.items.every((item) => item.status === "closed"), true);
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test("bounded listing reduces first-response work and payload on a synthetic large database", (context) => {
  const value = fixture(600);
  const now = new Date("2026-07-19T12:00:00.000Z");
  try {
    const legacyTimes = [];
    const pageTimes = [];
    let legacy;
    let page;
    for (let round = 0; round < 3; round += 1) {
      let started = performance.now();
      legacy = listJobs(value.db, sourcesConfig, { now });
      legacyTimes.push(performance.now() - started);
      started = performance.now();
      page = listJobPage(value.db, sourcesConfig, { page: 1, pageSize: 30, filters: { lifecycle: "active" }, now });
      pageTimes.push(performance.now() - started);
    }
    const legacyBytes = Buffer.byteLength(JSON.stringify({ jobs: legacy }));
    const pageBytes = Buffer.byteLength(JSON.stringify(page));
    context.diagnostic(`legacy median ${median(legacyTimes).toFixed(2)}ms / ${legacyBytes} bytes; page median ${median(pageTimes).toFixed(2)}ms / ${pageBytes} bytes`);
    assert.equal(page.items.length, 30);
    assert.equal(page.total, 595);
    assert.ok(pageBytes < legacyBytes * 0.15, `${pageBytes} should be below 15% of ${legacyBytes}`);
    assert.ok(median(pageTimes) < median(legacyTimes), `${median(pageTimes)} should be faster than ${median(legacyTimes)}`);
  } finally {
    value.db.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
