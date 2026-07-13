import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rawStatus(options, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
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

    const blockedResume = await fetch(`http://127.0.0.1:${port}/api/resume`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headline: "실제 개인정보", summary: "데모 DB에 저장되면 안 됩니다." }),
    });
    assert.equal(blockedResume.status, 409);

    const escaped = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`);
    assert.equal(escaped.status, 403);

    const forgedHost = await rawStatus({
      host: "127.0.0.1",
      port,
      path: "/api/health",
      method: "GET",
      headers: { host: `evil.example:${port}` },
    });
    assert.equal(forgedHost, 403);

    const forgedOrigin = await rawStatus({
      host: "127.0.0.1",
      port,
      path: "/api/jobs/1/state",
      method: "PATCH",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
    }, JSON.stringify({ favorite: true }));
    assert.equal(forgedOrigin, 403);

    const wrongContentType = await rawStatus({
      host: "127.0.0.1",
      port,
      path: "/api/jobs/1/state",
      method: "PATCH",
      headers: { "content-type": "text/plain" },
    }, JSON.stringify({ favorite: true }));
    assert.equal(wrongContentType, 415);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});
