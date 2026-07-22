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

test("default Free Agent frontend keeps two primary categories and works on desktop and mobile", async () => {
  const port = 21000 + (process.pid % 1000);
  const dbName = `parity-browser-${process.pid}.sqlite`;
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
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
      assert.equal(await page.locator(".brand-name").innerText(), "FREE AGENT");
      await assert.doesNotReject(() => page.locator(".brand-name").waitFor({ state: "visible" }));
      assert.equal(await page.locator(".brand-line").getByText("나에게 맞는 팀을 고르는 구직 대시보드").count(), 0);
      assert.equal(await page.locator(".brand-name").evaluate((element) => getComputedStyle(element).fontSize), "24px");
      assert.equal(await page.locator("[data-primary-nav]").count(), 2);
      assert.deepEqual(await page.locator("[data-primary-nav]").allTextContents(), ["구직공고 대시보드", "이력서 관리"]);
      assert.match(await page.locator("#trackQuickTabs").innerText(), /주 목표 직무/);
      assert.match(await page.locator("#trackQuickTabs").innerText(), /보조 직무/);
      assert.equal(await page.locator("#jobRows tr[data-job-id]").count(), 3);
      assert.equal(await page.locator("#jobRows [data-row-favorite]:not([disabled])").count(), 0);
      assert.equal(await page.locator("thead th").count(), 12);
      assert.equal((await page.locator("body").innerText()).includes("지도 보기"), false);
      assert.equal((await page.locator("body").innerText()).includes("잡플래닛"), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.locator("#trackQuickTabs [data-quick]").first().click();
      assert.notEqual(await page.locator("#trackFilter").inputValue(), "");
      await page.locator("#resetFiltersButton").click();
      await page.locator("#advancedFilters").evaluate((element) => { element.open = true; });
      await page.locator("#statusFilter").selectOption("rejected");
      assert.equal(await page.locator("#lifecycleFilter").inputValue(), "all");
      await page.locator("#lifecycleFilter").selectOption("active");
      assert.equal(await page.locator("#statusFilter").inputValue(), "");
      assert.equal(await page.locator("#advancedFilters").getAttribute("open") !== null, true);
      assert.equal(await page.locator("#savedFilterSelect").isDisabled(), false);
      assert.equal(await page.locator("#saveCurrentFilter").isDisabled(), true);
      await page.locator("#sortFilter").selectOption("deadline");
      assert.equal(await page.locator("#jobRows tr[data-job-id]").count() > 0, true);
      const pageSizeResponse = page.waitForResponse((response) => response.url().includes("pageSize=50") && response.request().method() === "GET");
      await page.locator("#pageSizeSelect").selectOption("50");
      assert.equal((await pageSizeResponse).status(), 200);
      assert.equal(await page.locator("#pageSizeSelect").inputValue(), "50");
      if (viewport.width > 760) {
        assert.equal(await page.locator("#jobDetail").isVisible(), true);
      } else {
        assert.equal(await page.locator("#jobDetail").isVisible(), false);
        await page.locator("#jobRows tr[data-job-id]").first().click();
        await page.waitForFunction(() => document.querySelector("#jobDetail")?.classList.contains("mobile-open"));
        assert.equal(await page.locator("#jobDetail").isVisible(), true);
        await page.locator("#detailCloseButton").click();
        assert.equal(await page.locator("#jobDetail").isVisible(), false);
      }
      await page.locator("#resumeManageButton").click();
      await page.locator("#resumeCreateScreenButton").click();
      assert.equal(await page.locator("#resumeCreateScreen").isVisible(), true);
      assert.equal(await page.locator("#resumeCreateScreen .resume-v2-panel").count(), 3);
      assert.deepEqual(await page.locator("#resumeCreateScreen .resume-v2-panel h2").allTextContents(), ["기본 정보 설정", "경력과 프로젝트", "기준 파일", "맞춤이력서 준비도"]);
      assert.equal(await page.locator("#resumeCreateScreen form input:not([disabled]), #resumeCreateScreen form textarea:not([disabled]), #resumeCreateScreen form select:not([disabled])").count(), 0);
      assert.match(await page.locator("#resumeReadiness").innerText(), /사이트 작성 이력서 기준/);
      if (viewport.width > 760) assert.deepEqual(await page.locator("#resumeCreateScreen .resume-v2-panel").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height))), [620, 620, 620]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.locator("#resumeManageButton").click();
      await page.locator("#resumeEditScreenButton").click();
      assert.equal(await page.locator("#resumeEditScreen").isVisible(), true);
      assert.equal(await page.locator("#resumeEditScreen .resume-management-card").count(), 4);
      assert.equal(await page.locator("#resumeEditScreen [data-resume-edit-section]").count(), 4);
      assert.equal(await page.locator("#editResumeDocumentList .resume-edit-file-item").count(), 2);
      assert.equal(await page.locator("#resumeEditTextPanel").isVisible(), false);
      await page.locator('[data-resume-edit-section="profile"]').click();
      assert.equal(await page.locator("#resumeEditTextPanel").isVisible(), true);
      await page.locator("#resumeEditCancelButton").click();
      assert.equal(await page.locator("#resumeEditTextPanel").isVisible(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.locator("#resumeManageButton").click();
      await page.locator("#resumeReviewScreenButton").click();
      assert.equal(await page.locator("#resumeReviewScreen").isVisible(), true);
      await page.locator("#reviewJobList [data-review-job]").first().waitFor();
      assert.deepEqual(await page.locator("#reviewStageTabs button span").allTextContents(), ["검토 필요", "제출 준비", "제출완료", "지원 결과", "보관함"]);
      assert.equal(await page.locator("#reviewJobList [data-review-job]").count() > 0, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.locator("#settingsButton").click();
      assert.equal(await page.locator("#settingsModal").isVisible(), true);
      assert.equal(await page.locator("#settingsForm input:not([disabled]), #settingsForm textarea:not([disabled]), #settingsForm select:not([disabled])").count(), 0);
      await page.locator('#settingsModal > .modal-dialog > header [data-close-modal="settingsModal"]').click();
      await page.locator("#notificationButton").click();
      assert.equal(await page.locator("#notificationDrawer").isVisible(), true);
      await page.locator("#notificationDrawerCloseButton").click();
      const retiredParallelPath = await page.request.get(`http://127.0.0.1:${port}/parity/index.html`);
      assert.equal(retiredParallelPath.status(), 404);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

test("default Free Agent personal workflow connects review controls, submission cancellation, evidence, and inbox", async () => {
  const directory = preparePersonalProject();
  const port = 22000 + (process.pid % 1000);
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
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobKey: "parity-personal-role", companyName: "Example Organization", title: "Example Generalist", track: "Primary Track", status: "active", tailoringFocus: ["summary"], sources: [{ platform: "direct", url: "https://example.invalid/parity", status: "active" }] }),
    }).then((response) => response.json());
    await fetch(`${base}/api/resume`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobFamily: "General", jobRole: "Example Generalist", careerType: "experienced", yearsExperience: 3, headline: "문제를 구조화해 실행하는 지원자", summary: "여러 이해관계자의 요구를 정리하고 합의한 실행 기준에 따라 결과를 검토해 다음 개선으로 연결한 경험이 있습니다.", skills: ["문제 구조화", "협업"], experienceHighlights: ["요구사항을 실행 목록으로 정리하고 완료 결과를 확인했습니다."], editableSections: ["summary"] }),
    });
    const queuedJob = await fetch(`${base}/api/jobs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobKey: "parity-companion-role", companyName: "Example Cooperative", title: "Example Coordinator", track: "Secondary Track", status: "active", tailoringFocus: ["summary"], sources: [{ platform: "direct", url: "https://example.invalid/companion", status: "active" }] }),
    }).then((response) => response.json());
    await fetch(`${base}/api/jobs/${queuedJob.jobId}/state`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowStatus: "reviewing" }) });
    await fetch(`${base}/api/jobs/${imported.jobId}/state`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowStatus: "reviewing" }) });
    const created = await fetch(`${base}/api/jobs/${imported.jobId}/package`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((response) => response.json());
    assert.equal(created.package.state, "approval_pending");

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${base}/`, { waitUntil: "networkidle" });

    await page.locator("#advancedFilters").evaluate((element) => { element.open = true; });
    await page.locator("#savedFilterName").fill("Example active view");
    let savedFilterResponse = page.waitForResponse((response) => response.url().endsWith("/api/saved-filters") && response.request().method() === "POST");
    await page.locator("#saveCurrentFilter").click();
    assert.equal((await savedFilterResponse).status(), 201);
    await page.locator("#savedFilterName").fill("Example active view updated");
    savedFilterResponse = page.waitForResponse((response) => /\/api\/saved-filters\/[^/]+$/.test(response.url()) && response.request().method() === "PUT");
    await page.locator("#saveCurrentFilter").click();
    assert.equal((await savedFilterResponse).status(), 200);
    const deleteFilterResponse = page.waitForResponse((response) => /\/api\/saved-filters\/[^/]+$/.test(response.url()) && response.request().method() === "DELETE");
    await page.locator("#deleteSavedFilter").click();
    assert.equal((await deleteFilterResponse).status(), 200);
    assert.equal(await page.locator("#savedFilterSelect option").count(), 1);

    await page.locator("#settingsButton").click();
    await page.locator("#settingsDisplayName").fill("Example User Updated");
    await page.locator('#sourceSettings [data-source-key="direct"] [data-source-field="collect"]').check();
    const paritySettingsResponse = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.request().method() === "PATCH");
    await page.locator("#settingsForm button[type=submit]").click();
    assert.equal((await paritySettingsResponse).status(), 200);
    const reloadResponse = page.waitForResponse((response) => response.url().endsWith("/api/bootstrap") && response.request().method() === "GET");
    await page.locator("#reloadButton").click();
    assert.equal((await reloadResponse).status(), 200);

    const collectResponse = page.waitForResponse((response) => response.url().endsWith("/api/companion/tasks") && response.request().method() === "POST");
    await page.locator("#requestJobCollectionButton").click();
    assert.equal((await collectResponse).status(), 201);

    await page.locator(`[data-job-id="${queuedJob.jobId}"]`).click();
    await page.evaluate(() => {
      window.__openedSourceUrls = [];
      window.open = (url) => { window.__openedSourceUrls.push(String(url)); return null; };
    });
    await page.locator("#jobDetail [data-open-source]").click();
    assert.deepEqual(await page.evaluate(() => window.__openedSourceUrls), ["https://example.invalid/companion"]);
    const favoriteResponse = page.waitForResponse((response) => /\/api\/jobs\/\d+\/state$/.test(response.url()) && response.request().method() === "PATCH");
    await page.locator("#jobDetail [data-favorite-job]").click();
    assert.equal((await favoriteResponse).status(), 200);
    const generationResponse = page.waitForResponse((response) => response.url().endsWith("/api/companion/tasks") && response.request().method() === "POST");
    await page.locator("#jobDetail [data-request-package]").click();
    assert.equal((await generationResponse).status(), 201);

    await page.locator("#resumeManageButton").click();
    await page.locator("#resumeReviewScreenButton").click();
    await page.locator(`[data-review-job="${imported.jobId}"]`).click();

    await page.getByRole("button", { name: "수정 전/후 비교", exact: true }).click();
    assert.equal(await page.locator("#comparisonModal").isVisible(), true);
    await page.locator('#comparisonModal [data-close-modal="comparisonModal"]').last().click();

    let responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/review$/.test(response.url()) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "보완 요청", exact: true }).click();
    assert.equal((await responsePromise).status(), 200);
    await page.getByRole("button", { name: "직접 수정", exact: true }).click();
    const editableSection = page.locator("#packageEditFields [data-package-edit-key]").first();
    await editableSection.fill(`${await editableSection.inputValue()}\n합성 검토 내용을 반영했습니다.`);
    const packageEditResponse = page.waitForResponse((response) => /\/api\/packages\/\d+$/.test(response.url()) && response.request().method() === "PUT");
    await page.locator("#packageEditForm button[type=submit]").click();
    assert.equal((await packageEditResponse).status(), 200);

    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/review$/.test(response.url()) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "보류", exact: true }).click();
    assert.equal((await responsePromise).status(), 200);
    await page.getByRole("button", { name: "보류 해제", exact: true }).waitFor();
    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/review$/.test(response.url()) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "보류 해제", exact: true }).click();
    assert.equal((await responsePromise).status(), 200);

    await page.getByRole("button", { name: "문안 승인·PDF 생성", exact: true }).click();
    assert.equal(await page.locator("#confirmationModal").isVisible(), true);
    await page.locator("#confirmationCancelButton").click();
    assert.equal(await page.locator("#confirmationModal").isVisible(), false);
    assert.equal(await page.getByRole("button", { name: "문안 승인·PDF 생성", exact: true }).count(), 1);
    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/approve$/.test(response.url()), { timeout: 90000 });
    await page.getByRole("button", { name: "문안 승인·PDF 생성", exact: true }).click();
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await responsePromise).status(), 200);
    await page.getByRole("button", { name: "수기 제출 준비", exact: true }).waitFor();

    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/review$/.test(response.url()) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "승인 취소", exact: true }).click();
    assert.equal((await responsePromise).status(), 200);
    await page.getByRole("button", { name: "문안 승인·PDF 생성", exact: true }).waitFor();
    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/approve$/.test(response.url()), { timeout: 90000 });
    await page.getByRole("button", { name: "문안 승인·PDF 생성", exact: true }).click();
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await responsePromise).status(), 200);
    await page.getByRole("button", { name: "수기 제출 준비", exact: true }).waitFor();

    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/prepare$/.test(response.url()));
    await page.getByRole("button", { name: "수기 제출 준비", exact: true }).click();
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await responsePromise).status(), 200);
    await page.getByRole("button", { name: "제출 준비 취소", exact: true }).waitFor();

    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/cancel-prepare$/.test(response.url()));
    await page.getByRole("button", { name: "제출 준비 취소", exact: true }).click();
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await responsePromise).status(), 200);
    await page.getByRole("button", { name: "수기 제출 준비", exact: true }).waitFor();

    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/prepare$/.test(response.url()));
    await page.getByRole("button", { name: "수기 제출 준비", exact: true }).click();
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await responsePromise).status(), 200);
    responsePromise = page.waitForResponse((response) => /\/api\/packages\/\d+\/submitted$/.test(response.url()));
    await page.getByRole("button", { name: "제출 완료 기록", exact: true }).click();
    await page.locator("#confirmationCheck").check();
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await responsePromise).status(), 200);

    await page.getByRole("button", { name: "지원 결과 기록", exact: true }).click();
    await page.locator("#outcomeType").selectOption("document_passed");
    await page.locator("#outcomeNote").fill("합성 채용 페이지에서 다음 단계 안내를 확인했습니다.");
    await page.locator("#outcomeEvidence").setInputFiles({ name: "result.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) });
    const outcomeResponse = page.waitForResponse((response) => /\/api\/jobs\/\d+\/outcomes$/.test(response.url()));
    const evidenceResponse = page.waitForResponse((response) => /\/api\/outcomes\/\d+\/evidence$/.test(response.url()) && response.request().method() === "POST");
    await page.locator("#outcomeForm button[type=submit]").click();
    assert.equal((await outcomeResponse).status(), 201);
    assert.equal((await evidenceResponse).status(), 201);
    await page.locator("#outcomeLedgerArea [data-correct-outcome]").first().waitFor();
    await page.locator("#outcomeLedgerArea [data-correct-outcome]").first().click();
    await page.locator("#outcomeCorrectionType").selectOption("interview_scheduled");
    await page.locator("#outcomeCorrectionReason").fill("합성 결과 상태를 다시 확인했습니다.");
    await page.locator("#outcomeCorrectionSummary").fill("합성 면접 일정으로 상태를 바로잡았습니다.");
    const correctionResponse = page.waitForResponse((response) => /\/api\/jobs\/\d+\/outcomes\/\d+\/corrections$/.test(response.url()));
    await page.locator("#outcomeCorrectionForm button[type=submit]").click();
    assert.equal((await correctionResponse).status(), 201);
    await page.getByText(/교정 이유:/).waitFor();
    assert.match(await page.locator("#outcomeLedgerArea").innerText(), /교정 이유/);

    await page.locator("#outcomeLedgerArea [data-add-follow-up]").click();
    await page.locator("#followUpName").fill("합성 면접 준비 확인");
    const followUpResponse = page.waitForResponse((response) => /\/api\/jobs\/\d+\/follow-ups$/.test(response.url()));
    await page.locator("#followUpForm button[type=submit]").click();
    assert.equal((await followUpResponse).status(), 201);
    await page.locator('#outcomeLedgerArea [data-follow-up-action="complete"]').waitFor();
    const completeResponse = page.waitForResponse((response) => /\/api\/follow-ups\/[^/]+\/complete$/.test(response.url()));
    await page.locator('#outcomeLedgerArea [data-follow-up-action="complete"]').click();
    assert.equal((await completeResponse).status(), 200);
    assert.match(await page.locator("#outcomeLedgerArea").innerText(), /완료/);
    await page.locator("#outcomeLedgerArea [data-add-follow-up]").click();
    await page.locator("#followUpName").fill("합성 결과 확인 취소 테스트");
    const cancelFollowUpCreate = page.waitForResponse((response) => /\/api\/jobs\/\d+\/follow-ups$/.test(response.url()));
    await page.locator("#followUpForm button[type=submit]").click();
    assert.equal((await cancelFollowUpCreate).status(), 201);
    const cancelFollowUpResponse = page.waitForResponse((response) => /\/api\/follow-ups\/[^/]+\/cancel$/.test(response.url()));
    await page.locator('#outcomeLedgerArea [data-follow-up-action="cancel"]').click();
    assert.equal((await cancelFollowUpResponse).status(), 200);
    assert.match(await page.locator("#outcomeLedgerArea").innerText(), /취소/);

    await page.locator("#resumeManageButton").click();
    await page.locator("#resumeCreateScreenButton").click();
    await page.locator('[data-career-type="career_change"]').click();
    assert.equal(await page.locator('[data-career-type="career_change"]').getAttribute("class").then((value) => value.includes("active")), true);
    await page.locator("#resumeSkillInput").fill("Example Skill");
    await page.locator("#resumeSkillAddButton").click();
    assert.equal(await page.locator('[data-remove-resume-chip="skill"][data-value="Example Skill"]').count(), 1);
    await page.locator('[data-remove-resume-chip="skill"][data-value="Example Skill"]').click();
    assert.equal(await page.locator('[data-remove-resume-chip="skill"][data-value="Example Skill"]').count(), 0);
    await page.locator("#supplementOpenButton").click();
    assert.equal(await page.locator("#supplementModal").isVisible(), true);
    await page.locator('#supplementModal [data-close-modal="supplementModal"]').last().click();
    assert.equal(await page.locator("#supplementModal").isVisible(), false);
    await page.locator('[data-add-item="experience"]').click();
    await page.locator("#structuredItemKind").selectOption("project");
    await page.locator("#structuredItemLabel").fill("합성 운영 개선 프로젝트");
    await page.locator("#structuredItemOrganization").fill("Example Organization");
    await page.locator("#structuredItemRole").fill("Coordinator");
    await page.locator("#structuredItemEngagement").fill("개인 프로젝트");
    await page.locator("#structuredItemStartDate").fill("2025-01");
    await page.locator("#structuredItemEndDate").fill("2025-06");
    await page.locator("#structuredItemSummary").fill("합성 데이터로 검수 절차를 정리했습니다.");
    await page.locator("#structuredItemSkills").fill("문제 구조화\n품질 점검");
    await page.locator("#structuredItemLinks").fill("https://example.invalid/project");
    const structuredResponse = page.waitForResponse((response) => response.url().endsWith("/api/resume/structured") && response.request().method() === "PUT");
    await page.locator("#structuredItemForm button[type=submit]").click();
    assert.equal((await structuredResponse).status(), 200);
    assert.match(await page.locator("#structuredItemList").innerText(), /합성 운영 개선 프로젝트/);
    const syntheticPdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
    let documentResponse = page.waitForResponse((response) => response.url().includes("/api/settings/documents?") && response.request().method() === "POST");
    await page.locator("#resumeDocumentFile").setInputFiles({ name: "example-resume.pdf", mimeType: "application/pdf", buffer: syntheticPdf });
    assert.equal((await documentResponse).status(), 201);
    const originalDocumentId = await page.locator("#resumeDocumentReplace option").nth(1).getAttribute("value");
    await page.locator("#resumeDocumentReplace").selectOption(originalDocumentId);
    documentResponse = page.waitForResponse((response) => response.url().includes("/api/settings/documents?") && response.request().method() === "POST");
    await page.locator("#resumeDocumentFile").setInputFiles({ name: "example-resume-updated.pdf", mimeType: "application/pdf", buffer: Buffer.concat([syntheticPdf, Buffer.from("updated")]) });
    assert.equal((await documentResponse).status(), 201);
    const analysisResponse = page.waitForResponse((response) => response.url().endsWith("/api/companion/tasks") && response.request().method() === "POST");
    await page.locator("#requestDocumentAnalysisButton").click();
    assert.equal((await analysisResponse).status(), 201);

    await page.locator("#customSectionAddButton").click();
    await page.locator("#customSectionLabel").fill("Example Community Work");
    await page.locator("#customSectionValue").fill("합성 커뮤니티 운영 사례");
    const customResponse = page.waitForResponse((response) => response.url().endsWith("/api/resume") && response.request().method() === "PUT");
    await page.locator("#customSectionForm button[type=submit]").click();
    assert.equal((await customResponse).status(), 200);
    assert.match(await page.locator("#customSectionList").innerText(), /Example Community Work/);
    await page.locator("#customSectionList [data-edit-custom]").click();
    await page.locator("#customSectionValue").fill("수정된 합성 커뮤니티 운영 사례");
    const customEditResponse = page.waitForResponse((response) => response.url().endsWith("/api/resume") && response.request().method() === "PUT");
    await page.locator("#customSectionForm button[type=submit]").click();
    assert.equal((await customEditResponse).status(), 200);
    assert.match(await page.locator("#customSectionList").innerText(), /수정된 합성/);
    const customDeleteResponse = page.waitForResponse((response) => response.url().endsWith("/api/resume") && response.request().method() === "PUT");
    await page.locator("#customSectionList [data-delete-custom]").click();
    assert.equal((await customDeleteResponse).status(), 200);
    assert.equal(await page.locator("#customSectionList [data-edit-custom]").count(), 0);
    const archiveButton = page.locator("#resumeDocumentList [data-archive-document]").first();
    const archiveId = await archiveButton.getAttribute("data-archive-document");
    await archiveButton.click();
    const archiveResponse = page.waitForResponse((response) => response.url().endsWith(`/api/settings/documents/${archiveId}`) && response.request().method() === "DELETE");
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await archiveResponse).status(), 200);
    await page.locator("#resumeManageButton").click();
    await page.locator("#resumeEditScreenButton").click();
    assert.equal(await page.locator("#editStructuredSummary").isVisible(), true);
    const purgeButton = page.locator(`#editResumeDocumentList [data-delete-document="${archiveId}"]`);
    await purgeButton.click();
    await page.locator("#confirmationCheck").check();
    const purgeResponse = page.waitForResponse((response) => response.url().endsWith(`/api/settings/documents/${archiveId}/purge`) && response.request().method() === "DELETE");
    await page.locator("#confirmationConfirmButton").click();
    assert.equal((await purgeResponse).status(), 200);
    assert.equal(await page.locator(`#editResumeDocumentList [data-delete-document="${archiveId}"]`).count(), 0);

    await page.locator("#notificationBadge").waitFor({ state: "visible" });
    await page.locator("#notificationButton").click();
    responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/inbox/read-all"));
    await page.locator("#notificationMarkAllButton").click();
    assert.equal((await responsePromise).status(), 200);
    assert.equal(await page.locator("#notificationBadge").isVisible(), false);
    await page.locator("#notificationOpenAllButton").click();
    assert.equal(await page.locator("#notificationModal").isVisible(), true);
    await page.locator('#notificationModal button[data-close-modal="notificationModal"]').click();
    assert.equal(await page.locator("#notificationModal").isVisible(), false);
    assert.deepEqual(errors, []);
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
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#jobRows tr[data-job-id]").count(), 20);
    assert.match(await page.locator("#resultTitle").innerText(), /205개/);
    let parityPageResponse = page.waitForResponse((response) => response.url().includes("/api/jobs?") && new URL(response.url()).searchParams.get("page") === "2");
    await page.locator("#pageNextButton").click();
    assert.equal((await parityPageResponse).status(), 200);
    await page.locator('#pageButtons [data-page="2"].active').waitFor();
    parityPageResponse = page.waitForResponse((response) => response.url().includes("/api/jobs?") && new URL(response.url()).searchParams.get("page") === "1");
    await page.locator("#pagePrevButton").click();
    assert.equal((await parityPageResponse).status(), 200);
    await page.locator('#pageButtons [data-page="1"].active').waitFor();
    parityPageResponse = page.waitForResponse((response) => response.url().includes("/api/jobs?") && new URL(response.url()).searchParams.get("page") === "11");
    await page.locator("#pageLastButton").click();
    assert.equal((await parityPageResponse).status(), 200);
    await page.locator('#pageButtons [data-page="11"].active').waitFor();
    assert.equal(await page.locator("#jobRows tr[data-job-id]").count(), 5);
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
