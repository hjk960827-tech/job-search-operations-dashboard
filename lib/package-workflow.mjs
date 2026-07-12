import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGE_DIR, packagePath } from "./paths.mjs";

const EDITABLE_STATES = new Set(["quality_hold", "approval_pending", "revision_requested", "approval_hold", "approved"]);
const SECTION_CATALOG = {
  headline: { label: "헤드라인", kind: "text", column: "headline", maximum: 300, minimum: 8 },
  summary: { label: "경력 요약", kind: "text", column: "summary", maximum: 5000, minimum: 30 },
  skills: { label: "핵심 기술·역량", kind: "list", column: "skills_json", maximumItems: 30, minimumItems: 2, minimumItemLength: 2 },
  experience_highlights: { label: "경력 하이라이트", kind: "list", column: "experience_highlights_json", maximumItems: 30, minimumItems: 1, minimumItemLength: 15 },
  achievement_evidence: { label: "성과 근거", kind: "text", column: "achievement_evidence", maximum: 6000, minimum: 20 },
  representative_experience: { label: "대표 경험", kind: "text", column: "representative_experience", maximum: 6000, minimum: 20 },
  direct_scope: { label: "직접 담당 범위", kind: "text", column: "direct_scope", maximum: 6000, minimum: 15 },
  collaboration_scope: { label: "협업 범위", kind: "text", column: "collaboration_scope", maximum: 6000, minimum: 15 },
  career_direction: { label: "직무 관점 / 일하는 방식", kind: "text", column: "career_direction", maximum: 6000, minimum: 20 },
};

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value, maximum = 8000) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, maximum);
}

function cleanLines(value, maximumItems = 30) {
  const input = Array.isArray(value) ? value : String(value || "").split("\n");
  return input.map((item) => cleanText(item, 1000)).filter(Boolean).slice(0, maximumItems);
}

export function normalizePackageContent(input = {}) {
  const legacySections = [
    ["headline", "헤드라인", "text", input.headline],
    ["summary", "경력 요약", "text", input.summary],
    ["skills", "핵심 기술·역량", "list", input.skills],
    ["experience_highlights", "경력 하이라이트", "list", input.experienceHighlights],
  ].filter(([, , , value]) => Array.isArray(value) ? value.length : cleanText(value));
  const sourceSections = Array.isArray(input.sections) ? input.sections : legacySections.map(([key, label, kind, value]) => ({
    key, label, kind, value, originalValue: value,
    source: "resume",
    reason: "이전 형식에서 변환된 항목", required: true,
  }));
  const seen = new Set();
  const sections = sourceSections.slice(0, 50).map((section) => {
    const key = cleanText(section?.key, 120);
    if (!key || seen.has(key)) return null;
    seen.add(key);
    const source = section?.source === "application_question" ? "application_question" : "resume";
    const definition = SECTION_CATALOG[key];
    const kind = section?.kind === "list" ? "list" : "text";
    const maximum = Math.max(100, Math.min(10000, Number(section?.maxLength || 6000)));
    const cleanValue = kind === "list" ? cleanLines(section?.value) : cleanText(section?.value, maximum);
    const originalValue = kind === "list" ? cleanLines(section?.originalValue) : cleanText(section?.originalValue, maximum);
    const defaultMinimum = source === "application_question" ? 40 : definition?.minimum || 20;
    const minimumLength = kind === "text"
      ? Math.max(1, Math.min(maximum, Number(section?.minLength ?? defaultMinimum)))
      : 0;
    const minimumItems = kind === "list"
      ? Math.max(1, Math.min(30, Number(section?.minItems ?? definition?.minimumItems ?? 1)))
      : 0;
    const minimumItemLength = kind === "list"
      ? Math.max(1, Math.min(1000, Number(section?.minItemLength ?? definition?.minimumItemLength ?? 2)))
      : 0;
    return {
      key,
      label: cleanText(section?.label, 300) || key,
      kind,
      value: cleanValue,
      originalValue,
      source,
      reason: cleanText(section?.reason, 1000),
      required: section?.required !== false,
      maxLength: maximum,
      minLength: minimumLength,
      minItems: minimumItems,
      minItemLength: minimumItemLength,
    };
  }).filter(Boolean);
  const protectedFacts = (Array.isArray(input.protectedFacts) ? input.protectedFacts : []).slice(0, 30).map((fact) => ({
    key: cleanText(fact?.key, 120),
    label: cleanText(fact?.label, 200),
    value: cleanText(fact?.value, 2000),
  })).filter((fact) => fact.key && fact.label && fact.value);
  return {
    sections,
    protectedFacts,
    selection: {
      focusSections: cleanLines(input.selection?.focusSections, 30),
      usedDefaultFocus: Boolean(input.selection?.usedDefaultFocus),
    },
  };
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function contentChecksum(content) {
  return crypto.createHash("sha256").update(JSON.stringify(normalizePackageContent(content))).digest("hex");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphs(value = "") {
  return cleanText(value).split(/\n\s*\n/).map((item) => item.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
}

export function renderPackageMarkdown(content, job = {}) {
  const normalized = normalizePackageContent(content);
  const headline = normalized.sections.find((section) => section.key === "headline")?.value || "맞춤 이력서";
  const lines = [
    `# ${headline}`,
    "",
    `> ${cleanText(job.companyName, 200)} · ${cleanText(job.title, 240)}`,
    "",
  ];
  if (normalized.protectedFacts.length) {
    lines.push("## 기본 정보", "", ...normalized.protectedFacts.map((fact) => `- **${fact.label}:** ${fact.value}`), "");
  }
  for (const section of normalized.sections.filter((item) => item.source === "resume" && item.key !== "headline")) {
    lines.push(`## ${section.label}`, "");
    if (section.kind === "list") lines.push(...section.value.map((item) => `- ${item}`));
    else lines.push(section.value);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderApplicationAnswersMarkdown(content, job = {}) {
  const normalized = normalizePackageContent(content);
  const questions = normalized.sections.filter((section) => section.source === "application_question");
  if (!questions.length) return "";
  const lines = [
    "# 지원서 별도 질문 답변",
    "",
    `> ${cleanText(job.companyName, 200)} · ${cleanText(job.title, 240)}`,
    "",
  ];
  for (const section of questions) {
    lines.push(`## ${section.label}`, "", cleanText(section.value), "");
  }
  return lines.join("\n");
}

export function renderPackageHtml(content, job = {}) {
  const normalized = normalizePackageContent(content);
  const headline = normalized.sections.find((section) => section.key === "headline")?.value || "맞춤 이력서";
  const list = (items) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const prose = (value) => paragraphs(value).map((item) => `<p>${escapeHtml(item)}</p>`).join("");
  const facts = normalized.protectedFacts.length
    ? `<section class="facts">${normalized.protectedFacts.map((fact) => `<span><strong>${escapeHtml(fact.label)}</strong> ${escapeHtml(fact.value)}</span>`).join("")}</section>`
    : "";
  const sections = normalized.sections.filter((section) => section.source === "resume" && section.key !== "headline").map((section) => (
    `<section><h2>${escapeHtml(section.label)}</h2>${section.kind === "list" ? `<ul>${list(section.value)}</ul>` : prose(section.value)}</section>`
  )).join("");
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(headline)}</title>
<style>
@page { size: A4; margin: 16mm 17mm; }
* { box-sizing: border-box; } body { margin: 0; color: #17231f; font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; font-size: 10.5pt; line-height: 1.55; }
h1 { margin: 0 0 4mm; font-size: 20pt; } h2 { margin: 7mm 0 2mm; padding-bottom: 1.5mm; border-bottom: 1px solid #b9c8c1; font-size: 12pt; }
.target { margin-bottom: 7mm; color: #52635c; } p { margin: 0 0 2.5mm; } ul { margin: 0; padding-left: 5mm; } li { margin-bottom: 1.5mm; }
.facts { display: flex; flex-wrap: wrap; gap: 2mm 5mm; padding: 3mm 0; border-top: 1px solid #d8e0dc; border-bottom: 1px solid #d8e0dc; color: #405149; }
.facts span { white-space: nowrap; } .facts strong { margin-right: 1.5mm; }
</style></head><body>
<h1>${escapeHtml(headline)}</h1>
<div class="target">${escapeHtml(job.companyName || "")} · ${escapeHtml(job.title || "")}</div>
${facts}${sections}
</body></html>`;
}

export function evaluatePackageQuality(content, { threshold = 80 } = {}) {
  const normalized = normalizePackageContent(content);
  const required = normalized.sections.filter((section) => section.required);
  const checks = required.map((section) => {
    const passed = section.kind === "list"
      ? section.value.length >= section.minItems && section.value.every((item) => cleanText(item).length >= section.minItemLength)
      : cleanText(section.value).length >= section.minLength;
    const requirement = section.kind === "list"
      ? `${section.minItems}개 이상, 각 ${section.minItemLength}자 이상`
      : `${section.minLength}자 이상`;
    return [section.key, passed, `${section.label} 항목을 ${requirement} 입력해 주세요.`];
  });
  const resumeBodySections = normalized.sections.filter((section) => section.source === "resume" && section.key !== "headline");
  const completed = checks.filter(([, passed]) => passed).length;
  const rawScore = normalized.sections.length ? (checks.length ? Math.round((completed / checks.length) * 100) : 100) : 0;
  const placeholderPattern = /(?:TODO|TBD|Lorem ipsum|\[수치\]|\[회사명\]|<[^>]{1,40}>)/i;
  const placeholder = placeholderPattern.test(JSON.stringify(normalized));
  const findings = checks.filter(([, passed]) => !passed).map(([key, , message]) => ({ key, message }));
  if (!normalized.sections.length) findings.push({ key: "sections", message: "기본 이력서에서 맞춤 수정할 항목을 먼저 등록해 주세요." });
  if (!resumeBodySections.length) findings.push({ key: "resume_sections", message: "지원서 질문과 별도로 이력서 본문 항목을 한 개 이상 등록해 주세요." });
  if (placeholder) findings.push({ key: "placeholder", message: "미확정 자리표시자 문구를 제거해 주세요." });
  const allRequiredComplete = checks.every(([, passed]) => passed);
  const score = resumeBodySections.length
    ? (allRequiredComplete ? rawScore : Math.min(rawScore, Math.max(0, threshold - 1)))
    : 0;
  const status = resumeBodySections.length && allRequiredComplete && score >= threshold && !placeholder ? "passed" : "review";
  return { status, score, threshold, findings };
}

function rowToPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    version: row.version,
    state: row.state,
    content: safeJson(row.content_json, {}),
    checksum: row.content_checksum,
    quality: {
      status: row.quality_status,
      score: row.quality_score,
      findings: safeJson(row.quality_findings_json, []),
    },
    artifacts: {
      directory: row.artifact_directory,
      contentJsonPath: row.content_json_path,
      markdownPath: row.resume_markdown_path,
      htmlPath: row.resume_html_path,
      applicationAnswersPath: row.application_answers_path,
      pdfPath: row.resume_pdf_path,
      pdfChecksum: row.resume_pdf_checksum,
      pdfPages: row.resume_pdf_pages,
    },
    approvedChecksum: row.approved_checksum,
    updatedAt: row.updated_at,
  };
}

function getPackageRow(db, packageId) {
  return db.prepare(`
    SELECT p.*, j.company_name, j.title, j.lifecycle_status,
           COALESCE(a.workflow_status, 'new') AS workflow_status,
           s.status AS submission_status, s.frozen_pdf_path, s.frozen_pdf_checksum, s.frozen_pdf_pages
    FROM application_packages p
    JOIN jobs j ON j.id = p.job_id
    LEFT JOIN application_state a ON a.job_id = j.id
    LEFT JOIN package_submissions s ON s.package_id = p.id
    WHERE p.id = ?
  `).get(packageId);
}

export function getLatestPackageForJob(db, jobId) {
  const row = db.prepare("SELECT * FROM application_packages WHERE job_id = ? ORDER BY version DESC LIMIT 1").get(jobId);
  return rowToPackage(row);
}

function databaseInstanceId(db) {
  const value = db.prepare("SELECT value FROM app_meta WHERE key = 'instance_id'").get()?.value;
  if (!/^[0-9a-f-]{36}$/i.test(String(value || ""))) throw new Error("Database instance identifier is missing");
  return value;
}

function artifactPaths(db, jobId, version) {
  const scope = `instance-${databaseInstanceId(db)}`;
  const directory = packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`);
  return {
    directory,
    json: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "content.json"),
    markdown: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "resume.md"),
    html: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "resume.html"),
    answers: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "application-answers.md"),
    pdf: packagePath(scope, `job-${Number(jobId)}`, `package-v${Number(version)}`, "resume.pdf"),
  };
}

function assertStoredPath(candidate, label) {
  if (!candidate) return "";
  const resolved = packagePath(path.relative(PACKAGE_DIR, path.resolve(candidate)));
  if (resolved !== path.resolve(candidate)) throw new Error(`${label} is outside the package data directory`);
  return resolved;
}

function artifactFiles(paths, content, job) {
  const files = [
    { path: paths.json, content: canonicalJson(normalizePackageContent(content)) },
    { path: paths.markdown, content: renderPackageMarkdown(content, job) },
    { path: paths.html, content: renderPackageHtml(content, job) },
  ];
  const answers = renderApplicationAnswersMarkdown(content, job);
  if (answers && paths.answers) files.push({ path: paths.answers, content: answers });
  return files;
}

function valueFromResume(resume, definition) {
  if (definition.kind === "list") return safeJson(resume[definition.column], []);
  return resume[definition.column] || "";
}

function protectedFactsFromResume(resume) {
  const hasCareerFact = Boolean(cleanText(resume.job_family) || cleanText(resume.job_role)
    || resume.years_experience !== null && resume.years_experience !== undefined);
  const career = resume.career_type === "experienced"
    ? `경력${resume.years_experience === null || resume.years_experience === undefined ? "" : ` · ${resume.years_experience}년`}`
    : "신입";
  return [
    { key: "job_family", label: "직무 분야", value: resume.job_family },
    { key: "job_role", label: "목표 직무", value: resume.job_role },
    { key: "career", label: "경력 구분", value: hasCareerFact ? career : "" },
    { key: "school", label: "학교", value: resume.school },
    { key: "major", label: "전공", value: resume.major },
    { key: "certificates", label: "자격·인증", value: safeJson(resume.certificates_json, []).join(", ") },
  ].filter((fact) => cleanText(fact.value));
}

export function buildPackageContent(resume = {}, tailoring = {}) {
  const allowed = new Set(safeJson(resume.editable_sections_json, Object.keys(SECTION_CATALOG)));
  const requested = safeJson(tailoring.focus_sections_json, []).filter((key) => Object.hasOwn(SECTION_CATALOG, key));
  const usedDefaultFocus = requested.length === 0;
  const focus = usedDefaultFocus ? Object.keys(SECTION_CATALOG) : requested;
  const sections = [];
  for (const key of focus) {
    const definition = SECTION_CATALOG[key];
    if (!definition || !allowed.has(key)) continue;
    const value = valueFromResume(resume, definition);
    const hasValue = definition.kind === "list" ? cleanLines(value).length : Boolean(cleanText(value));
    if (!hasValue) continue;
    sections.push({
      key,
      label: definition.label,
      kind: definition.kind,
      value,
      originalValue: value,
      source: "resume",
      reason: usedDefaultFocus ? "공고별 선택 정보가 없어 등록된 수정 허용 항목을 사용합니다." : "이 공고에서 중점 검토하도록 지정된 이력서 항목입니다.",
      required: true,
      maxLength: definition.maximum || 6000,
      minLength: definition.minimum || 0,
      minItems: definition.minimumItems || 0,
      minItemLength: definition.minimumItemLength || 0,
    });
  }
  const questions = safeJson(tailoring.application_questions_json, []);
  for (const [index, question] of questions.entries()) {
    const id = cleanText(question?.id, 80) || `question-${index + 1}`;
    const label = cleanText(question?.label || question?.question, 300);
    if (!label) continue;
    sections.push({
      key: `question:${id}`,
      label,
      kind: "text",
      value: "",
      originalValue: "",
      source: "application_question",
      reason: "채용 공고 또는 지원서에 별도 답변이 필요한 질문입니다.",
      required: question?.required !== false,
      maxLength: Math.max(100, Math.min(10000, Number(question?.maxLength || 2000))),
      minLength: Math.max(20, Math.min(1000, Number(question?.minLength || 40))),
    });
  }
  return normalizePackageContent({
    sections,
    protectedFacts: protectedFactsFromResume(resume),
    selection: { focusSections: requested, usedDefaultFocus },
  });
}

function installFilesAtomically(files) {
  const operationId = crypto.randomUUID();
  const staged = [];
  const installed = [];
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      const temp = `${file.path}.tmp-${operationId}`;
      fs.writeFileSync(temp, file.content, "utf8");
      staged.push({ ...file, temp, backup: `${file.path}.previous-${operationId}`, existed: fs.existsSync(file.path) });
    }
    for (const file of staged) {
      if (file.existed) fs.renameSync(file.path, file.backup);
      fs.renameSync(file.temp, file.path);
      installed.push(file);
    }
  } catch (error) {
    for (const file of [...staged].reverse()) {
      if (installed.includes(file)) fs.rmSync(file.path, { force: true });
      if (file.existed && fs.existsSync(file.backup)) {
        fs.rmSync(file.path, { force: true });
        fs.renameSync(file.backup, file.path);
      }
    }
    for (const file of staged) fs.rmSync(file.temp, { force: true });
    throw error;
  }
  return {
    rollback() {
      for (const file of [...staged].reverse()) {
        if (installed.includes(file)) fs.rmSync(file.path, { force: true });
        if (file.existed && fs.existsSync(file.backup)) {
          fs.rmSync(file.path, { force: true });
          fs.renameSync(file.backup, file.path);
        }
      }
    },
    cleanup() {
      for (const file of staged) {
        fs.rmSync(file.temp, { force: true });
        fs.rmSync(file.backup, { force: true });
      }
    },
  };
}

export function createPackage(db, jobId, { threshold = 80 } = {}) {
  const existing = getLatestPackageForJob(db, jobId);
  if (existing) return existing;
  const job = db.prepare("SELECT id, company_name AS companyName, title FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw new Error("Job not found");
  const resume = db.prepare("SELECT * FROM resume_profile WHERE id = 1").get() || {};
  const tailoring = db.prepare("SELECT * FROM job_tailoring WHERE job_id = ?").get(jobId) || {};
  const content = buildPackageContent(resume, tailoring);
  const checksum = contentChecksum(content);
  const quality = evaluatePackageQuality(content, { threshold });
  const state = quality.status === "passed" ? "approval_pending" : "quality_hold";
  const paths = artifactPaths(db, jobId, 1);
  const files = installFilesAtomically(artifactFiles(paths, content, job));
  try {
    db.prepare(`
      INSERT INTO application_packages (
        job_id, version, state, content_json, content_checksum, quality_status, quality_score,
        quality_findings_json, artifact_directory, content_json_path, resume_markdown_path, resume_html_path,
        application_answers_path
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, state, JSON.stringify(content), checksum, quality.status, quality.score,
      JSON.stringify(quality.findings), paths.directory, paths.json, paths.markdown, paths.html,
      content.sections.some((section) => section.source === "application_question") ? paths.answers : "");
    files.cleanup();
  } catch (error) {
    files.rollback();
    files.cleanup();
    throw error;
  }
  return getLatestPackageForJob(db, jobId);
}

function snapshotPackage(row, revisionNo) {
  const directory = packagePath(path.relative(
    PACKAGE_DIR,
    path.join(assertStoredPath(row.artifact_directory, "artifact directory"), ".revisions", `revision-${revisionNo}`),
  ));
  fs.mkdirSync(directory, { recursive: true });
  for (const candidate of [row.content_json_path, row.resume_markdown_path, row.resume_html_path, row.application_answers_path, row.resume_pdf_path]) {
    if (!candidate) continue;
    const source = assertStoredPath(candidate, "package artifact");
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(directory, path.basename(source)));
  }
  return directory;
}

export function updatePackage(db, packageId, input = {}, { threshold = 80, beforeCommit } = {}) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (!EDITABLE_STATES.has(row.state)) throw Object.assign(new Error("Prepared or submitted packages cannot be edited"), { statusCode: 409 });
  if (row.lifecycle_status === "closed" || row.workflow_status === "skipped") {
    throw Object.assign(new Error("Closed or skipped jobs cannot be edited"), { statusCode: 409 });
  }
  if (new Set(["submit_ready", "submitted"]).has(row.submission_status)) {
    throw Object.assign(new Error("Prepared or submitted packages cannot be edited"), { statusCode: 409 });
  }
  if (!input.expectedChecksum || input.expectedChecksum !== row.content_checksum) {
    throw Object.assign(new Error("The package changed in another session; reload before saving"), { statusCode: 409 });
  }
  const current = normalizePackageContent(safeJson(row.content_json, {}));
  const updates = new Map((Array.isArray(input.sections) ? input.sections : []).map((section) => [String(section?.key || ""), section?.value]));
  const next = normalizePackageContent({
    ...current,
    sections: current.sections.map((section) => updates.has(section.key) ? { ...section, value: updates.get(section.key) } : section),
  });
  const nextChecksum = contentChecksum(next);
  const quality = evaluatePackageQuality(next, { threshold });
  const nextState = quality.status === "passed" ? "approval_pending" : "quality_hold";
  const revisionNo = Number(db.prepare("SELECT COALESCE(MAX(revision_no), 0) + 1 AS value FROM package_revisions WHERE package_id = ?").get(packageId).value);
  const snapshotDirectory = snapshotPackage(row, revisionNo);
  const job = { companyName: row.company_name, title: row.title };
  const paths = {
    directory: assertStoredPath(row.artifact_directory, "artifact directory"),
    json: assertStoredPath(row.content_json_path, "content JSON"),
    markdown: assertStoredPath(row.resume_markdown_path, "resume Markdown"),
    html: assertStoredPath(row.resume_html_path, "resume HTML"),
    answers: row.application_answers_path
      ? assertStoredPath(row.application_answers_path, "application answers")
      : packagePath(path.relative(PACKAGE_DIR, path.join(row.artifact_directory, "application-answers.md"))),
  };
  const files = installFilesAtomically(artifactFiles(paths, next, job));
  const applicationAnswersPath = next.sections.some((section) => section.source === "application_question") ? paths.answers : "";
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO package_revisions (
        package_id, revision_no, previous_checksum, next_checksum, previous_content_json,
        next_content_json, snapshot_directory, quality_status, quality_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(packageId, revisionNo, row.content_checksum, nextChecksum, JSON.stringify(current), JSON.stringify(next),
      snapshotDirectory, quality.status, quality.score);
    if (row.approved_checksum || row.state === "approved") {
      db.prepare(`INSERT INTO package_approvals (package_id, action, package_checksum, note)
                  VALUES (?, 'invalidated', ?, 'Content changed after approval')`).run(packageId, row.approved_checksum || row.content_checksum);
    }
    db.prepare(`
      UPDATE application_packages SET state = ?, content_json = ?, content_checksum = ?, quality_status = ?,
        quality_score = ?, quality_findings_json = ?, resume_pdf_path = '', resume_pdf_checksum = '',
        resume_pdf_pages = 0, approved_checksum = '', application_answers_path = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(nextState, JSON.stringify(next), nextChecksum, quality.status, quality.score,
      JSON.stringify(quality.findings), applicationAnswersPath, packageId);
    if (beforeCommit) beforeCommit();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    files.rollback();
    files.cleanup();
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
  if (row.resume_pdf_path) {
    try { fs.rmSync(assertStoredPath(row.resume_pdf_path, "resume PDF"), { force: true }); } catch {}
  }
  files.cleanup();
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function pdfPageCount(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Generated artifact is not a PDF");
  const matches = buffer.toString("latin1").match(/\/Type\s*\/Page\b/g);
  return matches?.length || 0;
}

export async function renderHtmlPdf(htmlPath, outputPath) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

export async function approvePackage(db, packageId, { actorId = "local-user", note = "", maximumPages = 3, renderer = renderHtmlPdf, beforeCommit } = {}) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (row.state !== "approval_pending" || row.quality_status !== "passed") {
    throw Object.assign(new Error("Only a quality-passed package awaiting approval can be approved"), { statusCode: 409 });
  }
  const htmlPath = assertStoredPath(row.resume_html_path, "resume HTML");
  const pdfPath = packagePath(path.relative(PACKAGE_DIR, path.join(row.artifact_directory, "resume.pdf")));
  const stagedPath = `${pdfPath}.staged-${crypto.randomUUID()}`;
  let previousPath = "";
  try {
    await renderer(htmlPath, stagedPath);
    const pages = pdfPageCount(stagedPath);
    if (pages < 1 || pages > maximumPages) {
      throw Object.assign(new Error(`Resume PDF must contain 1-${maximumPages} pages (received ${pages})`), { statusCode: 409 });
    }
    const checksum = sha256File(stagedPath);
    if (fs.existsSync(pdfPath)) {
      previousPath = `${pdfPath}.previous-${crypto.randomUUID()}`;
      fs.renameSync(pdfPath, previousPath);
    }
    fs.renameSync(stagedPath, pdfPath);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(`UPDATE application_packages SET state = 'approved', resume_pdf_path = ?, resume_pdf_checksum = ?,
                  resume_pdf_pages = ?, approved_checksum = content_checksum, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(pdfPath, checksum, pages, packageId);
      db.prepare(`INSERT INTO package_approvals (package_id, action, package_checksum, actor_id, note)
                  VALUES (?, 'approved', ?, ?, ?)`)
        .run(packageId, row.content_checksum, cleanText(actorId, 120) || "local-user", cleanText(note, 1000));
      if (beforeCommit) beforeCommit();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      fs.rmSync(pdfPath, { force: true });
      if (previousPath && fs.existsSync(previousPath)) fs.renameSync(previousPath, pdfPath);
      throw error;
    }
    if (previousPath) {
      try { fs.rmSync(previousPath, { force: true }); } catch {}
    }
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    throw error;
  }
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

function verifiedPdf(filePath, checksum, pages) {
  const resolved = assertStoredPath(filePath, "resume PDF");
  if (!fs.existsSync(resolved)) throw new Error("Resume PDF is missing");
  const actualChecksum = sha256File(resolved);
  const actualPages = pdfPageCount(resolved);
  if (!checksum || actualChecksum !== checksum) throw new Error("Resume PDF checksum changed");
  if (!pages || actualPages !== Number(pages)) throw new Error("Resume PDF page count changed");
  return { path: resolved, checksum: actualChecksum, pages: actualPages };
}

export function prepareSubmission(db, packageId, { platform = "", beforeCommit } = {}) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (row.state !== "approved") throw Object.assign(new Error("Only approved packages can be prepared"), { statusCode: 409 });
  if (row.approved_checksum !== row.content_checksum) throw new Error("Approved content checksum does not match current content");
  const pdf = verifiedPdf(row.resume_pdf_path, row.resume_pdf_checksum, row.resume_pdf_pages);
  const frozenPath = packagePath(path.relative(PACKAGE_DIR, path.join(row.artifact_directory, "submissions", `resume-${pdf.checksum.slice(0, 16)}.pdf`)));
  fs.mkdirSync(path.dirname(frozenPath), { recursive: true });
  const stagedPath = `${frozenPath}.tmp-${crypto.randomUUID()}`;
  fs.copyFileSync(pdf.path, stagedPath);
  if (sha256File(stagedPath) !== pdf.checksum) {
    fs.rmSync(stagedPath, { force: true });
    throw new Error("Frozen submission copy failed checksum verification");
  }
  const createdFrozen = !fs.existsSync(frozenPath);
  if (createdFrozen) fs.renameSync(stagedPath, frozenPath);
  else fs.rmSync(stagedPath, { force: true });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO package_submissions (package_id, status, platform, frozen_pdf_path, frozen_pdf_checksum, frozen_pdf_pages)
      VALUES (?, 'submit_ready', ?, ?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET status = 'submit_ready', platform = excluded.platform,
        frozen_pdf_path = excluded.frozen_pdf_path, frozen_pdf_checksum = excluded.frozen_pdf_checksum,
        frozen_pdf_pages = excluded.frozen_pdf_pages, submitted_at = NULL, updated_at = CURRENT_TIMESTAMP
    `).run(packageId, cleanText(platform, 80), frozenPath, pdf.checksum, pdf.pages);
    db.prepare("UPDATE application_packages SET state = 'submit_ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(packageId);
    if (beforeCommit) beforeCommit();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    if (createdFrozen) {
      fs.rmSync(frozenPath, { force: true });
      try { fs.rmdirSync(path.dirname(frozenPath)); } catch {}
    }
    throw error;
  }
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

export function recordSubmitted(db, packageId) {
  const row = getPackageRow(db, packageId);
  if (!row) throw Object.assign(new Error("Package not found"), { statusCode: 404 });
  if (row.state !== "submit_ready" || row.submission_status !== "submit_ready") {
    throw Object.assign(new Error("Package is not ready for submission"), { statusCode: 409 });
  }
  verifiedPdf(row.frozen_pdf_path, row.frozen_pdf_checksum, row.frozen_pdf_pages);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE package_submissions SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE package_id = ?").run(packageId);
    db.prepare("UPDATE application_packages SET state = 'submitted', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(packageId);
    db.prepare(`INSERT INTO application_state (job_id, workflow_status) VALUES (?, 'applied')
                ON CONFLICT(job_id) DO UPDATE SET workflow_status = 'applied', updated_at = CURRENT_TIMESTAMP`).run(row.job_id);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return rowToPackage(db.prepare("SELECT * FROM application_packages WHERE id = ?").get(packageId));
}

export function publicPackage(value) {
  if (!value) return null;
  return {
    id: value.id,
    version: value.version,
    state: value.state,
    content: value.content,
    checksum: value.checksum,
    quality: value.quality,
    pdf: value.artifacts?.pdfPath ? {
      available: true,
      fileName: path.basename(value.artifacts.pdfPath),
      checksum: value.artifacts.pdfChecksum,
      pages: value.artifacts.pdfPages,
    } : { available: false },
    applicationAnswers: value.artifacts?.applicationAnswersPath ? {
      available: true,
      fileName: path.basename(value.artifacts.applicationAnswersPath),
    } : { available: false },
    approvedChecksum: value.approvedChecksum,
    updatedAt: value.updatedAt,
  };
}
