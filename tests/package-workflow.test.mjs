import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  importJob,
  initializeDatabase,
  openDatabase,
  saveResume,
} from "../lib/database.mjs";
import {
  approvePackage,
  buildPackageContent,
  createPackage,
  evaluatePackageQuality,
  prepareSubmission,
  recordSubmitted,
  updatePackage,
} from "../lib/package-workflow.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "job-search-package-"));
  const file = path.join(directory, "test.sqlite");
  initializeDatabase(file, { mode: "personal" });
  const db = openDatabase(file);
  const jobId = importJob(db, {
    jobKey: `package-${path.basename(directory)}`,
    companyName: "Example Company",
    title: "Example Role",
    status: "active",
    tailoringFocus: ["headline", "summary", "skills", "experience_highlights", "career_direction"],
    applicationQuestions: [{ id: "role-fit", label: "이 역할에 기여할 방식을 설명해 주세요.", required: true }],
    sources: [{ platform: "direct", url: "https://example.invalid/role", status: "active", confidence: 100 }],
  });
  saveResume(db, {
    jobFamily: "Operations",
    jobRole: "Operations Specialist",
    careerType: "experienced",
    yearsExperience: 4,
    school: "Example University",
    major: "Interdisciplinary Studies",
    headline: "문제를 구조화하고 실행을 연결하는 지원자",
    summary: "여러 이해관계자의 요구를 정리하고 우선순위를 합의한 뒤 실행 결과를 검토해 다음 개선으로 연결한 경험을 갖고 있습니다. 사실과 근거가 확인된 내용만 문서에 사용합니다.",
    skills: ["문제 구조화", "협업과 실행 관리"],
    experienceHighlights: [
      "복수 팀의 요구사항을 하나의 실행 목록으로 정리하고 담당자와 일정을 명확히 했습니다.",
      "완료 결과를 기준과 대조해 누락 항목을 찾고 다음 반복 작업에 반영했습니다.",
    ],
    certificates: ["Example Certificate"],
    careerDirection: "사용자와 팀이 같은 기준으로 판단할 수 있도록 문제와 실행 과정을 문서화합니다.",
    editableSections: ["headline", "summary", "skills", "experience_highlights", "career_direction"],
  });
  return {
    db,
    jobId,
    directory,
    cleanup(packageValue) {
      db.close();
      if (packageValue?.artifacts?.directory) {
        const instanceRoot = path.dirname(path.dirname(packageValue.artifacts.directory));
        fs.rmSync(instanceRoot, { recursive: true, force: true });
      }
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function completeSections(packageValue, overrides = {}) {
  return packageValue.content.sections.map((section) => ({
    key: section.key,
    value: Object.hasOwn(overrides, section.key)
      ? overrides[section.key]
      : section.source === "application_question"
        ? "현재 업무 흐름과 성공 기준을 먼저 확인하고, 작은 개선안을 실행해 결과를 검토한 뒤 다음 우선순위를 팀과 합의하겠습니다."
        : section.value,
  }));
}

function fakePdf(pages) {
  return async (_htmlPath, outputPath) => {
    const pageObjects = Array.from({ length: pages }, (_, index) => `${index + 1} 0 obj\n<< /Type /Page >>\nendobj`).join("\n");
    fs.writeFileSync(outputPath, `%PDF-1.7\n${pageObjects}\n%%EOF\n`);
  };
}

test("package edits persist artifacts, create revisions, and reject stale checksums", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    assert.equal(packageValue.state, "quality_hold");
    assert.equal(packageValue.quality.score, 79);
    const updated = updatePackage(value.db, packageValue.id, { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum });
    assert.equal(updated.state, "approval_pending");
    assert.equal(updated.quality.status, "passed");
    assert.equal(fs.existsSync(updated.artifacts.htmlPath), true);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_revisions WHERE package_id = ?").get(packageValue.id).count, 1);
    assert.throws(
      () => updatePackage(value.db, packageValue.id, { sections: completeSections(updated), expectedChecksum: packageValue.checksum }),
      /changed in another session/,
    );
  } finally {
    value.cleanup(packageValue);
  }
});

test("database failure restores files and removes incomplete revision snapshot", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    const before = fs.readFileSync(packageValue.artifacts.markdownPath, "utf8");
    assert.throws(() => updatePackage(
      value.db,
      packageValue.id,
      { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum },
      { beforeCommit: () => { throw new Error("forced database failure"); } },
    ), /forced database failure/);
    assert.equal(fs.readFileSync(packageValue.artifacts.markdownPath, "utf8"), before);
    assert.equal(value.db.prepare("SELECT content_checksum FROM application_packages WHERE id = ?").get(packageValue.id).content_checksum, packageValue.checksum);
    assert.equal(fs.existsSync(path.join(packageValue.artifacts.directory, ".revisions", "revision-1")), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("approval rejects four pages, accepts three pages, and rolls back on database failure", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let updated = updatePackage(value.db, packageValue.id, { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum });
    await assert.rejects(() => approvePackage(value.db, updated.id, { renderer: fakePdf(4) }), /must contain 1-3 pages/);
    assert.equal(fs.existsSync(path.join(updated.artifacts.directory, "resume.pdf")), false);
    await assert.rejects(() => approvePackage(value.db, updated.id, {
      renderer: fakePdf(3),
      beforeCommit: () => { throw new Error("forced approval failure"); },
    }), /forced approval failure/);
    assert.equal(fs.existsSync(path.join(updated.artifacts.directory, "resume.pdf")), false);
    updated = await approvePackage(value.db, updated.id, { renderer: fakePdf(3) });
    assert.equal(updated.state, "approved");
    assert.equal(updated.artifacts.pdfPages, 3);
  } finally {
    value.cleanup(packageValue);
  }
});

test("editing an approved package archives its PDF and invalidates approval", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let updated = updatePackage(value.db, packageValue.id, { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum });
    updated = await approvePackage(value.db, updated.id, { renderer: fakePdf(1) });
    const previousPdf = updated.artifacts.pdfPath;
    const revisedDirection = `${updated.content.sections.find((section) => section.key === "career_direction").value}\n\n검토 결과를 문서로 남겨 팀이 같은 기준을 사용하도록 하겠습니다.`;
    updated = updatePackage(value.db, updated.id, {
      sections: completeSections(updated, { career_direction: revisedDirection }),
      expectedChecksum: updated.checksum,
    });
    assert.equal(updated.state, "approval_pending");
    assert.equal(updated.approvedChecksum, "");
    assert.equal(fs.existsSync(previousPdf), false);
    assert.equal(fs.existsSync(path.join(updated.artifacts.directory, ".revisions", "revision-2", "resume.pdf")), true);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_approvals WHERE package_id = ? AND action = 'invalidated'").get(updated.id).count, 1);
  } finally {
    value.cleanup(packageValue);
  }
});

test("submission freezes a verified PDF and blocks later package edits", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let updated = updatePackage(value.db, packageValue.id, { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum });
    updated = await approvePackage(value.db, updated.id, { renderer: fakePdf(1) });
    assert.equal(updated.approvedChecksum, updated.checksum);
    assert.equal(Boolean(updated.artifacts.pdfPath), true);
    assert.throws(() => prepareSubmission(value.db, updated.id, {
      platform: "direct",
      beforeCommit: () => { throw new Error("forced prepare failure"); },
    }), /forced prepare failure/);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_submissions WHERE package_id = ?").get(updated.id).count, 0);
    assert.equal(fs.existsSync(path.join(updated.artifacts.directory, "submissions")), false);
    updated = prepareSubmission(value.db, updated.id, { platform: "direct" });
    const submission = value.db.prepare("SELECT * FROM package_submissions WHERE package_id = ?").get(updated.id);
    assert.equal(submission.status, "submit_ready");
    assert.notEqual(submission.frozen_pdf_path, updated.artifacts.pdfPath);
    assert.equal(fs.existsSync(submission.frozen_pdf_path), true);
    assert.throws(() => updatePackage(value.db, updated.id, { sections: completeSections(updated), expectedChecksum: updated.checksum }), /cannot be edited/);
    fs.appendFileSync(updated.artifacts.pdfPath, "current file changed after freezing");
    updated = recordSubmitted(value.db, updated.id);
    assert.equal(updated.state, "submitted");
    assert.equal(value.db.prepare("SELECT workflow_status FROM application_state WHERE job_id = ?").get(value.jobId).workflow_status, "applied");
  } finally {
    value.cleanup(packageValue);
  }
});

test("stored artifact paths cannot escape the release data directory", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    value.db.prepare("UPDATE application_packages SET resume_html_path = ? WHERE id = ?").run(path.join(os.tmpdir(), "outside.html"), packageValue.id);
    assert.throws(
      () => updatePackage(value.db, packageValue.id, { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum }),
      /outside the package data directory|must stay inside/,
    );
  } finally {
    value.cleanup(packageValue);
  }
});

test("tailored fields follow each job focus and never add fixed marketing sections", () => {
  const value = fixture();
  let firstPackage;
  try {
    firstPackage = createPackage(value.db, value.jobId);
    assert.deepEqual(firstPackage.content.sections.map((section) => section.key), [
      "headline", "summary", "skills", "experience_highlights", "career_direction", "question:role-fit",
    ]);
    assert.equal(firstPackage.content.sections.some((section) => ["motivation", "plan", "growth", "viewpoint"].includes(section.key)), false);
    assert.deepEqual(firstPackage.content.protectedFacts.map((fact) => fact.key), [
      "job_family", "job_role", "career", "school", "major", "certificates",
    ]);

    const secondJobId = importJob(value.db, {
      jobKey: `second-${path.basename(value.directory)}`,
      companyName: "Second Company",
      title: "Different Role",
      status: "active",
      tailoringFocus: ["summary", "career_direction"],
      sources: [{ platform: "direct", url: "https://example.invalid/second", status: "active" }],
    });
    const secondPackage = createPackage(value.db, secondJobId);
    assert.deepEqual(secondPackage.content.sections.map((section) => section.key), ["summary", "career_direction"]);
  } finally {
    value.cleanup(firstPackage);
  }
});

test("package updates can change values only, not protected facts or section definitions", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    const protectedBefore = structuredClone(packageValue.content.protectedFacts);
    const updated = updatePackage(value.db, packageValue.id, {
      expectedChecksum: packageValue.checksum,
      protectedFacts: [{ key: "career", label: "경력 구분", value: "변조" }],
      sections: [
        { key: "summary", label: "변조된 제목", source: "application_question", value: "검증된 사실을 바탕으로 공고에 맞게 요약 내용을 조정했습니다." },
        { key: "unknown", value: "추가 시도" },
        { key: "question:role-fit", value: "업무 기준을 확인하고 작은 개선부터 검증하겠습니다." },
      ],
    });
    assert.deepEqual(updated.content.protectedFacts, protectedBefore);
    assert.equal(updated.content.sections.find((section) => section.key === "summary").label, "경력 요약");
    assert.equal(updated.content.sections.find((section) => section.key === "summary").source, "resume");
    assert.equal(updated.content.sections.some((section) => section.key === "unknown"), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("an unconfigured profile does not infer a career fact", () => {
  const content = buildPackageContent({
    career_type: "new",
    years_experience: null,
    certificates_json: "[]",
    editable_sections_json: "[]",
  });
  assert.deepEqual(content.protectedFacts, []);
  assert.deepEqual(content.sections, []);
});

test("application questions alone cannot make a resume package approvable", () => {
  const value = fixture();
  let packageValue;
  try {
    const questionOnlyJobId = importJob(value.db, {
      jobKey: `question-only-${path.basename(value.directory)}`,
      companyName: "Question Company",
      title: "Question Role",
      status: "active",
      tailoringFocus: ["achievement_evidence"],
      applicationQuestions: [{ id: "required", label: "지원 이유를 설명해 주세요.", required: true }],
      sources: [{ platform: "direct", url: "https://example.invalid/question-only", status: "active" }],
    });
    packageValue = createPackage(value.db, questionOnlyJobId);
    const updated = updatePackage(value.db, packageValue.id, {
      expectedChecksum: packageValue.checksum,
      sections: [{
        key: "question:required",
        value: "공고의 업무 기준을 확인하고 제가 검증한 경험과 연결되는 부분을 구체적으로 설명하겠습니다.",
      }],
    });
    assert.equal(updated.state, "quality_hold");
    assert.equal(updated.quality.status, "review");
    assert.equal(updated.quality.score, 0);
    assert.equal(updated.quality.findings.some((finding) => finding.key === "resume_sections"), true);
  } finally {
    value.cleanup(packageValue);
  }
});

test("one-character resume sections fail section-specific minimum quality", () => {
  const value = fixture();
  let packageValue;
  try {
    const shortJobId = importJob(value.db, {
      jobKey: `short-section-${path.basename(value.directory)}`,
      companyName: "Short Company",
      title: "Short Role",
      status: "active",
      tailoringFocus: ["summary"],
      sources: [{ platform: "direct", url: "https://example.invalid/short", status: "active" }],
    });
    packageValue = createPackage(value.db, shortJobId);
    const updated = updatePackage(value.db, packageValue.id, {
      expectedChecksum: packageValue.checksum,
      sections: [{ key: "summary", value: "가" }],
    });
    assert.equal(updated.state, "quality_hold");
    assert.equal(updated.quality.status, "review");
    assert.equal(updated.quality.findings.some((finding) => finding.key === "summary"), true);
  } finally {
    value.cleanup(packageValue);
  }
});

test("resume markdown and application answers are stored as separate artifacts", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    const updated = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue),
      expectedChecksum: packageValue.checksum,
    });
    const resumeMarkdown = fs.readFileSync(updated.artifacts.markdownPath, "utf8");
    const answersMarkdown = fs.readFileSync(updated.artifacts.applicationAnswersPath, "utf8");
    assert.doesNotMatch(resumeMarkdown, /이 역할에 기여할 방식을 설명해 주세요/);
    assert.match(answersMarkdown, /이 역할에 기여할 방식을 설명해 주세요/);
    assert.match(answersMarkdown, /현재 업무 흐름과 성공 기준/);
  } finally {
    value.cleanup(packageValue);
  }
});

test("technical angle-bracket terms are not flagged as placeholders", () => {
  const result = evaluatePackageQuality({
    sections: [
      { key: "headline", label: "헤드라인", kind: "text", value: "백엔드 엔지니어 5년차", source: "resume", required: true, minLength: 8 },
      {
        key: "summary",
        label: "경력 요약",
        kind: "text",
        value: "C++ STL <vector> 최적화와 React <Suspense> 도입으로 서비스 응답 속도를 40% 개선한 경험이 있습니다.",
        source: "resume",
        required: true,
        minLength: 30,
      },
    ],
  });
  assert.equal(result.findings.some((finding) => finding.key === "placeholder"), false);
  assert.equal(result.status, "passed");
});

test("hangul angle-bracket placeholders still block approval", () => {
  const result = evaluatePackageQuality({
    sections: [
      { key: "headline", label: "헤드라인", kind: "text", value: "백엔드 엔지니어 5년차", source: "resume", required: true, minLength: 8 },
      {
        key: "summary",
        label: "경력 요약",
        kind: "text",
        value: "<회사명>의 미션에 공감하여 지원했으며 실행 결과를 검토해 다음 개선으로 연결한 경험이 있습니다.",
        source: "resume",
        required: true,
        minLength: 30,
      },
    ],
  });
  assert.equal(result.findings.some((finding) => finding.key === "placeholder"), true);
  assert.equal(result.status, "review");
});
