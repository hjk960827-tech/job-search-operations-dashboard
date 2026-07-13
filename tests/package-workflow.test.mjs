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
  getLatestPackageForJob,
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

test("package update CAS failure rolls back revision rows, snapshots, and installed artifacts", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    const markdownBefore = fs.readFileSync(packageValue.artifacts.markdownPath, "utf8");
    const jsonBefore = fs.readFileSync(packageValue.artifacts.contentJsonPath, "utf8");
    assert.throws(() => updatePackage(
      value.db,
      packageValue.id,
      { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum },
      {
        beforeCommit: () => {
          value.db.prepare("UPDATE application_packages SET content_checksum = 'concurrent-writer' WHERE id = ?")
            .run(packageValue.id);
        },
      },
    ), (error) => error.statusCode === 409 && /changed during save/.test(error.message));
    const stored = value.db.prepare("SELECT content_checksum, state FROM application_packages WHERE id = ?").get(packageValue.id);
    assert.equal(stored.content_checksum, packageValue.checksum);
    assert.equal(stored.state, packageValue.state);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_revisions WHERE package_id = ?").get(packageValue.id).count, 0);
    assert.equal(fs.readFileSync(packageValue.artifacts.markdownPath, "utf8"), markdownBefore);
    assert.equal(fs.readFileSync(packageValue.artifacts.contentJsonPath, "utf8"), jsonBefore);
    assert.equal(fs.existsSync(path.join(packageValue.artifacts.directory, ".revisions")), false);
    assert.equal(fs.readdirSync(packageValue.artifacts.directory).some((name) => name.includes(".tmp-") || name.includes(".previous-")), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("package creation holds the writer lock before installing shared version artifacts", () => {
  const value = fixture();
  const secondDb = openDatabase(path.join(value.directory, "test.sqlite"));
  let packageValue;
  try {
    secondDb.exec("PRAGMA busy_timeout = 1");
    let competingError;
    packageValue = createPackage(value.db, value.jobId, {
      beforeInsert: () => {
        try {
          createPackage(secondDb, value.jobId);
        } catch (error) {
          competingError = error;
        }
      },
    });
    assert.match(String(competingError?.message || ""), /locked/i);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM application_packages WHERE job_id = ?").get(value.jobId).count, 1);
    assert.equal(secondDb.prepare("SELECT COUNT(*) AS count FROM application_packages WHERE job_id = ?").get(value.jobId).count, 1);
    assert.equal(fs.existsSync(packageValue.artifacts.contentJsonPath), true);
    assert.equal(fs.readdirSync(packageValue.artifacts.directory).some((name) => name.includes(".tmp-") || name.includes(".previous-")), false);
  } finally {
    secondDb.close();
    value.cleanup(packageValue);
  }
});

test("approval rejects four pages, accepts three pages, and rolls back on database failure", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let updated = updatePackage(value.db, packageValue.id, { sections: completeSections(packageValue), expectedChecksum: packageValue.checksum });
    await assert.rejects(() => approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(4) }), /must contain 1-3 pages/);
    assert.equal(fs.existsSync(path.join(updated.artifacts.directory, "resume.pdf")), false);
    await assert.rejects(() => approvePackage(value.db, updated.id, {
      expectedChecksum: updated.checksum,
      renderer: fakePdf(3),
      beforeCommit: () => { throw new Error("forced approval failure"); },
    }), /forced approval failure/);
    assert.equal(fs.existsSync(path.join(updated.artifacts.directory, "resume.pdf")), false);
    updated = await approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(3) });
    assert.equal(updated.state, "approved");
    assert.equal(updated.artifacts.pdfPages, 3);
  } finally {
    value.cleanup(packageValue);
  }
});

test("approval restores an existing PDF when staged installation fails after backup rename", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    const updated = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
    });
    const pdfPath = path.join(updated.artifacts.directory, "resume.pdf");
    const previousPdf = "%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n% previous artifact\n%%EOF\n";
    fs.writeFileSync(pdfPath, previousPdf, { encoding: "utf8", mode: 0o600 });
    await assert.rejects(() => approvePackage(value.db, updated.id, {
      expectedChecksum: updated.checksum,
      renderer: fakePdf(1),
      beforePdfInstall: ({ stagedPath }) => fs.rmSync(stagedPath, { force: true }),
    }), /ENOENT|no such file/i);
    assert.equal(fs.readFileSync(pdfPath, "utf8"), previousPdf);
    assert.equal(value.db.prepare("SELECT state FROM application_packages WHERE id = ?").get(updated.id).state, "approval_pending");
    assert.equal(fs.readdirSync(updated.artifacts.directory)
      .some((name) => name.includes(".staged-") || name.includes(".previous-") || name.includes(".approval-source-")), false);
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
    updated = await approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(1) });
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

test("saving unchanged approved content preserves its PDF, approval, and revision history", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let approved = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
    });
    approved = await approvePackage(value.db, approved.id, {
      expectedChecksum: approved.checksum,
      renderer: fakePdf(1),
    });
    const pdfPath = approved.artifacts.pdfPath;
    const pdfContents = fs.readFileSync(pdfPath);
    const revisionCount = value.db.prepare("SELECT COUNT(*) AS count FROM package_revisions WHERE package_id = ?").get(approved.id).count;
    const approvalCount = value.db.prepare("SELECT COUNT(*) AS count FROM package_approvals WHERE package_id = ?").get(approved.id).count;

    const unchanged = updatePackage(value.db, approved.id, {
      sections: completeSections(approved), expectedChecksum: approved.checksum,
    });

    assert.equal(unchanged.state, "approved");
    assert.equal(unchanged.checksum, approved.checksum);
    assert.equal(unchanged.approvedChecksum, approved.approvedChecksum);
    assert.equal(unchanged.artifacts.pdfPath, pdfPath);
    assert.deepEqual(fs.readFileSync(pdfPath), pdfContents);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_revisions WHERE package_id = ?").get(approved.id).count, revisionCount);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_approvals WHERE package_id = ?").get(approved.id).count, approvalCount);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_approvals WHERE package_id = ? AND action = 'invalidated'").get(approved.id).count, 0);
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
    updated = await approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(1) });
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

test("resolved placeholders in current values are not kept failing because originalValue still has the template", () => {
  const value = fixture();
  let packageValue;
  try {
    value.db.prepare("UPDATE resume_profile SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .run("[회사명]의 업무 기준을 확인한 뒤 검증된 경험만 연결해 작성할 예정이며, 원본 템플릿은 이력에 남깁니다.");
    packageValue = createPackage(value.db, value.jobId);
    const resolvedSummary = "지원 기업의 업무 기준을 확인한 뒤 검증된 경험만 연결해 작성했으며, 사실과 근거가 확인된 내용만 사용했습니다.";
    const updated = updatePackage(value.db, packageValue.id, {
      expectedChecksum: packageValue.checksum,
      sections: completeSections(packageValue, { summary: resolvedSummary }),
    });
    assert.match(updated.content.sections.find((section) => section.key === "summary").originalValue, /\[회사명\]/);
    assert.equal(updated.content.sections.find((section) => section.key === "summary").value, resolvedSummary);
    assert.equal(updated.quality.status, "passed");
    assert.equal(updated.quality.findings.some((finding) => finding.key === "placeholder"), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("technical angle-bracket notation is not mistaken for an unresolved placeholder", () => {
  for (const notation of ["std::vector<T>", "React <Suspense>"]) {
    const quality = evaluatePackageQuality({
      sections: [{
        key: "summary",
        label: "경력 요약",
        kind: "text",
        value: `${notation}를 활용해 다양한 직무의 요구사항을 안정적인 결과물로 구현했습니다.`,
        source: "resume",
        required: true,
        minLength: 20,
      }],
    });
    assert.equal(quality.status, "passed", notation);
    assert.equal(quality.findings.some((finding) => finding.key === "placeholder"), false, notation);
  }
});

test("named angle-bracket placeholders still block package approval", () => {
  for (const placeholder of ["<회사명/직무명>", "<Company Name>"]) {
    const quality = evaluatePackageQuality({
      sections: [{
        key: "summary",
        label: "경력 요약",
        kind: "text",
        value: `${placeholder}에 맞춰 검증된 경험과 업무 성과를 구체적으로 작성합니다.`,
        source: "resume",
        required: true,
        minLength: 20,
      }],
    });
    assert.equal(quality.status, "review", placeholder);
    assert.equal(quality.findings.some((finding) => finding.key === "placeholder"), true, placeholder);
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

test("approval uses a post-render checksum CAS and removes conflicted staged PDFs", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let updated = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue),
      expectedChecksum: packageValue.checksum,
    });
    let releaseRender;
    let signalStarted;
    const renderStarted = new Promise((resolve) => { signalStarted = resolve; });
    const renderReleased = new Promise((resolve) => { releaseRender = resolve; });
    const approval = approvePackage(value.db, updated.id, {
      expectedChecksum: updated.checksum,
      renderer: async (_htmlPath, outputPath) => {
        await fakePdf(1)(_htmlPath, outputPath);
        signalStarted();
        await renderReleased;
      },
    });
    await renderStarted;
    const revisedSummary = `${updated.content.sections.find((section) => section.key === "summary").value}\n\n동시 수정 충돌을 검증하는 새 문장입니다.`;
    updated = updatePackage(value.db, updated.id, {
      sections: completeSections(updated, { summary: revisedSummary }),
      expectedChecksum: updated.checksum,
    });
    releaseRender();
    await assert.rejects(approval, /changed while the PDF was rendering/);
    assert.equal(value.db.prepare("SELECT state FROM application_packages WHERE id = ?").get(updated.id).state, "approval_pending");
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_approvals WHERE package_id = ? AND action = 'approved'").get(updated.id).count, 0);
    assert.equal(fs.existsSync(path.join(updated.artifacts.directory, "resume.pdf")), false);
    assert.equal(fs.readdirSync(updated.artifacts.directory).some((name) => name.includes(".staged-")), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("approval requires the client checksum and renders a private immutable HTML snapshot from DB content", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    const updated = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue),
      expectedChecksum: packageValue.checksum,
    });
    let rendererCalled = false;
    await assert.rejects(() => approvePackage(value.db, updated.id, {
      renderer: async () => { rendererCalled = true; },
    }), /expectedChecksum is required/);
    assert.equal(rendererCalled, false);

    fs.writeFileSync(updated.artifacts.htmlPath, "<html><body>TAMPERED MUTABLE HTML</body></html>", "utf8");
    let approvalSourcePath = "";
    let approvalSource = "";
    const approved = await approvePackage(value.db, updated.id, {
      expectedChecksum: updated.checksum,
      renderer: async (htmlPath, outputPath) => {
        approvalSourcePath = htmlPath;
        approvalSource = fs.readFileSync(htmlPath, "utf8");
        if (process.platform !== "win32") assert.equal(fs.statSync(htmlPath).mode & 0o777, 0o600);
        await fakePdf(1)(htmlPath, outputPath);
      },
    });
    assert.equal(approved.state, "approved");
    assert.notEqual(approvalSourcePath, updated.artifacts.htmlPath);
    assert.doesNotMatch(approvalSource, /TAMPERED MUTABLE HTML/);
    assert.match(approvalSource, /여러 이해관계자의 요구/);
    assert.equal(fs.existsSync(approvalSourcePath), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("changed sources require confirmation and create an immutable v2 without rewriting v1", async () => {
  const value = fixture();
  let firstPackage;
  try {
    firstPackage = createPackage(value.db, value.jobId, { threshold: 80, maximumPages: 3 });
    let firstApproved = updatePackage(value.db, firstPackage.id, {
      sections: completeSections(firstPackage),
      expectedChecksum: firstPackage.checksum,
    }, { threshold: 80, maximumPages: 3 });
    firstApproved = await approvePackage(value.db, firstApproved.id, {
      expectedChecksum: firstApproved.checksum,
      threshold: 80,
      maximumPages: 3,
      renderer: fakePdf(1),
    });
    const firstPdfChecksum = firstApproved.artifacts.pdfChecksum;
    value.db.prepare("UPDATE resume_profile SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .run("업데이트된 기본 이력서 내용으로 새 문서 버전을 만들어야 합니다. 기존 승인본은 변경하지 않습니다.");

    const stale = getLatestPackageForJob(value.db, value.jobId, { threshold: 80, maximumPages: 3 });
    assert.equal(stale.version, 1);
    assert.equal(stale.refreshRequired, true);
    assert.deepEqual(stale.refreshReasons.map((reason) => reason.key), ["base_resume_changed"]);
    assert.equal(createPackage(value.db, value.jobId, { threshold: 80, maximumPages: 3 }).version, 1);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM application_packages WHERE job_id = ?").get(value.jobId).count, 1);

    const secondPackage = createPackage(value.db, value.jobId, {
      threshold: 80,
      maximumPages: 3,
      refreshConfirmed: true,
    });
    assert.equal(secondPackage.version, 2);
    assert.equal(secondPackage.supersedesPackageId, firstApproved.id);
    assert.equal(secondPackage.refreshRequired, false);
    const preserved = value.db.prepare("SELECT state, resume_pdf_checksum, approved_checksum FROM application_packages WHERE id = ?").get(firstApproved.id);
    assert.equal(preserved.state, "approved");
    assert.equal(preserved.resume_pdf_checksum, firstPdfChecksum);
    assert.equal(Boolean(preserved.approved_checksum), true);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_revisions WHERE package_id = ?").get(firstApproved.id).count, 1);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_approvals WHERE package_id = ? AND action = 'approved'").get(firstApproved.id).count, 1);
    assert.throws(() => updatePackage(value.db, firstApproved.id, {
      sections: completeSections(firstApproved),
      expectedChecksum: firstApproved.checksum,
    }), /Superseded package versions are immutable/);
  } finally {
    value.cleanup(firstPackage);
  }
});

test("job tailoring and quality-rule changes are reported as separate refresh reasons", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId, { threshold: 80, maximumPages: 3 });
    value.db.prepare("UPDATE job_tailoring SET focus_sections_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?")
      .run(JSON.stringify(["summary", "career_direction"]), value.jobId);
    const stale = getLatestPackageForJob(value.db, value.jobId, { threshold: 90, maximumPages: 3 });
    assert.deepEqual(stale.refreshReasons.map((reason) => reason.key), ["job_input_changed", "quality_rules_changed"]);
  } finally {
    value.cleanup(packageValue);
  }
});

test("submission preparation rejects stale fingerprints without creating a frozen artifact", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let approved = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
    });
    approved = await approvePackage(value.db, approved.id, {
      expectedChecksum: approved.checksum,
      renderer: fakePdf(1),
    });
    value.db.prepare("UPDATE resume_profile SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .run("제출 준비 전에 기본 이력서가 바뀌었으므로 새 버전 확인이 필요합니다.");
    assert.throws(() => prepareSubmission(value.db, approved.id), /Package inputs changed/);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_submissions WHERE package_id = ?").get(approved.id).count, 0);
    assert.equal(value.db.prepare("SELECT state FROM application_packages WHERE id = ?").get(approved.id).state, "approved");
    assert.equal(fs.existsSync(path.join(approved.artifacts.directory, "submissions")), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("submission preparation CAS failure rolls back its DB transition and frozen copy", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let approved = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
    });
    approved = await approvePackage(value.db, approved.id, {
      expectedChecksum: approved.checksum,
      renderer: fakePdf(1),
    });
    const checksumBefore = approved.artifacts.pdfChecksum;
    assert.throws(() => prepareSubmission(value.db, approved.id, {
      beforeCommit: () => {
        value.db.prepare("UPDATE application_packages SET resume_pdf_checksum = 'concurrent-writer' WHERE id = ?")
          .run(approved.id);
      },
    }), (error) => error.statusCode === 409 && /changed during submission preparation/.test(error.message));
    const stored = value.db.prepare("SELECT state, resume_pdf_checksum FROM application_packages WHERE id = ?").get(approved.id);
    assert.equal(stored.state, "approved");
    assert.equal(stored.resume_pdf_checksum, checksumBefore);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_submissions WHERE package_id = ?").get(approved.id).count, 0);
    assert.equal(fs.existsSync(path.join(approved.artifacts.directory, "submissions")), false);
    assert.equal(fs.readdirSync(approved.artifacts.directory).some((name) => name.includes(".tmp-")), false);
  } finally {
    value.cleanup(packageValue);
  }
});

test("package artifacts, revisions, PDFs, and frozen submissions use private permissions", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permission bits are not available on Windows");
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let updated = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue),
      expectedChecksum: packageValue.checksum,
    });
    updated = await approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(1) });
    updated = prepareSubmission(value.db, updated.id, { platform: "direct" });
    const submission = value.db.prepare("SELECT frozen_pdf_path FROM package_submissions WHERE package_id = ?").get(updated.id);
    const directories = [
      path.dirname(path.dirname(path.dirname(updated.artifacts.directory))),
      updated.artifacts.directory,
      path.join(updated.artifacts.directory, ".revisions"),
      path.join(updated.artifacts.directory, ".revisions", "revision-1"),
      path.dirname(submission.frozen_pdf_path),
    ];
    const files = [
      updated.artifacts.contentJsonPath,
      updated.artifacts.markdownPath,
      updated.artifacts.htmlPath,
      updated.artifacts.applicationAnswersPath,
      updated.artifacts.pdfPath,
      submission.frozen_pdf_path,
      path.join(updated.artifacts.directory, ".revisions", "revision-1", "content.json"),
    ];
    for (const directory of directories) assert.equal(fs.statSync(directory).mode & 0o777, 0o700, directory);
    for (const file of files) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
  } finally {
    value.cleanup(packageValue);
  }
});

test("all package actions enforce job eligibility and submission never downgrades interview status", async () => {
  const closedValue = fixture();
  try {
    closedValue.db.prepare("UPDATE jobs SET lifecycle_status = 'closed' WHERE id = ?").run(closedValue.jobId);
    assert.throws(() => createPackage(closedValue.db, closedValue.jobId), /Closed jobs cannot use application packages/);
  } finally {
    closedValue.cleanup();
  }

  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    value.db.prepare("INSERT INTO application_state (job_id, workflow_status) VALUES (?, 'skipped') ON CONFLICT(job_id) DO UPDATE SET workflow_status = 'skipped'").run(value.jobId);
    assert.throws(() => updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
    }), /Skipped jobs cannot use application packages/);
    value.db.prepare("UPDATE application_state SET workflow_status = 'new' WHERE job_id = ?").run(value.jobId);
    let updated = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
    });
    value.db.prepare("UPDATE application_state SET workflow_status = 'rejected' WHERE job_id = ?").run(value.jobId);
    await assert.rejects(() => approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(1) }), /Rejected jobs cannot use application packages/);
    value.db.prepare("UPDATE application_state SET workflow_status = 'new' WHERE job_id = ?").run(value.jobId);
    updated = await approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(1) });
    value.db.prepare("UPDATE jobs SET lifecycle_status = 'closed' WHERE id = ?").run(value.jobId);
    assert.throws(() => prepareSubmission(value.db, updated.id), /Closed jobs cannot use application packages/);
    value.db.prepare("UPDATE jobs SET lifecycle_status = 'active' WHERE id = ?").run(value.jobId);
    updated = prepareSubmission(value.db, updated.id);
    value.db.prepare("UPDATE application_state SET workflow_status = 'skipped' WHERE job_id = ?").run(value.jobId);
    assert.throws(() => recordSubmitted(value.db, updated.id), /Skipped jobs cannot use application packages/);
    value.db.prepare("UPDATE application_state SET workflow_status = 'rejected' WHERE job_id = ?").run(value.jobId);
    assert.throws(() => recordSubmitted(value.db, updated.id), /Rejected jobs cannot use application packages/);
    value.db.prepare("UPDATE application_state SET workflow_status = 'interview' WHERE job_id = ?").run(value.jobId);
    updated = recordSubmitted(value.db, updated.id);
    assert.equal(updated.state, "submitted");
    assert.equal(value.db.prepare("SELECT workflow_status FROM application_state WHERE job_id = ?").get(value.jobId).workflow_status, "interview");
  } finally {
    value.cleanup(packageValue);
  }
});

test("confirmed refresh preserves submitted versions and their frozen artifacts", async () => {
  const value = fixture();
  let firstPackage;
  try {
    firstPackage = createPackage(value.db, value.jobId);
    let submitted = updatePackage(value.db, firstPackage.id, {
      sections: completeSections(firstPackage), expectedChecksum: firstPackage.checksum,
    });
    submitted = await approvePackage(value.db, submitted.id, { expectedChecksum: submitted.checksum, renderer: fakePdf(1) });
    submitted = prepareSubmission(value.db, submitted.id);
    submitted = recordSubmitted(value.db, submitted.id);
    const frozenBefore = value.db.prepare("SELECT status, frozen_pdf_path, frozen_pdf_checksum FROM package_submissions WHERE package_id = ?").get(submitted.id);
    value.db.prepare("UPDATE resume_profile SET headline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .run("새 기준으로 갱신된 기본 이력서 헤드라인입니다");
    const refreshed = createPackage(value.db, value.jobId, { refreshConfirmed: true });
    assert.equal(refreshed.version, 2);
    const firstAfter = value.db.prepare("SELECT state, approved_checksum FROM application_packages WHERE id = ?").get(submitted.id);
    const frozenAfter = value.db.prepare("SELECT status, frozen_pdf_path, frozen_pdf_checksum FROM package_submissions WHERE package_id = ?").get(submitted.id);
    assert.equal(firstAfter.state, "submitted");
    assert.equal(Boolean(firstAfter.approved_checksum), true);
    assert.deepEqual(frozenAfter, frozenBefore);
    assert.equal(fs.existsSync(frozenAfter.frozen_pdf_path), true);
  } finally {
    value.cleanup(firstPackage);
  }
});

test("a submit-ready package cannot be marked submitted after a newer version exists", async () => {
  const value = fixture();
  let firstPackage;
  try {
    firstPackage = createPackage(value.db, value.jobId);
    let prepared = updatePackage(value.db, firstPackage.id, {
      sections: completeSections(firstPackage), expectedChecksum: firstPackage.checksum,
    });
    prepared = await approvePackage(value.db, prepared.id, {
      expectedChecksum: prepared.checksum,
      renderer: fakePdf(1),
    });
    prepared = prepareSubmission(value.db, prepared.id);
    value.db.prepare("UPDATE resume_profile SET headline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .run("새 제출 버전이 필요하도록 변경된 헤드라인입니다");
    const secondPackage = createPackage(value.db, value.jobId, { refreshConfirmed: true });
    assert.equal(secondPackage.version, 2);
    assert.throws(() => recordSubmitted(value.db, prepared.id), /Superseded package versions are immutable/);
    assert.equal(value.db.prepare("SELECT state FROM application_packages WHERE id = ?").get(prepared.id).state, "submit_ready");
    assert.equal(value.db.prepare("SELECT status FROM package_submissions WHERE package_id = ?").get(prepared.id).status, "submit_ready");
  } finally {
    value.cleanup(firstPackage);
  }
});

test("submission recording revalidates eligibility under the writer lock and rolls back a raced change", async () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    let prepared = updatePackage(value.db, packageValue.id, {
      sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
    });
    prepared = await approvePackage(value.db, prepared.id, {
      expectedChecksum: prepared.checksum,
      renderer: fakePdf(1),
    });
    prepared = prepareSubmission(value.db, prepared.id);
    assert.throws(() => recordSubmitted(value.db, prepared.id, {
      beforeCommit: () => value.db.prepare("UPDATE jobs SET lifecycle_status = 'closed' WHERE id = ?").run(value.jobId),
    }), (error) => error.statusCode === 409 && /Closed jobs/.test(error.message));
    assert.equal(value.db.prepare("SELECT lifecycle_status FROM jobs WHERE id = ?").get(value.jobId).lifecycle_status, "active");
    assert.equal(value.db.prepare("SELECT state FROM application_packages WHERE id = ?").get(prepared.id).state, "submit_ready");
    assert.equal(value.db.prepare("SELECT status FROM package_submissions WHERE package_id = ?").get(prepared.id).status, "submit_ready");
  } finally {
    value.cleanup(packageValue);
  }
});

test("submission records do not downgrade interview or offer workflow states", async () => {
  for (const workflowStatus of ["interview", "offer"]) {
    const value = fixture();
    let packageValue;
    try {
      packageValue = createPackage(value.db, value.jobId);
      let updated = updatePackage(value.db, packageValue.id, {
        sections: completeSections(packageValue), expectedChecksum: packageValue.checksum,
      });
      updated = await approvePackage(value.db, updated.id, { expectedChecksum: updated.checksum, renderer: fakePdf(1) });
      updated = prepareSubmission(value.db, updated.id);
      value.db.prepare(`INSERT INTO application_state (job_id, workflow_status) VALUES (?, ?)
                        ON CONFLICT(job_id) DO UPDATE SET workflow_status = excluded.workflow_status`)
        .run(value.jobId, workflowStatus);
      recordSubmitted(value.db, updated.id);
      assert.equal(
        value.db.prepare("SELECT workflow_status FROM application_state WHERE job_id = ?").get(value.jobId).workflow_status,
        workflowStatus,
      );
    } finally {
      value.cleanup(packageValue);
    }
  }
});

test("unreachable package states are no longer accepted by the schema", () => {
  const value = fixture();
  let packageValue;
  try {
    packageValue = createPackage(value.db, value.jobId);
    assert.throws(
      () => value.db.prepare("UPDATE application_packages SET state = 'approval_hold' WHERE id = ?").run(packageValue.id),
      /CHECK constraint failed|invalid application package state/,
    );
  } finally {
    value.cleanup(packageValue);
  }
});
