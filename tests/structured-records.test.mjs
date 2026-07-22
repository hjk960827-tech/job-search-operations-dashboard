import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getResume,
  importJob,
  initializeDatabase,
  openDatabase,
  saveResume,
} from "../lib/database.mjs";
import {
  createPackage,
  renderPackageHtml,
  renderPackageMarkdown,
} from "../lib/package-workflow.mjs";
import {
  getStructuredResumeItems,
  saveStructuredResumeItems,
  updateResumeAsset,
} from "../lib/structured-records.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "generic-resume-"));
  const dbPath = path.join(directory, "personal.sqlite");
  initializeDatabase(dbPath, { mode: "personal" });
  return { directory, db: openDatabase(dbPath) };
}

function cleanup(value, packageValue) {
  value.db.close();
  if (packageValue?.artifacts?.directory) {
    fs.rmSync(path.dirname(path.dirname(packageValue.artifacts.directory)), { recursive: true, force: true });
  }
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function genericItems() {
  return [
    {
      id: "experience-1", kind: "experience", title: "현장 운영 담당", organization: "Example Facility",
      role: "Coordinator", startDate: "2021-03", endDate: "present",
      summary: "작업 요청과 안전 확인 절차를 기록하고 완료 결과를 점검했습니다.",
      highlights: ["교대 인수인계 항목을 표준화했습니다."], skills: ["운영 기록"], sourceRefs: [], active: true,
    },
    {
      id: "education-1", kind: "education", title: "응용과학 학위", organization: "Example Institute",
      role: "Applied Science", startDate: "2017", endDate: "2021", summary: "실험 설계와 데이터 해석을 학습했습니다.",
      highlights: [], skills: [], sourceRefs: [], active: true,
    },
    {
      id: "skill-1", kind: "skill", title: "품질 점검", organization: "", role: "", startDate: "", endDate: "",
      summary: "", highlights: [], skills: [], sourceRefs: [], active: true,
    },
    {
      id: "certification-1", kind: "certification", title: "Example Safety Certificate", organization: "Example Board",
      role: "", startDate: "2024", endDate: "", summary: "", highlights: [], skills: [], sourceRefs: [], active: true,
    },
    {
      id: "project-1", kind: "project", title: "검수 절차 개선", organization: "", role: "Contributor",
      engagementType: "개인 프로젝트",
      startDate: "2025-01", endDate: "2025-06", summary: "검수 누락을 찾기 위한 체크 순서를 정리했습니다.",
      highlights: ["검수 결과와 수정 이력을 함께 남겼습니다."], skills: ["문제 구조화"],
      portfolioLinks: ["https://example.invalid/project"], sourceRefs: [], active: true,
    },
  ];
}

test("structured resume management preserves exactly what a non-marketing user entered", () => {
  const value = fixture();
  try {
    const input = genericItems();
    const stored = saveStructuredResumeItems(value.db, input);
    assert.equal(stored.length, 5);
    assert.deepEqual(stored.map((item) => item.kind), ["certification", "education", "experience", "project", "skill"]);
    assert.deepEqual(
      new Set(stored.map((item) => item.title)),
      new Set(input.map((item) => item.title)),
    );
    assert.equal(JSON.stringify(stored).includes("marketing"), false);
    assert.equal(JSON.stringify(stored).includes("CRM"), false);
    assert.equal(stored.some((item) => !input.some((source) => source.id === item.id)), false);
    const project = stored.find((item) => item.id === "project-1");
    assert.equal(project.engagementType, "개인 프로젝트");
    assert.deepEqual(project.portfolioLinks, ["https://example.invalid/project"]);
  } finally { cleanup(value); }
});

test("structured resume rejects semantic duplicates, unknown sources, and invalid dates before writing", () => {
  const value = fixture();
  try {
    const before = getStructuredResumeItems(value.db);
    assert.throws(() => saveStructuredResumeItems(value.db, [
      { id: "first", kind: "skill", title: "Data Review" },
      { id: "second", kind: "skill", title: "data-review" },
    ]), /Duplicate structured item meaning/);
    assert.throws(() => saveStructuredResumeItems(value.db, [
      { id: "dated", kind: "experience", title: "Role", startDate: "2026-12", endDate: "2026-01" },
    ]), /startDate cannot be after endDate/);
    assert.throws(() => saveStructuredResumeItems(value.db, [
      { id: "source", kind: "project", title: "Project", sourceRefs: [{ documentId: "missing", locator: "page 1" }] },
    ]), /Unknown active source document/);
    assert.deepEqual(getStructuredResumeItems(value.db), before);
  } finally { cleanup(value); }
});

test("combined resume save rolls back profile and structured items as one unit", () => {
  const value = fixture();
  try {
    saveResume(value.db, {
      jobRole: "Original role", careerStage: "entry", headline: "Original headline",
      structuredItems: [{ id: "original-item", kind: "skill", title: "Original skill" }],
    });
    const before = getResume(value.db);
    value.db.exec(`
      CREATE TRIGGER reject_atomic_resume_item
      BEFORE INSERT ON resume_structured_items
      WHEN NEW.id = 'force-write-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced structured write failure');
      END;
    `);
    assert.throws(() => saveResume(value.db, {
      jobRole: "Changed role", careerStage: "entry", headline: "Changed headline",
      structuredItems: [{ id: "force-write-failure", kind: "skill", title: "Changed skill" }],
    }), /forced structured write failure/);
    const after = getResume(value.db);
    assert.equal(after.jobRole, before.jobRole);
    assert.equal(after.headline, before.headline);
    assert.deepEqual(after.structuredItems, before.structuredItems);
  } finally { cleanup(value); }
});

test("resume assets expose active, review, and archive states without losing the source record", () => {
  const value = fixture();
  try {
    value.db.prepare(`
      INSERT INTO source_documents (id, kind, original_name, mime_type, size_bytes, sha256)
      VALUES ('resume-asset', 'resume', 'example.pdf', 'application/pdf', 1200, 'synthetic-checksum')
    `).run();
    let resume = getResume(value.db);
    assert.equal(resume.assets[0].status, "active");
    assert.equal(resume.readiness.ready, false);
    updateResumeAsset(value.db, "resume-asset", { status: "review_required", label: "기준 이력서" });
    resume = getResume(value.db);
    assert.equal(resume.assets[0].status, "review_required");
    updateResumeAsset(value.db, "resume-asset", { status: "archived", label: "기준 이력서" });
    assert.equal(value.db.prepare("SELECT active FROM source_documents WHERE id = 'resume-asset'").get().active, 0);
    assert.equal(getResume(value.db).assets[0].status, "archived");
  } finally { cleanup(value); }
});

test("final artifacts include selected contact and structured sections but never invent an unselected contact", () => {
  const value = fixture();
  let packageValue;
  try {
    saveStructuredResumeItems(value.db, genericItems());
    saveResume(value.db, {
      jobFamily: "Operations", jobRole: "Field Coordinator", careerType: "experienced", careerStage: "experienced", yearsExperience: 4,
      school: "Compatibility School", major: "Compatibility Major", certificates: ["Compatibility Certificate"],
      headline: "현장 정보와 실행 기준을 연결하는 운영 담당자",
      summary: "현장 요청을 구조화하고 작업 기준을 문서화한 뒤 완료 결과를 검토하는 업무 경험을 갖고 있습니다.",
      skills: ["운영 기록", "품질 점검"],
      experienceHighlights: ["업무 인수인계와 검수 항목을 정리해 작업 누락을 줄이는 기준을 만들었습니다."],
      editableSections: ["headline", "summary", "skills", "experience_highlights"],
    });
    const jobId = importJob(value.db, {
      jobKey: "field-coordinator", companyName: "Example Organization", title: "Field Coordinator", status: "active",
      tailoringFocus: ["headline", "summary", "skills", "experience_highlights"],
      sources: [{ platform: "direct", url: "https://example.invalid/field", status: "active" }],
    });
    packageValue = createPackage(value.db, jobId, {
      contact: [{ key: "email", label: "이메일", value: ["candidate", "example.invalid"].join("@") }],
    });
    const html = renderPackageHtml(packageValue.content, { companyName: "Example Organization", title: "Field Coordinator" });
    const markdown = renderPackageMarkdown(packageValue.content, { companyName: "Example Organization", title: "Field Coordinator" });
    assert.match(html, new RegExp(["candidate", "example\\.invalid"].join("@")));
    assert.doesNotMatch(html, /전화번호|주소/);
    for (const label of ["경력", "학력", "기술", "자격·인증", "프로젝트"]) assert.match(markdown, new RegExp(`## ${label}`));
    assert.doesNotMatch(markdown, /Compatibility School|Compatibility Major|Compatibility Certificate/);
    assert.equal(packageValue.content.structuredItems.length, 5);
    assert.equal(packageValue.content.contacts.length, 1);
    assert.equal(packageValue.quality.status, "passed");
  } finally { cleanup(value, packageValue); }
});

test("resume readiness lists missing user inputs and becomes ready only from entered data", () => {
  const value = fixture();
  try {
    assert.deepEqual(getResume(value.db).readiness.missing.map((item) => item.key), [
      "resume_asset", "target_role", "summary", "skills", "experience",
    ]);
    saveStructuredResumeItems(value.db, [
      { id: "skill", kind: "skill", title: "Scheduling" },
      { id: "project", kind: "project", title: "Roster review", summary: "Reviewed shift coverage." },
    ]);
    saveResume(value.db, {
      jobRole: "Schedule Coordinator", careerType: "new", careerStage: "entry",
      headline: "Coordinates schedules with documented constraints", summary: "Uses confirmed availability and operating constraints.",
      skills: [], experienceHighlights: [], certificates: [], editableSections: ["headline", "summary"],
    });
    const readiness = getResume(value.db).readiness;
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.missing, []);
  } finally { cleanup(value); }
});
