import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function prepareProject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codespaces-server-"));
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
    const timer = setTimeout(() => reject(new Error("Codespaces server did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Job Search Operations Dashboard:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Codespaces server exited before startup: ${code}`));
    });
  });
}

function localRequest(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method: options.method || "GET",
      headers: options.headers || {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test("Codespaces configuration installs dependencies, opens only the release port, and starts the guarded runtime", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../.devcontainer/devcontainer.json", import.meta.url), "utf8"));
  assert.match(config.image, /javascript-node:.*22/);
  assert.deepEqual(config.forwardPorts, [8766]);
  assert.equal(config.portsAttributes["8766"].onAutoForward, "openBrowser");
  assert.match(config.postCreateCommand, /^npm ci/);
  assert.match(config.postCreateCommand, /playwright install --with-deps chromium/);
  assert.equal(config.postAttachCommand.dashboard, "npm run codespaces");
  assert.equal(config.remoteUser, "node");
});

test("public documentation links to the default-branch Codespaces launcher and warns against personal data", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const guide = fs.readFileSync(new URL("../docs/CODESPACES.md", import.meta.url), "utf8");
  assert.match(readme, /https:\/\/github\.com\/codespaces\/new\?hide_repo_select=true&ref=main&repo=1298501275&skip_quickstart=true/);
  assert.match(guide, /Private/);
  assert.match(guide, /합성 이력서/);
  assert.match(guide, /Public.*변경하지 마세요/);
  assert.match(guide, /AI를 내장 호출하지 않/);
});

test("the real onboarding server accepts its exact Codespaces proxy and rejects forged hosts and origins", async () => {
  const directory = prepareProject();
  const port = 25000 + (process.pid % 1000);
  const codespaceName = "example-user-dashboard-abc123";
  const forwardingDomain = "app.github.dev";
  const forwardedHost = `${codespaceName}-${port}.${forwardingDomain}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: {
      ...process.env,
      APP_MODE: "onboarding",
      PORT: String(port),
      CODESPACES: "true",
      CODESPACE_NAME: codespaceName,
      GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: forwardingDomain,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(child);
    const allowedHeaders = { host: forwardedHost, origin: `https://${forwardedHost}` };
    const dashboardResponse = await localRequest(port, "/api/dashboard", { headers: allowedHeaders });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = JSON.parse(dashboardResponse.body);
    assert.equal(dashboard.mode, "onboarding");
    assert.equal(dashboard.environment.codespaces, true);

    const saved = await localRequest(port, "/api/onboarding", {
      method: "PATCH",
      headers: { ...allowedHeaders, "content-type": "application/json" },
      body: JSON.stringify({ privacyAccepted: true, currentStep: 1 }),
    });
    assert.equal(saved.status, 200, saved.body);

    assert.equal((await localRequest(port, "/api/dashboard", { headers: { host: `forged-${forwardedHost}` } })).status, 403);
    assert.equal((await localRequest(port, "/api/dashboard", { headers: { host: forwardedHost, origin: "https://evil.example" } })).status, 403);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
