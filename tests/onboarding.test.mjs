import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { canonicalSectionKey } from "../lib/onboarding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const method = entry.compress ? 8 : 0;
    const compressed = entry.compress ? deflateRawSync(content) : content;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes || 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function syntheticDocx(extraEntries = []) {
  return zipBuffer([
    { name: "[Content_Types].xml", content: "<Types></Types>" },
    { name: "word/document.xml", content: "<w:document><w:body><w:p>Example portfolio</w:p></w:body></w:document>" },
    ...extraEntries,
  ]);
}

function prepareProject() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-browser-"));
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

async function upload(base, kind, filename, mimeType, contents) {
  const form = new FormData();
  form.append("document", new Blob([contents], { type: mimeType }), filename);
  const response = await fetch(`${base}/api/onboarding/documents?kind=${kind}`, { method: "POST", body: form });
  return { response, payload: await response.json() };
}

test("section mapping preserves the nine compatibility fields without duplicate custom aliases", () => {
  assert.equal(canonicalSectionKey("summary", ""), "summary");
  assert.equal(canonicalSectionKey("intro", "경력 요약"), "summary");
  assert.equal(canonicalSectionKey("custom:summary", "경력 요약"), "summary");
  assert.equal(canonicalSectionKey("custom:anything", "경력 요약"), "summary");
  assert.equal(canonicalSectionKey("custom:projects", "프로젝트"), "custom:projects");
  assert.equal(canonicalSectionKey("projects", "프로젝트"), "custom:projects");
});

test("onboarding blocks unsafe documents and completes the browser workflow with generic settings", async () => {
  const directory = prepareProject();
  const port = 24000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["web-dashboard/server.mjs"], {
    cwd: directory,
    env: { ...process.env, APP_MODE: "onboarding", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(child);
    const health = await fetch(`${base}/api/health`).then((response) => response.json());
    assert.equal(health.mode, "onboarding");
    assert.equal(health.database, null);
    assert.equal(fs.existsSync(path.join(directory, "data", "job_search_operations_dev.sqlite")), false);

    const blockedJob = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobKey: "blocked" }),
    });
    assert.equal(blockedJob.status, 409);

    assert.equal((await upload(base, "resume", "not-a-pdf.pdf", "text/plain", "%PDF-fake")).response.status, 400);
    assert.equal((await upload(base, "resume", "bad-signature.pdf", "application/pdf", "not a PDF")).response.status, 400);
    const oversizedPdf = Buffer.alloc(20 * 1024 * 1024 + 1, 32);
    oversizedPdf.write("%PDF-", 0, "ascii");
    assert.equal((await upload(base, "resume", "oversized.pdf", "application/pdf", oversizedPdf)).response.status, 413);
    const traversalDocx = syntheticDocx([{ name: "../outside.txt", content: "blocked" }]);
    assert.equal((await upload(base, "portfolio", "unsafe.docx", DOCX_MIME, traversalDocx)).response.status, 400);
    const bombDocx = zipBuffer([
      { name: "[Content_Types].xml", content: "<Types></Types>" },
      { name: "word/document.xml", content: Buffer.alloc(3 * 1024 * 1024, 65), compress: true },
    ]);
    assert.equal((await upload(base, "portfolio", "bomb.docx", DOCX_MIME, bombDocx)).response.status, 400);
    const linkedDocx = syntheticDocx([{ name: "word/link.xml", content: "target", externalAttributes: (0o120777 << 16) >>> 0 }]);
    assert.equal((await upload(base, "portfolio", "linked.docx", DOCX_MIME, linkedDocx)).response.status, 400);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#onboardingProgress").innerText(), "1 / 11");
    await page.locator("#onboardingPrivacy").check();
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.getByText("기준 이력서를 등록해 주세요").waitFor();

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
    await page.locator("#resumeDocumentInput").setInputFiles({ name: "example-resume.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByText(/example-resume\.pdf/).waitFor();
    const statePath = path.join(directory, "data", "private", "onboarding", "state.json");
    const agentRequestPath = path.join(directory, "data", "private", "onboarding", "agent-request.json");
    const beforeFailedReplacement = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const originalResumeId = beforeFailedReplacement.documents.find((item) => item.kind === "resume").id;
    fs.rmSync(agentRequestPath, { force: true });
    fs.mkdirSync(agentRequestPath);
    const failedReplacement = await upload(base, "resume", "replacement-resume.pdf", "application/pdf", pdf);
    assert.equal(failedReplacement.response.ok, false);
    const afterFailedReplacement = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(afterFailedReplacement.documents.find((item) => item.kind === "resume").id, originalResumeId);
    assert.deepEqual(fs.readdirSync(path.join(directory, "data", "private", "documents")), [originalResumeId]);
    fs.rmSync(agentRequestPath, { recursive: true, force: true });
    const docx = syntheticDocx();
    await page.locator("#portfolioDocumentInput").setInputFiles({ name: "example-portfolio.docx", mimeType: DOCX_MIME, buffer: docx });
    await page.getByText(/example-portfolio\.docx/).waitFor();
    await page.getByRole("button", { name: "포트폴리오 제거" }).click();
    await page.getByText("등록된 문서 없음", { exact: true }).waitFor();
    await page.locator("#portfolioDocumentInput").setInputFiles({ name: "example-portfolio.docx", mimeType: DOCX_MIME, buffer: docx });
    await page.getByText(/example-portfolio\.docx/).waitFor();

    const onboarding = await fetch(`${base}/api/onboarding`).then((response) => response.json());
    const resumeDocumentId = onboarding.onboarding.documents.find((item) => item.kind === "resume").id;
    assert.equal(Object.hasOwn(onboarding.onboarding.documents[0], "relativePath"), false);
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    const summary = "서로 다른 요구사항을 구조화하고 실행 기준을 합의한 뒤, 결과를 문서화하여 다음 개선으로 연결한 경험을 보유하고 있습니다.";
    const analysis = {
      facts: [
        { id: "fact-school", key: "school", label: "학교", value: "Example University", sourceDocumentId: resumeDocumentId, sourceLocator: "1쪽", confidence: 98 },
        { id: "fact-interest", key: "interest", label: "관심 분야", value: "서비스 운영", sourceDocumentId: resumeDocumentId, sourceLocator: "1쪽", confidence: 90 },
        { id: "empty-template-slot", key: "", label: "", value: "" },
      ],
      evidence: [{ id: "evidence-1", title: "운영 개선", description: "업무 요청을 분류하고 검증 가능한 완료 기준을 만들었습니다.", metrics: [], skills: ["문제 구조화"], sourceRefs: [{ documentId: resumeDocumentId, locator: "1쪽" }] }],
      sections: [
        { id: "section-summary", key: "intro", label: "경력 요약", kind: "text", value: summary, sourceRefs: [{ documentId: resumeDocumentId, locator: "1쪽" }] },
        { id: "section-project", key: "projects", label: "프로젝트", kind: "text", value: "복잡한 요청을 단계별 작업으로 나누고 검증 기준과 결과를 함께 기록했습니다.", sourceRefs: [{ documentId: resumeDocumentId, locator: "1쪽" }] },
      ],
      suggested: { roles: ["Systems Analyst"], includeKeywords: ["requirements"], excludeKeywords: [], tracks: ["primary"] },
    };
    await page.locator("#analysisJson").fill(JSON.stringify(analysis));
    await page.getByRole("button", { name: "분석 결과 불러오기" }).click();
    await page.getByText(/사실 2개 · 근거 1개 · 항목 2개/).waitFor();

    const ageAnalysis = { ...analysis, facts: [{ ...analysis.facts[0], id: "age", key: "birthdate" }] };
    const ageResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(ageAnalysis),
    });
    assert.equal(ageResponse.status, 400);
    const ageLabelAnalysis = { ...analysis, facts: [{ ...analysis.facts[0], id: "age-label", key: "personal", label: "생년월일" }] };
    const ageLabelResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(ageLabelAnalysis),
    });
    assert.equal(ageLabelResponse.status, 400);
    const ageAliasAnalysis = { ...analysis, facts: [{ ...analysis.facts[0], id: "age-alias", key: "year_of_birth" }] };
    const ageAliasResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(ageAliasAnalysis),
    });
    assert.equal(ageAliasResponse.status, 400);
    const ageInSectionAnalysis = {
      ...analysis,
      sections: [{ ...analysis.sections[0], id: "age-in-section", value: "생년월일: 1996-08-27" }],
    };
    const ageInSectionResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(ageInSectionAnalysis),
    });
    assert.equal(ageInSectionResponse.status, 400);
    const birthYearExpressionAnalysis = {
      ...analysis,
      evidence: [{ ...analysis.evidence[0], id: "birth-year-expression", description: "1996년생" }],
    };
    const birthYearExpressionResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(birthYearExpressionAnalysis),
    });
    assert.equal(birthYearExpressionResponse.status, 400);
    const missingEvidenceSource = {
      ...analysis,
      evidence: [{ ...analysis.evidence[0], id: "missing-evidence-source", sourceRefs: [] }],
    };
    const missingEvidenceSourceResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(missingEvidenceSource),
    });
    assert.equal(missingEvidenceSourceResponse.status, 400);
    const missingLocator = {
      ...analysis,
      sections: [{ ...analysis.sections[0], id: "missing-locator", sourceRefs: [{ documentId: resumeDocumentId, locator: "" }] }],
    };
    const missingLocatorResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(missingLocator),
    });
    assert.equal(missingLocatorResponse.status, 400);
    const duplicateAnalysis = { ...analysis, sections: [...analysis.sections, { ...analysis.sections[0], id: "duplicate", key: "summary" }] };
    const duplicateResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(duplicateAnalysis),
    });
    assert.equal(duplicateResponse.status, 400);
    const prefixedDuplicateAnalysis = {
      ...analysis,
      sections: [...analysis.sections, { ...analysis.sections[0], id: "prefixed-duplicate", key: "custom:summary" }],
    };
    const prefixedDuplicateResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(prefixedDuplicateAnalysis),
    });
    assert.equal(prefixedDuplicateResponse.status, 400);
    const mismatchedBuiltinKind = {
      ...analysis,
      sections: [{
        ...analysis.sections[0], id: "wrong-skills-kind", key: "skills", label: "핵심 기술", kind: "text", value: "Synthetic skill",
      }],
    };
    const mismatchedBuiltinKindResponse = await fetch(`${base}/api/onboarding/analysis`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(mismatchedBuiltinKind),
    });
    assert.equal(mismatchedBuiltinKindResponse.status, 400);
    assert.match((await mismatchedBuiltinKindResponse.json()).error, /list/);

    const pendingCompletion = await fetch(`${base}/api/onboarding/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(pendingCompletion.status, 400);
    assert.match((await pendingCompletion.json()).error, /모든 분석 항목/);

    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.getByText("사용할 내용만 남겨 주세요").waitFor();
    assert.equal(
      await page.locator('[data-review-decision="true"]').evaluateAll((elements) => elements.every((element) => element.value === "pending")),
      true,
    );
    await page.locator('[data-review-decision="true"]').evaluateAll((elements) => {
      for (const element of elements) element.value = "use";
    });
    await page.locator('[data-review-type="evidence"] [data-review-decision="true"]').selectOption("edit");
    await page.locator('[data-review-type="evidence"] [data-review-value="true"]').fill("업무 요청을 분류하고 검증 가능한 완료 기준과 변경 이력을 만들었습니다.");
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    assert.equal(await page.locator("#setupCareerStage").inputValue(), "");
    await page.locator("#setupDisplayName").fill("Example User");
    await page.locator("#setupPrimaryRole").fill("Systems Analyst");
    await page.locator("#setupCareerStage").selectOption("career_change");
    await page.locator("#setupYearsExperience").fill("4");
    await page.locator("#setupTimezone").fill("America/New_York");
    await page.locator("#setupDesiredWork").fill("요구사항 분석\n업무 흐름 개선");
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.locator("#setupRegions").fill("Busan, Remote");
    await page.locator("#setupEmploymentTypes").fill("Full-time");
    await page.locator("#setupWorkModes").fill("Hybrid");
    await page.locator("#setupExperienceMinimum").fill("1");
    await page.locator("#setupExperienceMaximum").fill("6");
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.locator("#setupIncludeKeywords").fill("requirements\nworkflow");
    await page.locator("#setupTracks").fill("primary, adjacent");
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.locator('[data-source-key="direct"] [data-source-field="collect"]').check();
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.getByText(/프로젝트 · 공고별 수정 허용/).waitFor();
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    const scoringToggles = page.locator('[data-scoring-field="enabled"]');
    for (let index = 0; index < await scoringToggles.count(); index += 1) await scoringToggles.nth(index).check();
    await page.locator('[data-scoring-field="weight"]').first().fill("19");
    assert.equal(await page.locator("#scoringWeightTotal").innerText(), "활성 가중치 합계 99 / 100");
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.getByText("내 설정을 확인하고 시작합니다").waitFor();
    const invalidCompletion = await fetch(`${base}/api/onboarding/complete`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(invalidCompletion.status, 400);
    assert.equal(fs.existsSync(path.join(directory, "data", "job_search_operations_dev.sqlite")), false);
    assert.equal(fs.existsSync(path.join(directory, "config", "profile.yml")), false);
    await page.getByRole("button", { name: "이전", exact: true }).click();
    await page.locator('[data-scoring-field="weight"]').first().fill("20");
    assert.equal(await page.locator("#scoringWeightTotal").innerText(), "활성 가중치 합계 100 / 100");
    await page.getByRole("button", { name: "저장하고 다음" }).click();
    await page.getByRole("button", { name: "이 설정으로 개인 대시보드 시작" }).click();
    await page.locator(".brand-name", { hasText: "FREE AGENT" }).waitFor();
    await page.locator("#modeBadge", { hasText: "개인 모드" }).waitFor();

    const scoring = await fetch(`${base}/api/scoring-profile`).then((response) => response.json());
    assert.equal(scoring.scoringProfile.configured, true);
    assert.equal(scoring.scoringProfile.dimensions.length, 6);
    const dashboard = await fetch(`${base}/api/dashboard`).then((response) => response.json());
    assert.equal(dashboard.profile.timezone, "America/New_York");
    const dimensions = scoring.scoringProfile.dimensions.map((item, index) => ({
      id: item.id,
      score: [80, 70, 60, 90, 100, 50][index],
      reason: `${item.label} 기준의 합성 판단 이유`,
      evidenceRefs: index === 3 ? ["evidence-1"] : [],
      gaps: [],
    }));
    const imported = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobKey: "systems-analyst-example",
        companyName: "Example Organization",
        title: "Systems Analyst",
        track: "primary",
        status: "active",
        sources: [{ platform: "direct", url: "https://example.invalid/jobs/systems-analyst", status: "active" }],
        tailoringFocus: ["summary", "custom:projects"],
        scoreBreakdown: { profileChecksum: scoring.scoringProfile.checksum, dimensions },
      }),
    });
    const importedBody = await imported.json();
    assert.equal(imported.status, 201, JSON.stringify(importedBody));
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#jobRows tr[data-job-id]").first().click();
    await page.locator("#jobDetail .score-breakdown > div").first().waitFor();
    assert.equal(await page.locator("#jobDetail .score-breakdown > div").count(), 6);
    const [reviewing] = await Promise.all([
      page.waitForResponse((response) => /\/api\/jobs\/\d+\/state$/.test(response.url()) && response.request().method() === "PATCH"),
      page.locator("#jobDetail").getByRole("button", { name: "공고 검토 시작", exact: true }).click(),
    ]);
    assert.equal(reviewing.status(), 200);
    const [created] = await Promise.all([
      page.waitForResponse((response) => /\/api\/jobs\/\d+\/package$/.test(response.url()) && response.request().method() === "POST"),
      page.locator("#jobDetail").getByRole("button", { name: "공고별 작업본 만들기", exact: true }).click(),
    ]);
    assert.equal(created.status(), 201);
    await page.locator("#resumeReviewScreen").waitFor();
    await page.locator(`[data-review-job="${importedBody.jobId}"]`).click();
    await page.getByRole("button", { name: "문안 승인·PDF 생성", exact: true }).click();
    const [approved] = await Promise.all([
      page.waitForResponse((response) => /\/api\/packages\/\d+\/approve$/.test(response.url()), { timeout: 90000 }),
      page.locator("#confirmationConfirmButton").click(),
    ]);
    assert.equal(approved.status(), 200);
    await page.getByRole("button", { name: "수기 제출 준비", exact: true }).click();
    const [prepared] = await Promise.all([
      page.waitForResponse((response) => /\/api\/packages\/\d+\/prepare$/.test(response.url())),
      page.locator("#confirmationConfirmButton").click(),
    ]);
    assert.equal(prepared.status(), 200);

    const dbPath = path.join(directory, "data", "job_search_operations_dev.sqlite");
    assert.equal(fs.statSync(path.dirname(dbPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
    for (const name of ["profile", "search", "sources", "resume"]) {
      assert.equal(fs.statSync(path.join(directory, "config", `${name}.yml`)).mode & 0o777, 0o600);
    }
    const privateRoot = path.join(directory, "data", "private");
    assert.equal(fs.statSync(privateRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(privateRoot, "onboarding", "state.json")).mode & 0o777, 0o600);
    for (const id of fs.readdirSync(path.join(privateRoot, "documents"))) {
      const documentDirectory = path.join(privateRoot, "documents", id);
      assert.equal(fs.statSync(documentDirectory).mode & 0o777, 0o700);
      const sourceFile = path.join(documentDirectory, fs.readdirSync(documentDirectory)[0]);
      assert.equal(fs.statSync(sourceFile).mode & 0o777, 0o600);
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT section_key FROM resume_custom_sections ORDER BY section_key").all().map((item) => item.section_key), ["custom:projects"]);
      assert.equal(db.prepare("SELECT protected FROM profile_facts WHERE fact_key = 'school'").get().protected, 1);
      assert.equal(db.prepare("SELECT protected FROM profile_facts WHERE fact_key = 'interest'").get().protected, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_documents").get().count, 2);
      assert.equal(
        db.prepare("SELECT description FROM evidence_items WHERE id = 'evidence-1'").get().description,
        "업무 요청을 분류하고 검증 가능한 완료 기준과 변경 이력을 만들었습니다.",
      );
      assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'career_stage'").get().value, "career_change");
      assert.equal(db.prepare("SELECT total_score FROM job_scores").get().total_score, 75);
      assert.equal(db.prepare("SELECT state FROM application_packages").get().state, "submit_ready");
    } finally {
      db.close();
    }
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
