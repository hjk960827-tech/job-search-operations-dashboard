import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { approvePackage, createPackage } from "../lib/package-workflow.mjs";
import { importJob, initializeDatabase, openDatabase, saveResume } from "../lib/database.mjs";
import { saveStructuredResumeItems } from "../lib/structured-records.mjs";

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
  saveStructuredResumeItems(db, [{
    id: "synthetic-project", kind: "project", title: "검증 절차 개선", role: "Contributor",
    summary: "완료 기준과 검토 결과를 같은 기록에서 확인할 수 있도록 정리했습니다.",
    highlights: ["누락 항목을 다음 작업 기준에 반영했습니다."], skills: ["품질 점검"],
  }]);
  const contactValue = ["candidate", "example.invalid"].join("@");
  packageValue = createPackage(db, jobId, { contact: [{ key: "email", label: "이메일", value: contactValue }] });
  const sourceHtml = fs.readFileSync(packageValue.artifacts.htmlPath, "utf8");
  if (!sourceHtml.includes(contactValue) || !sourceHtml.includes("검증 절차 개선")) {
    throw new Error("Final PDF source omitted selected contact or structured content");
  }
  packageValue = await approvePackage(db, packageValue.id, {
    expectedChecksum: packageValue.checksum,
    contact: [{ key: "email", label: "이메일", value: contactValue }],
  });
  if (packageValue.state !== "approved" || !packageValue.artifacts.pdfPath || packageValue.artifacts.pdfPages < 1) {
    throw new Error("Chromium PDF approval smoke test did not produce a verified artifact");
  }
  const actualChecksum = crypto.createHash("sha256").update(fs.readFileSync(packageValue.artifacts.pdfPath)).digest("hex");
  if (actualChecksum !== packageValue.artifacts.pdfChecksum) throw new Error("Final PDF checksum does not match the stored checksum");
  console.log(`PDF smoke test passed: ${packageValue.artifacts.pdfPages} page(s), checksum ${packageValue.artifacts.pdfChecksum.slice(0, 12)}.`);
} finally {
  db?.close();
  if (packageValue?.artifacts?.directory) {
    fs.rmSync(path.dirname(path.dirname(packageValue.artifacts.directory)), { recursive: true, force: true });
  }
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
