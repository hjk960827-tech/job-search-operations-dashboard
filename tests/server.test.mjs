import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("server exposes demo data, blocks real imports, and prevents static path escape", async () => {
  const port = 18000 + (process.pid % 1000);
  const dbName = `server-test-${process.pid}.sqlite`;
  const dbPath = path.join(root, "data", dbName);
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: root,
    env: { ...process.env, APP_MODE: "demo", PORT: String(port), JOB_SEARCH_DB_PATH: `data/${dbName}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(child);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.mode, "demo");
    assert.equal(health.database, dbName);

    const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`).then((response) => response.json());
    assert.equal(dashboard.jobs.length, 3);
    assert.equal(dashboard.onboardingRequired, true);

    const blockedImport = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobKey: "blocked", companyName: "Example", title: "Role" }),
    });
    assert.equal(blockedImport.status, 409);

    const escaped = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`);
    assert.equal(escaped.status, 403);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});
