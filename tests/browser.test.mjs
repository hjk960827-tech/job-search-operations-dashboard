import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { chromium } from "playwright";
import { importJobsBatch, initializeDatabase, openDatabase } from "../lib/database.mjs";

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
    assert.equal(await page.locator("#workflowScreen").isVisible(), true);
    assert.equal(await page.locator("#workflowQueues .workflow-task").count(), 3);
    await page.locator('[data-screen="jobs"]').click();
    assert.equal(await page.getByText("지도 보기", { exact: true }).count(), 0);
    assert.equal(await page.getByText("회사 평판", { exact: true }).count(), 0);
    assert.equal(await page.getByText("최근 리뷰", { exact: true }).count(), 0);
    assert.equal(await page.locator("#jobQuickTabs .quick-tab").count() >= 4, true);
    assert.equal(await page.locator("#jobList .discovery-badge.new").count(), 1);
    assert.equal(await page.locator("#jobList .job-card").count(), 3);
    assert.match(await page.locator("#jobList .job-card").first().innerText(), /D-\d+ · 2099-12-31/);
    await page.locator("#jobSort").selectOption("deadline");
    assert.match(await page.locator("#jobList .job-card").first().innerText(), /2099-11-30/);
    await page.locator("#deadlineFilter").selectOption("none");
    assert.equal(await page.locator("#jobList .job-card").count(), 1);
    assert.match(await page.locator("#jobList .job-card").first().innerText(), /Product Designer/);
    await page.locator("#deadlineFilter").selectOption("");
    await page.locator("#jobList .job-card").first().click();
    assert.equal(await page.locator("#jobDetail button:not([disabled]):not(.detail-close-button)").count(), 0);

    await page.locator("#statusFilter").selectOption("rejected");
    assert.equal(await page.locator("#lifecycleFilter").inputValue(), "all");
    await page.locator("#lifecycleFilter").selectOption("active");
    assert.equal(await page.locator("#statusFilter").inputValue(), "");

    await page.locator('[data-screen="resume"]').click();
    assert.equal(await page.locator("#resumeForm input:not([disabled]), #resumeForm textarea:not([disabled]), #resumeForm select:not([disabled]), #resumeForm button:not([disabled])").count(), 0);
    assert.match(await page.locator("#exampleBanner").innerText(), /읽기 전용/);
    await page.locator('[data-screen="settings"]').click();
    assert.equal(await page.locator("#personalSettingsForm input:not([disabled]), #personalSettingsForm textarea:not([disabled]), #personalSettingsForm select:not([disabled]), #personalSettingsForm button:not([disabled])").count(), 0);
    await page.locator('[data-screen="companion"]').click();
    assert.equal(await page.locator("#companionScreen button:not([disabled])").count(), 0);
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

test("personal dashboard guides a new job through review, quality, approval, manual preparation, and submission", async () => {
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
    page.on("pageerror", (error) => { throw error; });
    await page.goto(base, { waitUntil: "networkidle" });

    await page.locator('[data-screen="jobs"]').click();
    assert.equal(await page.locator("#jobList .discovery-badge.new").count(), 1);
    await page.locator(".saved-filter-panel summary").click();
    await page.locator("#savedFilterName").fill("Synthetic active view");
    await page.locator("#savedFilterDefault").check();
    const filterSaved = page.waitForResponse((response) => response.url().endsWith("/api/saved-filters") && response.request().method() === "POST");
    await page.getByRole("button", { name: "저장" }).click();
    assert.equal((await filterSaved).status(), 201);
    assert.equal(await page.locator("#savedFilterSelect option").count(), 2);
    await page.locator('[data-screen="home"]').click();

    await page.locator('[data-screen="companion"]').click();
    const firstCompanion = page.waitForResponse((response) => response.url().endsWith("/api/companion/tasks") && response.request().method() === "POST");
    await page.getByRole("button", { name: "공고 수집 요청" }).click();
    assert.equal((await firstCompanion).status(), 201);
    assert.equal(await page.locator("[data-companion-task-id]").count(), 1);
    const duplicateCompanion = page.waitForResponse((response) => response.url().endsWith("/api/companion/tasks") && response.request().method() === "POST");
    await page.getByRole("button", { name: "공고 수집 요청" }).click();
    assert.equal((await duplicateCompanion).status(), 200);
    assert.equal(await page.locator("[data-companion-task-id]").count(), 1);

    await page.locator('[data-screen="resume"]').click();
    await page.locator("#resumeJobFamily").fill("Operations");
    await page.locator("#resumeJobRole").fill("Operations Specialist");
    await page.locator("#resumeCareerType").selectOption("experienced");
    await page.locator("#resumeYearsExperience").fill("3");
    await page.locator("#resumeHeadline").fill("문제를 구조화하고 실행 결과를 검증하는 지원자");
    await page.locator("#resumeSummary").fill("짧음");
    await page.locator("#resumeSkills").fill("문제 구조화\n협업과 실행 관리");
    await page.locator("#resumeHighlights").fill("여러 팀의 요구사항을 하나의 실행 목록으로 정리하고 결과를 검토했습니다.");
    await page.getByRole("button", { name: "프로젝트 추가" }).click();
    const projectCard = page.locator('[data-structured-id]').last();
    await projectCard.locator('[data-structured-field="title"]').fill("운영 절차 점검");
    await projectCard.locator('[data-structured-field="summary"]').fill("업무 인수인계 항목을 정리하고 완료 결과를 확인했습니다.");
    await projectCard.locator('[data-structured-field="highlights"]').fill("누락 항목을 다음 점검 기준에 반영했습니다.");
    await page.locator("[data-editable-section]").evaluateAll((inputs) => {
      for (const input of inputs) input.checked = false;
    });
    await page.locator('[data-editable-section="summary"]').check();
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/resume") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "이력서 기준 저장" }).click();
    assert.equal((await saved).status(), 200);
    await page.locator("#toast").waitFor({ state: "hidden" });

    await page.locator('[data-screen="home"]').click();
    assert.equal(await page.locator('[data-workflow-stage="review"]').count(), 1);
    await page.locator('[data-workflow-stage="review"] button').click();
    assert.match(page.url(), /#jobs\?job=\d+&focus=review$/);
    assert.equal(await page.getByRole("button", { name: "공고별 작업본 만들기" }).count(), 0);
    const reviewStarted = page.waitForResponse((response) => /\/api\/jobs\/\d+\/state$/.test(response.url()) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "공고 검토 시작" }).click();
    assert.equal((await reviewStarted).status(), 200);
    await page.getByRole("button", { name: "공고별 작업본 만들기" }).waitFor();
    const created = page.waitForResponse((response) => /\/api\/jobs\/\d+\/package$/.test(response.url()) && response.request().method() === "POST");
    await page.getByRole("button", { name: "공고별 작업본 만들기" }).click();
    assert.equal((await created).status(), 201);
    await page.locator("#jobDetail .package-state", { hasText: "품질 보완 필요" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "문안 승인·PDF 생성" }).count(), 0);
    assert.equal(await page.locator('[data-package-section-key]').count(), 1, await page.locator("#jobDetail").innerText());

    await page.locator('[data-package-section-key="summary"]').fill("업무 기준을 문서화하고 이해관계자와 우선순위를 합의한 뒤 실행 결과를 검토해 개선으로 연결했습니다.");
    const revised = page.waitForResponse((response) => /\/api\/packages\/\d+$/.test(response.url()) && response.request().method() === "PUT");
    await page.getByRole("button", { name: "수정 내용 저장" }).click();
    assert.equal((await revised).status(), 200);
    await page.locator("#jobDetail .package-state", { hasText: "승인 대기" }).waitFor();

    const approved = page.waitForResponse(
      (response) => /\/api\/packages\/\d+\/approve$/.test(response.url()) && response.request().method() === "POST",
      { timeout: 90000 },
    );
    await page.getByRole("button", { name: "문안 승인·PDF 생성" }).click();
    assert.equal((await approved).status(), 200);

    const prepareButton = page.getByRole("button", { name: "수기 제출 준비" });
    await prepareButton.waitFor();
    assert.equal(await prepareButton.isEnabled(), true);
    const prepared = page.waitForResponse((response) => /\/api\/packages\/\d+\/prepare$/.test(response.url()) && response.request().method() === "POST");
    await prepareButton.click();
    assert.equal((await prepared).status(), 200);
    await page.locator("#jobDetail .package-state", { hasText: "제출 준비 완료" }).waitFor();

    const submitted = page.waitForResponse((response) => /\/api\/packages\/\d+\/submitted$/.test(response.url()) && response.request().method() === "POST");
    await page.getByRole("button", { name: "제출 완료 기록" }).click();
    assert.equal((await submitted).status(), 200);
    await page.locator("#jobDetail .package-state", { hasText: "제출 완료" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "제출 완료 기록" }).count(), 0);
    const submissionBeforeOutcome = await fetch(`${base}/api/dashboard`).then((response) => response.json());
    const frozenSubmission = {
      state: submissionBeforeOutcome.jobs[0].package.state,
      checksum: submissionBeforeOutcome.jobs[0].package.checksum,
      pdfChecksum: submissionBeforeOutcome.jobs[0].package.pdf.checksum,
    };

    await page.locator(".outcome-panel .outcome-form").waitFor();
    await page.locator('.outcome-form select[name="resultType"]').selectOption("document_passed");
    await page.locator('.outcome-form input[name="summary"]').fill("합성 채용 사이트에서 다음 단계 안내를 확인했습니다.");
    const outcomeRecorded = page.waitForResponse((response) => /\/api\/jobs\/\d+\/outcomes$/.test(response.url()) && response.request().method() === "POST");
    await page.getByRole("button", { name: "결과 추가" }).click();
    assert.equal((await outcomeRecorded).status(), 201);
    await page.locator("[data-outcome-event-id]").waitFor();
    assert.equal(await page.locator("[data-outcome-event-id]").count(), 1);
    await page.locator("[data-outcome-event-id] .outcome-correction > summary").click();
    await page.locator("[data-outcome-event-id] .correction-form input[placeholder='정정 사유 · 필수']").fill("채용 사이트 상태를 다시 확인했습니다.");
    const correctionRecorded = page.waitForResponse((response) => /\/api\/jobs\/\d+\/outcomes\/\d+\/corrections$/.test(response.url()) && response.request().method() === "POST");
    await page.locator("[data-outcome-event-id] .correction-form").getByRole("button", { name: "정정 기록 추가" }).click();
    assert.equal((await correctionRecorded).status(), 201);
    await page.locator("[data-outcome-event-id]").nth(1).waitFor();
    assert.equal(await page.locator("[data-outcome-event-id]").count(), 2);
    assert.match(await page.locator("[data-outcome-event-id]").last().innerText(), /이후 정정 기록 있음/);

    await page.locator('.follow-up-form input[name="followTitle"]').fill("다음 단계 일정 확인");
    await page.locator('.follow-up-form select[name="sourceEvent"]').selectOption({ index: 1 });
    await page.locator('.follow-up-form input[name="offsetDays"]').fill("2");
    const followUpCreated = page.waitForResponse((response) => /\/api\/jobs\/\d+\/follow-ups$/.test(response.url()) && response.request().method() === "POST");
    await page.getByRole("button", { name: "후속조치 추가" }).click();
    assert.equal((await followUpCreated).status(), 201);
    await page.locator("[data-follow-up-id]").waitFor();
    assert.equal(await page.locator("[data-follow-up-id]").count(), 1);

    await page.locator('[data-screen="home"]').click();
    assert.equal(await page.locator("#workflowFollowUpCount").innerText(), "1");
    assert.equal(await page.locator(".follow-up-workbox .workflow-task").count(), 1);
    await page.locator(".follow-up-workbox .workflow-task").getByRole("button", { name: "결과·후속조치 열기" }).click();
    await page.locator("[data-follow-up-id]").waitFor();

    await page.locator('[data-screen="inbox"]').click();
    assert.equal(await page.locator("[data-notification-id]").count(), 3);
    assert.equal(await page.locator("#inboxUnreadBadge").innerText(), "3");
    const notificationRead = page.waitForResponse((response) => /\/api\/inbox\/\d+\/read$/.test(response.url()) && response.request().method() === "POST");
    const outcomeDeepLink = page.waitForURL(/#jobs\?job=\d+&focus=outcomes$/);
    await page.locator("[data-notification-id]").first().getByRole("button", { name: "확인하고 열기" }).click();
    assert.equal((await notificationRead).status(), 200);
    await outcomeDeepLink;
    assert.match(page.url(), /#jobs\?job=\d+&focus=outcomes$/);
    await page.locator("[data-follow-up-id]").waitFor();
    const followUpCompleted = page.waitForResponse((response) => /\/api\/follow-ups\/[^/]+\/complete$/.test(response.url()) && response.request().method() === "POST");
    await page.locator("[data-follow-up-id]").getByRole("button", { name: "완료" }).click();
    assert.equal((await followUpCompleted).status(), 200);
    await page.locator("[data-follow-up-id].completed").waitFor();

    const dashboard = await fetch(`${base}/api/dashboard`).then((response) => response.json());
    assert.equal(dashboard.jobs[0].package.state, "submitted");
    assert.deepEqual({
      state: dashboard.jobs[0].package.state,
      checksum: dashboard.jobs[0].package.checksum,
      pdfChecksum: dashboard.jobs[0].package.pdf.checksum,
    }, frozenSubmission);
    assert.equal(dashboard.jobs[0].workflow.stage, "complete");
    assert.equal(dashboard.jobs[0].package.pdf.available, true);
    assert.equal(dashboard.resume.structuredItems.length, 1);
    assert.equal(dashboard.resume.structuredItems[0].kind, "project");
    assert.equal(dashboard.inbox.items.length, 3);
    const outcomes = await fetch(`${base}/api/jobs/${dashboard.jobs[0].id}/outcomes`).then((response) => response.json());
    assert.equal(outcomes.outcomes.events.length, 2);
    assert.equal(outcomes.outcomes.events.some((item) => item.correctionOfEventId), true);
    assert.equal(outcomes.outcomes.followUps[0].status, "completed");
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("personal settings screen edits generic search criteria and registers a document for reanalysis", async () => {
  const directory = preparePersonalProject();
  const port = 27000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "personal", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(child);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator('[data-screen="settings"]').click();
    await page.locator("#settingsTargetRoles").waitFor();
    await page.locator("#settingsTargetRoles").fill("Generic Researcher\nGeneric Coordinator");
    await page.locator("#settingsTracks").fill("Primary\nAlternative");
    await page.locator("#settingsRegions").fill("Remote");
    await page.locator('[data-settings-source="direct"] [data-source-field="collect"]').check();
    const settingsSaved = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "개인 설정 저장" }).click();
    assert.equal((await settingsSaved).status(), 200);
    await page.locator('[data-screen="settings"]').click();
    assert.equal(await page.locator("#settingsTargetRoles").inputValue(), "Generic Researcher\nGeneric Coordinator");

    await page.locator('[data-screen="resume"]').click();
    await page.locator("#personalDocumentFile").setInputFiles({
      name: "synthetic-resume.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 synthetic browser resume"),
    });
    const uploaded = page.waitForResponse((response) => response.url().includes("/api/settings/documents?") && response.request().method() === "POST");
    await page.getByRole("button", { name: "문서 등록" }).click();
    assert.equal((await uploaded).status(), 201);
    await page.locator('[data-analysis-document-id]').check();
    const analysisQueued = page.waitForResponse((response) => response.url().endsWith("/api/companion/tasks") && response.request().method() === "POST");
    await page.getByRole("button", { name: "선택 문서 다시 분석" }).click();
    assert.equal((await analysisQueued).status(), 201);
    assert.equal(await page.locator('[data-companion-task-id]').count(), 1);
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("large personal dashboard paginates summaries and loads only the selected job detail", async () => {
  const directory = preparePersonalProject();
  const dbPath = path.join(directory, "data", "job_search_operations_dev.sqlite");
  initializeDatabase(dbPath, { mode: "personal" });
  const db = openDatabase(dbPath);
  importJobsBatch(db, Array.from({ length: 205 }, (_, index) => ({
    jobKey: `browser-large-${String(index).padStart(3, "0")}`,
    companyName: `Example Organization ${String(index).padStart(3, "0")}`,
    title: index % 2 ? "Example Specialist" : "Example Coordinator",
    track: index % 3 ? "Operations" : "Engineering",
    status: "active",
    summary: `Synthetic job ${index}`,
    score: 100 - (index % 100),
    sources: [{ platform: "direct", url: `https://example.invalid/jobs/large-${index}`, status: "active" }],
  })));
  db.close();
  const port = 27000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "personal", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(child);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator('[data-screen="jobs"]').click();
    assert.equal(await page.locator("#jobList .job-card").count(), 30);
    assert.equal(await page.locator("#jobCount").innerText(), "205건");
    assert.equal(await page.locator("#jobPageStatus").innerText(), "1 / 7");
    const firstPageFirst = await page.locator("#jobList .job-card").first().innerText();

    const secondPage = page.waitForResponse((response) => {
      if (!response.url().includes("/api/jobs?")) return false;
      return new URL(response.url()).searchParams.get("page") === "2";
    });
    await page.getByRole("button", { name: "다음" }).click();
    assert.equal((await secondPage).status(), 200);
    await page.locator("#jobPageStatus", { hasText: "2 / 7" }).waitFor();
    assert.equal(await page.locator("#jobList .job-card").count(), 30);
    assert.notEqual(await page.locator("#jobList .job-card").first().innerText(), firstPageFirst);

    const detailResponse = page.waitForResponse((response) => /\/api\/jobs\/\d+$/.test(response.url()) && response.request().method() === "GET");
    await page.locator("#jobList .job-card").first().click();
    assert.equal((await detailResponse).status(), 200);
    await page.locator("#jobDetail .source-row").waitFor();
    assert.equal(await page.locator("#jobDetail .source-row").count(), 1);

    const lightweight = await page.evaluate(async () => {
      const response = await fetch("/api/jobs?page=1&pageSize=30&lifecycle=active");
      return response.json();
    });
    assert.equal(lightweight.items.length, 30);
    assert.equal(JSON.stringify(lightweight.items).includes("example.invalid/jobs"), false);
    assert.equal(Object.hasOwn(lightweight.items[0], "scoreBreakdown"), false);
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
