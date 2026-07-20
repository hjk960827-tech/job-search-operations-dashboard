import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importJobsBatch, initializeDatabase, openDatabase } from "../lib/database.mjs";
import { runLimitedJobReads } from "../lib/read-orchestrator.mjs";

const tasks = [
  { taskKey: "source-c", input: { keys: ["role-d"] } },
  { taskKey: "source-a", input: { keys: ["role-a", "role-b"] } },
  { taskKey: "source-b", input: { keys: ["role-b", "role-c"] } },
];

function job(jobKey) {
  return {
    jobKey,
    companyName: `Organization ${jobKey.slice(-1).toUpperCase()}`,
    title: "Example Role",
    status: "active",
    sources: [{ platform: "direct", url: `https://example.invalid/${jobKey}`, status: "active" }],
  };
}

async function worker({ taskKey, input }) {
  await new Promise((resolve) => setTimeout(resolve, ({ "source-a": 3, "source-b": 1, "source-c": 2 })[taskKey]));
  return { jobs: input.keys.map(job) };
}

function snapshot(db) {
  return {
    jobs: db.prepare("SELECT job_key, company_name, title, lifecycle_status FROM jobs ORDER BY job_key").all(),
    sources: db.prepare("SELECT platform, source_url, lifecycle_status FROM job_sources ORDER BY source_url").all(),
  };
}

test("serial and limited-parallel readers produce the same deterministic reducer output in three replica databases", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-orchestrator-"));
  const expected = [];
  try {
    for (const [index, concurrency] of [1, 2, 4].entries()) {
      const runRoot = path.join(directory, `runs-${concurrency}`);
      const result = await runLimitedJobReads(tasks, worker, { concurrency, runRoot });
      assert.equal(result.run.status, "succeeded");
      assert.deepEqual(result.combined.jobs.map((item) => item.jobKey), ["role-a", "role-b", "role-c", "role-d"]);
      const runDirectory = path.join(runRoot, result.run.id);
      assert.equal(fs.statSync(runRoot).mode & 0o777, 0o700);
      assert.equal(fs.statSync(runDirectory).mode & 0o777, 0o700);
      for (const name of fs.readdirSync(runDirectory)) assert.equal(fs.statSync(path.join(runDirectory, name)).mode & 0o777, 0o600);

      const dbPath = path.join(directory, `replica-${index}.sqlite`);
      initializeDatabase(dbPath, { mode: "personal" });
      const db = openDatabase(dbPath);
      importJobsBatch(db, result.combined.jobs);
      expected.push(snapshot(db));
      db.close();
    }
    assert.deepEqual(expected[1], expected[0]);
    assert.deepEqual(expected[2], expected[0]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed worker creates only a failed run manifest and cannot change a database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-worker-failure-"));
  const runRoot = path.join(directory, "runs");
  const dbPath = path.join(directory, "personal.sqlite");
  initializeDatabase(dbPath, { mode: "personal" });
  const db = openDatabase(dbPath);
  importJobsBatch(db, [job("baseline")]);
  const before = snapshot(db);
  try {
    let failedRun;
    await assert.rejects(
      () => runLimitedJobReads(tasks, async (task) => {
        if (task.taskKey === "source-b") throw new Error("synthetic worker failure");
        return worker(task);
      }, { concurrency: 3, runRoot }),
      (error) => {
        failedRun = error.run;
        return /Read worker failed/.test(error.message);
      },
    );
    assert.deepEqual(snapshot(db), before);
    const runDirectory = path.join(runRoot, failedRun.id);
    assert.equal(fs.existsSync(path.join(runDirectory, "combined.json")), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(runDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.failure.taskKey, "source-b");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("conflicting facts for one job key fail before a combined artifact exists", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-conflict-"));
  try {
    await assert.rejects(() => runLimitedJobReads([
      { taskKey: "one", input: {} },
      { taskKey: "two", input: {} },
    ], async ({ taskKey }) => ({ jobs: [{ ...job("same-role"), title: taskKey }] }), {
      concurrency: 2,
      runRoot: path.join(directory, "runs"),
    }), /conflicting facts/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
