import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 8000);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Job Search Operations Dashboard:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup: ${code} ${stderr}`));
    });
  });
}

function prepareProject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-server-"));
  for (const name of ["db", "lib", "web-dashboard", "config", "examples"]) {
    fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  const examples = {
    profile: "profile.example.yml",
    search: "search.example.yml",
    sources: "sources.example.yml",
    resume: "document.example.yml",
  };
  for (const [name, example] of Object.entries(examples)) {
    const value = yaml.load(fs.readFileSync(path.join(directory, "config", example), "utf8"));
    value.setup_complete = true;
    if (name === "profile") value.identity.display_name = "Example User";
    if (name === "search") value.target_roles = ["Example Role"];
    fs.writeFileSync(path.join(directory, "config", `${name}.yml`), yaml.dump(value), { mode: 0o600 });
  }
  return directory;
}

async function jsonRequest(base, requestPath, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${requestPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

function resumePayload(summary) {
  return {
    jobFamily: "Operations",
    jobRole: "Operations Specialist",
    careerType: "experienced",
    yearsExperience: 3,
    headline: "문제를 구조화하고 실행 결과를 검증하는 지원자",
    summary,
    skills: ["문제 구조화", "협업과 실행 관리"],
    experienceHighlights: ["여러 팀의 요구사항을 하나의 실행 목록으로 정리하고 결과를 검토했습니다."],
    editableSections: ["summary"],
  };
}

test("demo mode ignores completed local settings and uses only synthetic examples", async () => {
  const directory = prepareProject();
  const searchPath = path.join(directory, "config", "search.yml");
  const sourcesPath = path.join(directory, "config", "sources.yml");
  const localSearch = yaml.load(fs.readFileSync(searchPath, "utf8"));
  const localSources = yaml.load(fs.readFileSync(sourcesPath, "utf8"));
  localSearch.scoring.review_below = 12;
  localSources.sources.direct.label = "LOCAL PRIVATE LABEL";
  fs.writeFileSync(searchPath, yaml.dump(localSearch), { mode: 0o600 });
  fs.writeFileSync(sourcesPath, yaml.dump(localSources), { mode: 0o600 });
  const port = 22000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "demo", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(child);
    const dashboard = await jsonRequest(base, "/api/dashboard");
    assert.equal(dashboard.response.status, 200);
    assert.equal(dashboard.payload.mode, "demo");
    assert.equal(dashboard.payload.scoreReviewBelow, 70);
    assert.equal(dashboard.payload.sources.direct.label, "기업 채용 페이지");
    assert.notEqual(dashboard.payload.sources.direct.label, localSources.sources.direct.label);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("personal HTTP routes preserve refresh confirmation and block stale submission preparation", async () => {
  const directory = prepareProject();
  const port = 21000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "personal", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(child);
    const health = await jsonRequest(base, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.mode, "personal");

    const imported = await jsonRequest(base, "/api/jobs", {
      method: "POST",
      body: {
        jobKey: "personal-route-job",
        companyName: "Example Company",
        title: "Example Role",
        status: "active",
        sources: [{ platform: "direct", url: "https://example.invalid/job", status: "active" }],
      },
    });
    assert.equal(imported.response.status, 201);
    const jobId = imported.payload.jobId;

    assert.equal((await jsonRequest(base, "/api/resume", {
      method: "PUT",
      body: resumePayload("업무 기준을 문서화하고 이해관계자와 우선순위를 합의한 뒤 실행 결과를 검토해 개선으로 연결했습니다."),
    })).response.status, 200);

    const first = await jsonRequest(base, `/api/jobs/${jobId}/package`, { method: "POST", body: {} });
    assert.equal(first.response.status, 201);
    assert.equal(first.payload.package.version, 1);
    assert.equal(first.payload.package.state, "approval_pending");

    const missingChecksum = await jsonRequest(base, `/api/packages/${first.payload.package.id}/approve`, { method: "POST", body: {} });
    assert.equal(missingChecksum.response.status, 409);

    await jsonRequest(base, "/api/resume", {
      method: "PUT",
      body: resumePayload("변경된 기준에 맞춰 업무 흐름을 다시 정리하고 실행 결과와 다음 개선 우선순위를 함께 기록했습니다."),
    });
    const staleDashboard = await jsonRequest(base, "/api/dashboard");
    const stalePackage = staleDashboard.payload.jobs.find((job) => job.id === jobId).package;
    assert.equal(stalePackage.refreshRequired, true);

    const notConfirmed = await jsonRequest(base, `/api/jobs/${jobId}/package`, { method: "POST", body: {} });
    assert.equal(notConfirmed.payload.package.version, 1);
    const badConfirmation = await jsonRequest(base, `/api/jobs/${jobId}/package`, {
      method: "POST",
      body: { refreshConfirmed: "yes" },
    });
    assert.equal(badConfirmation.response.status, 400);

    const refreshed = await jsonRequest(base, `/api/jobs/${jobId}/package`, {
      method: "POST",
      body: { refreshConfirmed: true },
    });
    assert.equal(refreshed.response.status, 201);
    assert.equal(refreshed.payload.package.version, 2);
    assert.equal(refreshed.payload.package.refreshRequired, false);

    const approved = await jsonRequest(base, `/api/packages/${refreshed.payload.package.id}/approve`, {
      method: "POST",
      body: { expectedChecksum: refreshed.payload.package.checksum },
    });
    assert.equal(approved.response.status, 200, approved.payload.error);
    assert.equal(approved.payload.package.state, "approved");

    await jsonRequest(base, "/api/resume", {
      method: "PUT",
      body: resumePayload("승인 이후 기준이 다시 바뀐 상황을 재현하기 위해 충분한 길이의 새 요약 내용을 안전하게 저장했습니다."),
    });
    const stalePrepare = await jsonRequest(base, `/api/packages/${approved.payload.package.id}/prepare`, {
      method: "POST",
      body: { platform: "direct" },
    });
    assert.equal(stalePrepare.response.status, 409);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
