import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => fs.readFileSync(path.join(root, value), "utf8");

test("V2 parity matrix keeps the numbered inventory and explicit exclusions", () => {
  const matrix = read("docs/V2_PARITY_MATRIX.md");
  const targets = [...matrix.matchAll(/^\| (P\d{3}) \|.*$/gm)].map((match) => match[0]);
  const exclusions = [...matrix.matchAll(/^\| (X\d{3}) \|.*$/gm)].map((match) => match[0]);
  assert.equal(targets.length, 100);
  assert.deepEqual(targets.map((row) => row.match(/^\| (P\d{3})/)[1]), Array.from({ length: 100 }, (_, index) => `P${String(index + 1).padStart(3, "0")}`));
  assert.equal(exclusions.length, 14);
});

test("default V2 exposes only the agreed two-category Free Agent shell", () => {
  assert.equal(fs.existsSync(path.join(root, "web-dashboard/public/parity")), false);
  const html = read("web-dashboard/public/index.html");
  const css = read("web-dashboard/public/styles.css");
  assert.match(html, /<p class="brand-name">FREE AGENT<\/p>/);
  assert.doesNotMatch(html, /FREE ANGENT|나에게 맞는 팀을 고르는 구직 대시보드/i);
  assert.match(css, /\.brand-name\s*\{[^}]*font-size:\s*24px;[^}]*font-weight:\s*950;/s);
  assert.equal((html.match(/data-primary-nav=/g) || []).length, 2);
  assert.match(html, /data-primary-nav="jobs">구직공고 대시보드/);
  assert.match(html, /data-primary-nav="resume">이력서 관리/);
  assert.deepEqual([...html.matchAll(/data-screen="(resume-(?:create|edit|review))"/g)].slice(0, 3).map((match) => match[1]), ["resume-create", "resume-edit", "resume-review"]);
  assert.match(html, /id="editResumeDocumentList"/);
  assert.match(html, /id="editPortfolioDocumentList"/);
  assert.match(html, /resume-edit-criteria-card/);
});

test("onboarding has a dedicated Free Agent entry point and reloads into the default app", () => {
  const html = read("web-dashboard/onboarding-public/index.html");
  const script = read("web-dashboard/onboarding-public/app.js");
  assert.match(html, /<title>Free Agent — 초기 설정<\/title>/);
  assert.match(html, /<h1>FREE AGENT<\/h1>/);
  assert.match(html, /id="onboardingProgress"/);
  assert.match(script, /window\.location\.reload\(\)/);
  assert.doesNotMatch(html, /JOB SEARCH OPS|FREE ANGENT/);
});

test("resume create and edit preserve the protected dashboard structure with generic release data", () => {
  const html = read("web-dashboard/public/index.html");
  const css = read("web-dashboard/public/styles.css");
  const create = html.match(/<section id="resumeCreateScreen"[\s\S]*?<section id="resumeEditScreen"/)?.[0] || "";
  const edit = html.match(/<section id="resumeEditScreen"[\s\S]*?<section id="resumeReviewScreen"/)?.[0] || "";
  assert.equal((create.match(/class="resume-v2-panel"/g) || []).length, 3);
  for (const label of ["기본 정보 설정", "경력과 프로젝트", "기준 파일", "맞춤이력서 준비도", "현재 적용 기준 불러오기"]) assert.match(create, new RegExp(label));
  assert.equal((edit.match(/class="resume-management-card/g) || []).length, 4);
  assert.equal((edit.match(/data-resume-edit-section=/g) || []).length, 4);
  for (const label of ["등록된 이력서", "사이트 작성 이력서", "등록된 포트폴리오", "현재 적용 기준", "이력서 관리 가이드"]) assert.match(edit, new RegExp(label));
  assert.match(css, /\.resume-v2-layout\s*\{[^}]*grid-template-columns:\s*minmax\(280px, 1fr\) minmax\(340px, 1\.06fr\) minmax\(300px, 1fr\)/s);
  assert.match(css, /\.resume-v2-panel\s*\{[^}]*min-height:\s*620px;[^}]*max-height:\s*620px/s);
  assert.match(css, /\.resume-edit-grid\s*\{[^}]*minmax\(360px, 1\.18fr\)[^}]*minmax\(320px, \.98fr\)/s);
});

test("default V2 contains every contextual workflow surface and none of the agreed excluded product areas", () => {
  const html = read("web-dashboard/public/index.html");
  const script = read("web-dashboard/public/app.js");
  const combined = `${html}\n${script}`;
  for (const selector of [
    "requestJobCollectionButton", "requestDocumentAnalysisButton", "reviewCreatePackageButton",
    "packageEditFields", "outcomeLedgerArea", "outcomeCorrectionForm", "followUpForm",
    "savedFilterSelect", "structuredItemList", "customSectionList", "notificationDrawer",
  ]) assert.match(combined, new RegExp(selector));
  for (const route of [
    "/api/jobs", "/api/workflow", "/api/saved-filters", "/api/resume/structured",
    "/api/companion/tasks", "/outcomes", "/follow-ups", "/cancel-prepare", "/review",
  ]) assert.equal(script.includes(route), true, `missing ${route}`);
  for (const stage of ["검토 필요", "제출 준비", "제출완료", "지원 결과", "보관함"]) assert.equal(script.includes(stage), true, `missing review stage: ${stage}`);
  assert.equal((script.match(/review: "검토 필요"/g) || []).length, 1);
  for (const excluded of ["지도 보기", "서울 지도", "잡플래닛", "Telegram", "텔레그램", "자동 지원"]) {
    assert.equal(combined.includes(excluded), false, `excluded surface found: ${excluded}`);
  }
  assert.equal(/\/Users\/[^/]+\/(?:claude|codex)/.test(combined), false);
  assert.equal(/CRM|퍼포먼스|그로스|마케팅|인하우스|대행사/i.test(combined), false);
});

test("every static Free Agent button has a form or JavaScript interaction contract", () => {
  const html = read("web-dashboard/public/index.html");
  const script = read("web-dashboard/public/app.js");
  const declarative = /data-(?:close-modal|career-type|add-item|primary-nav|screen|quick|resume-edit-section)=/;
  for (const match of html.matchAll(/<button\b([^>]*)>/g)) {
    const attributes = match[1];
    if (/\bdisabled\b/.test(attributes) || /type="submit"/.test(attributes) || declarative.test(attributes)) continue;
    const id = attributes.match(/\bid="([^"]+)"/)?.[1];
    assert.ok(id, `button lacks an interaction identifier: ${match[0]}`);
    assert.equal(script.includes(`#${id}`), true, `button is not connected in parity JavaScript: ${id}`);
  }
});
