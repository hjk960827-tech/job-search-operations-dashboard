import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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
    if (name === "sources") value.sources.direct.collect = true;
    fs.writeFileSync(path.join(directory, "config", `${name}.yml`), yaml.dump(value), { mode: 0o600 });
  }
  return directory;
}

async function jsonRequest(base, requestPath, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${requestPath}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: response.status === 304 ? null : await response.json() };
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

test("revision ETags cannot reuse a response from another local database instance", async () => {
  const directories = [prepareProject(), prepareProject()];
  const port = 27000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const requestPath = "/api/jobs?page=1&pageSize=30&lifecycle=all";
  let firstEtag = "";
  try {
    for (const [index, directory] of directories.entries()) {
      const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
        cwd: directory,
        env: { ...process.env, APP_MODE: "personal", PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForServer(child);
        const result = await jsonRequest(base, requestPath, {
          headers: index === 0 ? {} : { "if-none-match": firstEtag },
        });
        assert.equal(result.response.status, 200);
        const etag = result.response.headers.get("etag");
        assert.ok(etag);
        if (index === 0) firstEtag = etag;
        else assert.notEqual(etag, firstEtag);
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
    }
  } finally {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("personal batch API stages a dry-run before an explicit atomic publish", async () => {
  const directory = prepareProject();
  const port = 25000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "personal", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(child);
    const input = {
      adapterId: "browser-neutral-adapter",
      accessPolicy: "public_page",
      generatedAt: "2026-07-19T10:00:00.000Z",
      jobs: [{
        jobKey: "batch-api-role", companyName: "Example Organization", title: "Coordinator", status: "active",
        deadline: "2026-07-31",
        sources: [{ platform: "direct", url: "https://example.invalid/batch-role", status: "active", deadline: "2026-07-31" }],
      }],
    };
    const staged = await jsonRequest(base, "/api/jobs/batch", { method: "POST", body: input });
    assert.equal(staged.response.status, 201, staged.payload.error);
    assert.equal(staged.payload.dryRun, true);
    assert.equal(staged.payload.run.counts.create, 1);
    assert.equal((await jsonRequest(base, "/api/dashboard")).payload.jobs.length, 0);

    const published = await jsonRequest(base, "/api/jobs/batch", {
      method: "POST",
      body: {
        runId: staged.payload.run.id,
        expectedChecksum: staged.payload.run.requestChecksum,
        publishConfirmed: true,
      },
    });
    assert.equal(published.response.status, 200, published.payload.error);
    assert.deepEqual(published.payload.invalidate, ["jobs", "workflow"]);
    const page = await jsonRequest(base, "/api/jobs?page=1&pageSize=30&lifecycle=all");
    assert.equal(page.payload.items.length, 1);
    assert.equal(page.payload.items[0].deadline, "2026-07-31");
    assert.equal(Object.hasOwn(page.payload.items[0].sources[0], "provenance"), false);
    const cached = await jsonRequest(base, "/api/jobs?page=1&pageSize=30&lifecycle=all", {
      headers: { "if-none-match": page.response.headers.get("etag") },
    });
    assert.equal(cached.response.status, 304);
    assert.equal(cached.payload, null);
    const rowPatch = await jsonRequest(base, `/api/jobs/${page.payload.items[0].id}/state`, {
      method: "PATCH",
      body: { favorite: true },
    });
    assert.equal(rowPatch.response.status, 200);
    assert.equal(rowPatch.payload.detail.id, page.payload.items[0].id);
    assert.equal(Object.hasOwn(rowPatch.payload, "jobs"), false);
    const invalidated = await jsonRequest(base, "/api/jobs?page=1&pageSize=30&lifecycle=all", {
      headers: { "if-none-match": page.response.headers.get("etag") },
    });
    assert.equal(invalidated.response.status, 200);
    assert.equal(invalidated.payload.items[0].application.favorite, true);
    const detail = await jsonRequest(base, `/api/jobs/${page.payload.items[0].id}`);
    assert.equal(detail.payload.detail.sources[0].provenance.adapterId, "browser-neutral-adapter");
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

test("personal settings and documents can be changed after onboarding without exposing private paths", async () => {
  const directory = prepareProject();
  const port = 26000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "personal", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(child);
    const initial = await jsonRequest(base, "/api/settings");
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.payload.settings.search.targetRoles, ["Example Role"]);
    assert.equal(Object.hasOwn(initial.payload.settings.documents, "internalPath"), false);

    const filesBefore = Object.fromEntries(["profile", "search", "sources", "resume"].map((name) => {
      const file = path.join(directory, "config", `${name}.yml`);
      return [name, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
    }));
    const invalid = await jsonRequest(base, "/api/settings", { method: "PATCH", body: { search: { targetRoles: [] } } });
    assert.equal(invalid.response.status, 400);
    for (const [name, expected] of Object.entries(filesBefore)) {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, "config", `${name}.yml`))).digest("hex");
      assert.equal(actual, expected);
    }

    const settings = initial.payload.settings;
    settings.sources.items.direct.collect = true;
    settings.sources.items.wanted.collect = true;
    settings.sources.items.wanted.priority = 1;
    const saved = await jsonRequest(base, "/api/settings", {
      method: "PATCH",
      body: {
        profile: { displayName: "Synthetic User", timezone: "Asia/Seoul", regions: ["Remote"] },
        search: {
          targetRoles: ["Generic Analyst", "Generic Coordinator"], tracks: ["Primary", "Alternative"],
          includeKeywords: ["analysis"], excludeKeywords: ["unrelated"], desiredWork: ["research"], avoidedWork: ["sales calls"],
        },
        sources: settings.sources,
      },
    });
    assert.equal(saved.response.status, 200, saved.payload.error);
    assert.deepEqual(saved.payload.settings.search.targetRoles, ["Generic Analyst", "Generic Coordinator"]);
    assert.equal(saved.payload.settings.sources.items.wanted.collect, true);
    const task = await jsonRequest(base, "/api/companion/tasks", { method: "POST", body: { kind: "collect_jobs" } });
    assert.equal(task.response.status, 201);
    const requestFile = path.join(directory, task.payload.task.requestPath);
    const requestEnvelope = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    assert.deepEqual(requestEnvelope.input.search.targetRoles, ["Generic Analyst", "Generic Coordinator"]);
    assert.deepEqual(requestEnvelope.input.sources.map((item) => item.key), ["direct", "wanted"]);

    const upload = async (contents, replace = "") => {
      const form = new FormData();
      form.append("document", new Blob([contents], { type: "application/pdf" }), "synthetic-resume.pdf");
      const params = new URLSearchParams({ kind: "resume" });
      if (replace) params.set("replace", replace);
      const response = await fetch(`${base}/api/settings/documents?${params}`, { method: "POST", body: form });
      return { response, payload: await response.json() };
    };
    const first = await upload("%PDF-1.4 first synthetic resume");
    assert.equal(first.response.status, 201, first.payload.error);
    assert.equal(first.payload.documents.filter((item) => item.active).length, 1);
    assert.equal(Object.hasOwn(first.payload.documents[0], "internalPath"), false);
    const second = await upload("%PDF-1.4 replacement synthetic resume", first.payload.documentId);
    assert.equal(second.response.status, 201, second.payload.error);
    assert.equal(second.payload.replacedDocumentId, first.payload.documentId);
    assert.equal(second.payload.documents.find((item) => item.id === first.payload.documentId).active, false);
    assert.equal(second.payload.documents.find((item) => item.id === second.payload.documentId).status, "review_required");
    const documentRoot = path.join(directory, "data", "private", "documents", second.payload.documentId);
    assert.equal(fs.statSync(documentRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(documentRoot, "source.pdf")).mode & 0o777, 0o600);

    const opened = await fetch(`${base}/api/settings/documents/${second.payload.documentId}/file`);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get("cache-control"), "private, no-store");
    assert.equal(Buffer.from(await opened.arrayBuffer()).equals(Buffer.from("%PDF-1.4 replacement synthetic resume")), true);
    const archivedRoot = path.join(directory, "data", "private", "documents", first.payload.documentId);
    const purged = await jsonRequest(base, `/api/settings/documents/${first.payload.documentId}/purge`, { method: "DELETE", body: {} });
    assert.equal(purged.response.status, 200, purged.payload.error);
    assert.equal(purged.payload.documents.some((item) => item.id === first.payload.documentId), false);
    assert.equal(purged.payload.deletion.status, "deleted");
    assert.equal(fs.existsSync(archivedRoot), false);

    const analysis = await jsonRequest(base, "/api/companion/tasks", {
      method: "POST", body: { kind: "analyze_documents", documentIds: [second.payload.documentId] },
    });
    assert.equal(analysis.response.status, 201, analysis.payload.error);
    const analysisRequest = JSON.parse(fs.readFileSync(path.join(directory, analysis.payload.task.requestPath), "utf8"));
    assert.deepEqual(analysisRequest.input.documents.map((item) => item.id), [second.payload.documentId]);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
