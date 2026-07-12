import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvePackage, createPackage, updatePackage } from "../lib/package-workflow.mjs";
import { importJob, initializeDatabase, openDatabase, saveResume } from "../lib/database.mjs";

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "job-search-pdf-smoke-"));
const dbPath = path.join(tempDirectory, "smoke.sqlite");
let db;
let packageValue;

try {
  initializeDatabase(dbPath, { mode: "personal" });
  db = openDatabase(dbPath);
  const jobId = importJob(db, {
    jobKey: "pdf-smoke-role",
    companyName: "Example Company",
    title: "Example Role",
    status: "active",
    sources: [{ platform: "direct", url: "https://example.invalid/smoke", status: "active", confidence: 100 }],
  });
  saveResume(db, {
    headline: "실행 과정을 구조화하는 지원자",
    summary: "요구사항과 성공 기준을 먼저 확인하고 실행 순서를 정리합니다. 완료 결과를 근거와 대조한 뒤 누락된 내용을 다음 개선 작업에 반영한 경험이 있습니다.",
    skills: ["문제 구조화", "협업과 실행 관리"],
    experienceHighlights: ["업무 기준과 담당자를 명확히 정리했습니다.", "완료 결과를 검토하고 개선 항목을 기록했습니다."],
  });
  packageValue = createPackage(db, jobId);
  packageValue = updatePackage(db, packageValue.id, {
    expectedChecksum: packageValue.checksum,
    motivation: "공고에 명시된 책임과 현재 팀의 목표를 기준으로 제가 검증해 온 실행 경험을 연결할 수 있다고 판단했습니다. 확인되지 않은 정보는 가정하지 않고 지원 문안을 작성했습니다.",
    plan: "입사 후 현재 업무 흐름과 성공 기준을 먼저 확인하겠습니다. 작은 개선안을 실행하고 결과를 측정한 뒤 다음 우선순위를 팀과 합의하겠습니다.",
  });
  packageValue = await approvePackage(db, packageValue.id);
  if (packageValue.state !== "approved" || !packageValue.artifacts.pdfPath || packageValue.artifacts.pdfPages < 1) {
    throw new Error("Chromium PDF approval smoke test did not produce a verified artifact");
  }
  console.log(`PDF smoke test passed: ${packageValue.artifacts.pdfPages} page(s), checksum ${packageValue.artifacts.pdfChecksum.slice(0, 12)}.`);
} finally {
  db?.close();
  if (packageValue?.artifacts?.directory) {
    fs.rmSync(path.dirname(path.dirname(packageValue.artifacts.directory)), { recursive: true, force: true });
  }
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
