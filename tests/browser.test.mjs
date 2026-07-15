import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function preparePersonalProject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-browser-"));
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

test("demo dashboard loads as read-only and archived status filters remain usable", async () => {
  const port = 20000 + (process.pid % 1000);
  const dbName = `browser-test-${process.pid}.sqlite`;
  const dbPath = path.join(root, "data", dbName);
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: root,
    env: { ...process.env, APP_MODE: "demo", PORT: String(port), JOB_SEARCH_DB_PATH: `data/${dbName}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(child);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#jobList .job-card").count(), 3);
    await page.locator("#jobList .job-card").first().click();
    assert.equal(await page.locator("#jobDetail button:not([disabled])").count(), 0);

    await page.locator("#statusFilter").selectOption("rejected");
    assert.equal(await page.locator("#lifecycleFilter").inputValue(), "all");
    await page.locator("#lifecycleFilter").selectOption("active");
    assert.equal(await page.locator("#statusFilter").inputValue(), "");

    await page.locator('[data-screen="resume"]').click();
    assert.equal(await page.locator("#resumeForm input:not([disabled]), #resumeForm textarea:not([disabled]), #resumeForm select:not([disabled]), #resumeForm button:not([disabled])").count(), 0);
    assert.match(await page.locator("#exampleBanner").innerText(), /읽기 전용/);
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

test("personal dashboard enables manual submission only after resume save and PDF approval", async () => {
  const directory = preparePersonalProject();
  const port = 23000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "personal", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(child);
    const imported = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobKey: "browser-personal-role",
        companyName: "Example Company",
        title: "Example Role",
        status: "active",
        sources: [{ platform: "direct", url: "https://example.invalid/browser", status: "active" }],
      }),
    });
    assert.equal(imported.status, 201);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "networkidle" });

    await page.locator('[data-screen="resume"]').click();
    await page.locator("#resumeJobFamily").fill("Operations");
    await page.locator("#resumeJobRole").fill("Operations Specialist");
    await page.locator("#resumeCareerType").selectOption("experienced");
    await page.locator("#resumeYearsExperience").fill("3");
    await page.locator("#resumeHeadline").fill("문제를 구조화하고 실행 결과를 검증하는 지원자");
    await page.locator("#resumeSummary").fill("업무 기준을 문서화하고 이해관계자와 우선순위를 합의한 뒤 실행 결과를 검토해 개선으로 연결했습니다.");
    await page.locator("#resumeSkills").fill("문제 구조화\n협업과 실행 관리");
    await page.locator("#resumeHighlights").fill("여러 팀의 요구사항을 하나의 실행 목록으로 정리하고 결과를 검토했습니다.");
    await page.locator("[data-editable-section]").evaluateAll((inputs) => {
      for (const input of inputs) input.checked = false;
    });
    await page.locator('[data-editable-section="summary"]').check();
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/resume") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "이력서 기준 저장" }).click();
    assert.equal((await saved).status(), 200);
    await page.locator("#toast").waitFor({ state: "hidden" });

    await page.locator('[data-screen="jobs"]').click();
    await page.locator("#jobList .job-card").first().click();
    const created = page.waitForResponse((response) => /\/api\/jobs\/\d+\/package$/.test(response.url()) && response.request().method() === "POST");
    await page.getByRole("button", { name: "공고별 작업본 만들기" }).click();
    assert.equal((await created).status(), 201);
    await page.getByText("승인 대기", { exact: true }).waitFor();

    const approved = page.waitForResponse(
      (response) => /\/api\/packages\/\d+\/approve$/.test(response.url()) && response.request().method() === "POST",
      { timeout: 90000 },
    );
    await page.getByRole("button", { name: "문안 확인 후 PDF 생성·승인" }).click();
    assert.equal((await approved).status(), 200);

    const prepareButton = page.getByRole("button", { name: "수기 제출 준비" });
    await prepareButton.waitFor();
    assert.equal(await prepareButton.isEnabled(), true);
    const prepared = page.waitForResponse((response) => /\/api\/packages\/\d+\/prepare$/.test(response.url()) && response.request().method() === "POST");
    await prepareButton.click();
    assert.equal((await prepared).status(), 200);
    await page.getByText("제출 준비 완료", { exact: true }).waitFor();

    const dashboard = await fetch(`${base}/api/dashboard`).then((response) => response.json());
    assert.equal(dashboard.jobs[0].package.state, "submit_ready");
    assert.equal(dashboard.jobs[0].package.pdf.available, true);
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
