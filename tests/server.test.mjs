import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function prepareProject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "demo-server-"));
  for (const name of ["db", "lib", "web-dashboard", "config", "examples"]) {
    fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  for (const name of ["profile", "search", "sources", "resume"]) {
    fs.rmSync(path.join(directory, "config", `${name}.yml`), { force: true });
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  return directory;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Job Search Operations Dashboard:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup: ${code}`));
    });
  });
}

test("server exposes demo data, blocks every mutation, and prevents local request bypasses", async () => {
  const directory = prepareProject();
  const port = 18000 + (process.pid % 1000);
  const dbName = `server-test-${process.pid}.sqlite`;
  const outsideFile = path.join(directory, `server-outside-${process.pid}.txt`);
  const publicLink = path.join(directory, "web-dashboard", "public", `.server-outside-${process.pid}.txt`);
  fs.writeFileSync(outsideFile, "must not be served");
  fs.symlinkSync(outsideFile, publicLink);
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "demo", PORT: String(port), JOB_SEARCH_DB_PATH: `data/${dbName}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(child);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.mode, "demo");
    assert.equal(health.database, dbName);
    assert.equal(health.uiContract.contractId, "job-search-operations-ui");
    assert.equal(health.uiContract.schemaVersion, 1);

    const uiContract = await fetch(`http://127.0.0.1:${port}/api/ui-contract`).then((response) => response.json());
    assert.deepEqual(uiContract.frontendVersions, ["v2", "v3"]);
    assert.equal(uiContract.defaultFrontend, "v2");
    assert.deepEqual(uiContract.capabilities.jobs, { available: true, writable: false });
    assert.deepEqual(uiContract.capabilities.automaticSubmission, { available: false, writable: false });

    const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`).then((response) => response.json());
    assert.equal(dashboard.jobs.length, 3);
    assert.equal(dashboard.onboardingRequired, true);
    assert.deepEqual(dashboard.uiContract, uiContract);

    const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`).then((response) => response.json());
    assert.deepEqual(bootstrap.uiContract, uiContract);

    const mutations = [
      ["PATCH", "/api/jobs/1/state"],
      ["POST", "/api/jobs"],
      ["POST", "/api/jobs/batch"],
      ["PUT", "/api/resume/structured"],
      ["PATCH", "/api/resume/assets/example"],
      ["PUT", "/api/resume"],
      ["POST", "/api/jobs/1/package"],
      ["PUT", "/api/packages/1"],
      ["POST", "/api/packages/1/approve"],
      ["POST", "/api/packages/1/prepare"],
      ["POST", "/api/packages/1/cancel-prepare"],
      ["PATCH", "/api/packages/1/review"],
      ["POST", "/api/packages/1/submitted"],
      ["POST", "/api/jobs/1/outcomes"],
      ["POST", "/api/jobs/1/outcomes/1/corrections"],
      ["POST", "/api/jobs/1/follow-ups"],
      ["POST", "/api/follow-ups/example/complete"],
      ["POST", "/api/follow-ups/example/cancel"],
      ["POST", "/api/inbox/1/read"],
      ["POST", "/api/inbox/read-all"],
      ["POST", "/api/outcomes/1/evidence"],
      ["POST", "/api/saved-filters"],
      ["PUT", "/api/saved-filters/00000000-0000-4000-8000-000000000000"],
      ["DELETE", "/api/saved-filters/00000000-0000-4000-8000-000000000000"],
      ["POST", "/api/companion/tasks"],
      ["POST", "/api/companion/tasks/claim"],
      ["POST", "/api/companion/tasks/example/cancel"],
      ["PATCH", "/api/companion/tasks/example/review"],
      ["POST", "/api/companion/tasks/example/prepare-review"],
      ["POST", "/api/companion/tasks/example/apply-review"],
      ["POST", "/api/companion/tasks/example/reject-review"],
      ["PATCH", "/api/settings"],
      ["DELETE", "/api/settings/documents/example"],
      ["DELETE", "/api/future-write-route"],
    ];
    for (const [method, requestPath] of mutations) {
      const blocked = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(blocked.status, 409, `${method} ${requestPath} must be read-only in demo mode`);
    }
    const unchangedDashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`).then((response) => response.json());
    assert.deepEqual(unchangedDashboard.jobs, dashboard.jobs);
    assert.deepEqual(unchangedDashboard.resume, dashboard.resume);

    const foreignOrigin = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(foreignOrigin.status, 403);

    const escaped = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`);
    assert.equal(escaped.status, 403);
    const malformedEncoding = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
    assert.equal(malformedEncoding.status, 400);
    const symlinkEscape = await fetch(`http://127.0.0.1:${port}/${path.basename(publicLink)}`);
    assert.equal(symlinkEscape.status, 403);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
