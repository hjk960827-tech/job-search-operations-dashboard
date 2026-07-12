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
  createPackage,
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
    sources: [{ platform: "direct", url: "https://example.invalid/role", status: "active", confidence: 100 }],
  });
  saveResume(db, {
    headline: "문제를 구조화하고 실행을 연결하는 지원자",
    summary: "여러 이해관계자의 요구를 정리하고 우선순위를 합의한 뒤 실행 결과를 검토해 다음 개선으로 연결한 경험을 갖고 있습니다. 사실과 근거가 확인된 내용만 문서에 사용합니다.",
    skills: ["문제 구조화", "협업과 실행 관리"],
    experienceHighlights: [
      "복수 팀의 요구사항을 하나의 실행 목록으로 정리하고 담당자와 일정을 명확히 했습니다.",
      "완료 결과를 기준과 대조해 누락 항목을 찾고 다음 반복 작업에 반영했습니다.",
    ],
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

function completeContent() {
  return {
    headline: "문제를 구조화하고 실행을 연결하는 지원자",
    summary: "여러 이해관계자의 요구를 정리하고 우선순위를 합의한 뒤 실행 결과를 검토해 다음 개선으로 연결한 경험을 갖고 있습니다. 사실과 근거가 확인된 내용만 문서에 사용합니다.",
    skills: ["문제 구조화", "협업과 실행 관리"],
    experienceHighlights: [
      "복수 팀의 요구사항을 하나의 실행 목록으로 정리하고 담당자와 일정을 명확히 했습니다.",
      "완료 결과를 기준과 대조해 누락 항목을 찾고 다음 반복 작업에 반영했습니다.",
    ],
    motivation: "이 역할이 요구하는 문제 정의와 협업 방식이 제가 검증해 온 실행 경험과 맞닿아 있습니다. 공고에 적힌 책임 범위를 기준으로 실제 기여할 수 있는 부분을 구체적으로 확인하고 지원했습니다.",
    plan: "입사 후에는 현재 업무 흐름과 성공 기준을 먼저 확인하고, 작은 개선안을 실행해 결과를 측정하겠습니다. 확인된 결과를 바탕으로 다음 우선순위를 팀과 합의하겠습니다.",
  };
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
    const updated = updatePackage(value.db, packageValue.id, { ...completeContent(), expectedChecksum: packageValue.checksum });
    assert.equal(updated.state, "approval_pending");
    assert.equal(updated.quality.status, "passed");
    assert.equal(fs.existsSync(updated.artifacts.htmlPath), true);
    assert.equal(value.db.prepare("SELECT COUNT(*) AS count FROM package_revisions WHERE package_id = ?").get(packageValue.id).count, 1);
    assert.throws(
      () => updatePackage(value.db, packageValue.id, { plan: "stale edit", expectedChecksum: packageValue.checksum }),
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
      { ...completeContent(), expectedChecksum: packageValue.checksum },
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
    let updated = updatePackage(value.db, packageValue.id, { ...completeContent(), expectedChecksum: packageValue.checksum });
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
    let updated = updatePackage(value.db, packageValue.id, { ...completeContent(), expectedChecksum: packageValue.checksum });
    updated = await approvePackage(value.db, updated.id, { renderer: fakePdf(1) });
    const previousPdf = updated.artifacts.pdfPath;
    updated = updatePackage(value.db, updated.id, {
      plan: `${updated.content.plan}\n\n검토 결과를 문서로 남겨 팀이 같은 기준을 사용하도록 하겠습니다.`,
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
    let updated = updatePackage(value.db, packageValue.id, { ...completeContent(), expectedChecksum: packageValue.checksum });
    updated = await approvePackage(value.db, updated.id, { renderer: fakePdf(1) });
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
    assert.throws(() => updatePackage(value.db, updated.id, { plan: "late edit", expectedChecksum: updated.checksum }), /cannot be edited/);
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
      () => updatePackage(value.db, packageValue.id, { ...completeContent(), expectedChecksum: packageValue.checksum }),
      /outside the package data directory|must stay inside/,
    );
  } finally {
    value.cleanup(packageValue);
  }
});
